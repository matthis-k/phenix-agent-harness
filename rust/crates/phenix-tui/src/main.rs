mod acp_config;

use acp_config::load_acp_backend;
use clap::Parser;
use phenix_acp_backend::AcpAgentBackend;
use phenix_frontend_config::FrontendProviderRef;
use phenix_runtime_api::{
    AgentBackend, BackendCommand, BackendOutput, BackendReply, BackendRuntime, ClientInformation,
    RequestId,
};
use phenix_tui::RatatuiRenderer;
use phenix_ui_core::{
    AppState, KeyCode, KeyInput, KeyModifiers, MouseAction, MouseButton, MouseInput, UiInput,
};
use phenix_ui_lua::{AcpApplicationConfig, LuaFrontendOptions, LuaFrontendProvider};
use phenix_ui_runtime::{UiIngressError, UiRuntime};
use ratatui::crossterm::{
    event::{
        self, Event, KeyCode as CrosstermKeyCode, KeyEvent, KeyEventKind,
        KeyModifiers as CrosstermModifiers, KeyboardEnhancementFlags,
        MouseButton as CrosstermMouseButton, MouseEvent, MouseEventKind,
        PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::supports_keyboard_enhancement,
};
use std::cell::RefCell;
use std::env;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const CHANNEL_CAPACITY: usize = 1_024;
const INPUT_POLL_PERIOD: Duration = Duration::from_millis(100);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

struct KeyboardEnhancementGuard {
    enabled: bool,
}

impl KeyboardEnhancementGuard {
    fn activate() -> io::Result<Self> {
        // Modified Enter is indistinguishable from plain Enter in the legacy terminal
        // encoding. Ask compatible terminals for unambiguous CSI-u modified-key events.
        // A failed/unsupported capability query is not fatal: the TUI remains usable,
        // just without modifier information that the terminal cannot provide.
        let enabled = supports_keyboard_enhancement().unwrap_or(false);
        if enabled {
            let mut output = io::stdout();
            execute!(
                output,
                PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
            )?;
        }
        Ok(Self { enabled })
    }
}

impl Drop for KeyboardEnhancementGuard {
    fn drop(&mut self) {
        if self.enabled {
            let mut output = io::stdout();
            let _ = execute!(output, PopKeyboardEnhancementFlags);
        }
    }
}

#[derive(Debug, Parser)]
#[command(
    name = "phenix",
    version,
    about = "Native Phenix frontend",
    args_override_self = true
)]
struct Arguments {
    /// Read frontend Lua and ACP source descriptors from this configuration directory.
    #[arg(short = 'c', long = "config", value_name = "DIR")]
    config: Option<PathBuf>,

    /// Do not load the built-in frontend keymap and theme defaults.
    #[arg(long)]
    no_default_config: bool,

    /// Verify the configured backend runtime handshake without opening the terminal UI.
    #[arg(long)]
    check: bool,

    /// Print the built-in Lua frontend configuration and exit.
    #[arg(long)]
    print_default_config: bool,
}

fn main() -> Result<(), Box<dyn Error>> {
    let arguments = Arguments::parse();
    if arguments.print_default_config {
        print!("{}", LuaFrontendProvider::default_source());
        return Ok(());
    }

    let config_directory = resolve_config_directory(arguments.config.as_deref()).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "cannot resolve the Phenix Harness configuration directory; set XDG_CONFIG_HOME or HOME, or pass -c/--config",
        )
    })?;
    let (provider, acp_config) = load_frontend_provider(&arguments, &config_directory)?;
    if arguments.check {
        return run_handshake_check(&config_directory, acp_config.as_ref());
    }
    run_tui(provider, &config_directory, acp_config.as_ref())
}

fn load_frontend_provider(
    arguments: &Arguments,
    config_directory: &Path,
) -> Result<(FrontendProviderRef, Option<AcpApplicationConfig>), Box<dyn Error>> {
    let provider = LuaFrontendProvider::new(LuaFrontendOptions {
        source_path: Some(config_entrypoint(config_directory)),
        load_defaults: !arguments.no_default_config,
    })?;
    let acp_config = provider.acp_config().cloned();
    Ok((Rc::new(RefCell::new(provider)), acp_config))
}

fn config_entrypoint(config_directory: &Path) -> PathBuf {
    config_directory.join("init.lua")
}

fn resolve_config_directory(explicit_path: Option<&Path>) -> Option<PathBuf> {
    explicit_path
        .map(Path::to_path_buf)
        .or_else(default_config_directory)
}

fn default_config_directory() -> Option<PathBuf> {
    if let Some(root) = env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(root).join("phenix-harness"));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config/phenix-harness"))
}

fn run_tui(
    provider: FrontendProviderRef,
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<(), Box<dyn Error>> {
    let backend = spawn_backend(config_directory, acp_config)?;
    backend.client.submit(BackendCommand::Initialize {
        client: client_information(),
    })?;

    let renderer = RatatuiRenderer::initialize(Rc::clone(&provider))?;
    let _keyboard_enhancement = KeyboardEnhancementGuard::activate()?;
    let mut runtime = UiRuntime::from_backend_with_frontend(
        AppState::default(),
        backend,
        renderer,
        provider,
        CHANNEL_CAPACITY,
    )?;
    let mailbox = runtime.mailbox();
    let external_io_pause = Arc::new(AtomicBool::new(false));
    runtime.set_external_io_pause(Arc::clone(&external_io_pause));
    let _ticker = runtime.spawn_ticker(Duration::from_millis(250))?;
    let _input_thread = spawn_terminal_input(mailbox, external_io_pause)?;
    runtime.run()?;
    Ok(())
}

fn run_handshake_check(
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<(), Box<dyn Error>> {
    let backend = spawn_backend(config_directory, acp_config)?;
    let initialize_id = backend.client.submit(BackendCommand::Initialize {
        client: client_information(),
    })?;
    let reply = receive_reply(&backend.outputs, &initialize_id)?;
    if !matches!(reply, BackendReply::Initialized { .. }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected initialize reply: {reply:?}"),
        )
        .into());
    }

    let shutdown_id = backend.client.submit(BackendCommand::Shutdown)?;
    let reply = receive_reply(&backend.outputs, &shutdown_id)?;
    if reply != BackendReply::Completed {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unexpected shutdown reply: {reply:?}"),
        )
        .into());
    }
    backend.join()?;
    println!("phenix: runtime handshake succeeded");
    Ok(())
}

fn receive_reply(
    outputs: &Receiver<BackendOutput>,
    expected: &RequestId,
) -> Result<BackendReply, Box<dyn Error>> {
    loop {
        match outputs.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(BackendOutput::Reply { request_id, result }) if &request_id == expected => {
                return Ok(result?)
            }
            Ok(BackendOutput::Stopped { result }) => {
                result?;
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    format!("runtime stopped before replying to {expected}"),
                )
                .into());
            }
            Ok(BackendOutput::Reply { .. } | BackendOutput::Event(_)) => {}
            Err(RecvTimeoutError::Timeout) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("runtime did not reply to {expected} within 30 seconds"),
                )
                .into())
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "runtime output channel disconnected",
                )
                .into())
            }
        }
    }
}

fn spawn_backend(
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<BackendRuntime, Box<dyn Error>> {
    let backend: Box<dyn AgentBackend> =
        Box::new(create_acp_backend(config_directory, acp_config)?);
    Ok(BackendRuntime::spawn(backend, CHANNEL_CAPACITY)?)
}

fn create_acp_backend(
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<AcpAgentBackend, Box<dyn Error>> {
    let acp_config = acp_config.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} must call phenix.acp.configure(...) and register workflow/routing source descriptors",
                config_entrypoint(config_directory).display()
            ),
        )
    })?;
    Ok(load_acp_backend(
        config_directory,
        acp_config,
        &env::current_dir()?,
        CHANNEL_CAPACITY,
    )?)
}

fn client_information() -> ClientInformation {
    ClientInformation {
        name: "phenix-tui".to_owned(),
        build: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

fn spawn_terminal_input(
    mailbox: phenix_ui_runtime::UiMailbox,
    external_io_pause: Arc<AtomicBool>,
) -> Result<thread::JoinHandle<()>, Box<dyn Error>> {
    Ok(thread::Builder::new()
        .name("phenix-terminal-input".to_owned())
        .spawn(move || loop {
            if external_io_pause.load(Ordering::Acquire) {
                thread::sleep(INPUT_POLL_PERIOD);
                continue;
            }
            match event::poll(INPUT_POLL_PERIOD) {
                Ok(false) => continue,
                Ok(true) => {}
                Err(_) => {
                    thread::sleep(INPUT_POLL_PERIOD);
                    continue;
                }
            }
            let event = match event::read() {
                Ok(event) => event,
                Err(_) => {
                    thread::sleep(INPUT_POLL_PERIOD);
                    continue;
                }
            };
            let Some(input) = convert_event(event) else {
                continue;
            };
            match mailbox.send_input(input) {
                Ok(()) => {}
                Err(UiIngressError::Disconnected) => return,
                Err(UiIngressError::Coalesced) => unreachable!("terminal input is lossless"),
            }
        })?)
}

fn convert_event(event: Event) -> Option<UiInput> {
    match event {
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            Some(UiInput::Key(convert_key(key)))
        }
        Event::Paste(text) => Some(UiInput::Paste(text)),
        Event::Resize(width, height) => Some(UiInput::Resize { width, height }),
        Event::Mouse(mouse) => Some(UiInput::Mouse(convert_mouse(mouse))),
        Event::FocusGained => Some(UiInput::FocusGained),
        Event::FocusLost => Some(UiInput::FocusLost),
        Event::Key(_) => None,
    }
}

fn convert_key(key: KeyEvent) -> KeyInput {
    KeyInput {
        code: match key.code {
            CrosstermKeyCode::Backspace => KeyCode::Backspace,
            CrosstermKeyCode::Enter => KeyCode::Enter,
            CrosstermKeyCode::Left => KeyCode::Left,
            CrosstermKeyCode::Right => KeyCode::Right,
            CrosstermKeyCode::Up => KeyCode::Up,
            CrosstermKeyCode::Down => KeyCode::Down,
            CrosstermKeyCode::Home => KeyCode::Home,
            CrosstermKeyCode::End => KeyCode::End,
            CrosstermKeyCode::PageUp => KeyCode::PageUp,
            CrosstermKeyCode::PageDown => KeyCode::PageDown,
            CrosstermKeyCode::Tab => KeyCode::Tab,
            CrosstermKeyCode::BackTab => KeyCode::BackTab,
            CrosstermKeyCode::Delete => KeyCode::Delete,
            CrosstermKeyCode::Insert => KeyCode::Insert,
            CrosstermKeyCode::F(number) => KeyCode::Function(number),
            CrosstermKeyCode::Char(character) => KeyCode::Character(character),
            CrosstermKeyCode::Esc => KeyCode::Escape,
            CrosstermKeyCode::Null
            | CrosstermKeyCode::CapsLock
            | CrosstermKeyCode::ScrollLock
            | CrosstermKeyCode::NumLock
            | CrosstermKeyCode::PrintScreen
            | CrosstermKeyCode::Pause
            | CrosstermKeyCode::Menu
            | CrosstermKeyCode::KeypadBegin
            | CrosstermKeyCode::Media(_)
            | CrosstermKeyCode::Modifier(_) => KeyCode::Character('\0'),
        },
        modifiers: convert_modifiers(key.modifiers),
        repeat: key.kind == KeyEventKind::Repeat,
    }
}

fn convert_mouse(mouse: MouseEvent) -> MouseInput {
    MouseInput {
        column: mouse.column,
        row: mouse.row,
        action: match mouse.kind {
            MouseEventKind::Down(button) => MouseAction::Press(convert_mouse_button(button)),
            MouseEventKind::Up(button) => MouseAction::Release(convert_mouse_button(button)),
            MouseEventKind::Drag(button) => MouseAction::Drag(convert_mouse_button(button)),
            MouseEventKind::Moved => MouseAction::Move,
            MouseEventKind::ScrollDown | MouseEventKind::ScrollRight => MouseAction::ScrollDown,
            MouseEventKind::ScrollUp | MouseEventKind::ScrollLeft => MouseAction::ScrollUp,
        },
        modifiers: convert_modifiers(mouse.modifiers),
    }
}

fn convert_mouse_button(button: CrosstermMouseButton) -> MouseButton {
    match button {
        CrosstermMouseButton::Left => MouseButton::Left,
        CrosstermMouseButton::Right => MouseButton::Right,
        CrosstermMouseButton::Middle => MouseButton::Middle,
    }
}

fn convert_modifiers(modifiers: CrosstermModifiers) -> KeyModifiers {
    KeyModifiers {
        control: modifiers.contains(CrosstermModifiers::CONTROL),
        alt: modifiers.contains(CrosstermModifiers::ALT),
        shift: modifiers.contains(CrosstermModifiers::SHIFT),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_config_directory_is_authoritative() {
        let config = Path::new("/nix/store/aaaaaaaa-phenix-config");
        assert_eq!(
            resolve_config_directory(Some(config)).as_deref(),
            Some(config)
        );
        assert_eq!(
            config_entrypoint(config),
            Path::new("/nix/store/aaaaaaaa-phenix-config/init.lua")
        );
    }

    #[test]
    fn config_flag_accepts_store_directory() {
        let arguments = Arguments::try_parse_from([
            "phenix",
            "--config",
            "/nix/store/aaaaaaaa-phenix-config",
        ])
        .expect("config directory should parse");
        assert_eq!(
            arguments.config.as_deref(),
            Some(Path::new("/nix/store/aaaaaaaa-phenix-config"))
        );
    }

    #[test]
    fn crossterm_keys_are_reduced_to_backend_neutral_values() {
        let key = convert_key(KeyEvent::new(
            CrosstermKeyCode::Char('x'),
            CrosstermModifiers::CONTROL | CrosstermModifiers::SHIFT,
        ));
        assert_eq!(key.code, KeyCode::Character('x'));
        assert!(key.modifiers.control);
        assert!(key.modifiers.shift);
    }

    #[test]
    fn modified_enter_preserves_shift_for_multiline_input() {
        let key = convert_key(KeyEvent::new(
            CrosstermKeyCode::Enter,
            CrosstermModifiers::SHIFT,
        ));
        assert_eq!(key.code, KeyCode::Enter);
        assert!(key.modifiers.shift);
        assert!(!key.modifiers.control);
    }
}
