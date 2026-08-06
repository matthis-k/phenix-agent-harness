mod acp_config;

use acp_config::load_acp_backend;
use clap::Parser;
use phenix_acp_backend::GatewayAgentBackend;
use phenix_frontend_config::FrontendProviderRef;
use phenix_process_backend::{ProcessAgentBackend, ProcessBackendConfig};
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
use ratatui::crossterm::event::{
    self, Event, KeyCode as CrosstermKeyCode, KeyEvent, KeyEventKind,
    KeyModifiers as CrosstermModifiers, MouseButton as CrosstermMouseButton, MouseEvent,
    MouseEventKind,
};
use std::cell::RefCell;
use std::collections::BTreeMap;
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BackendKind {
    Process,
    Acp,
}

#[derive(Debug, Parser)]
#[command(
    name = "phenix",
    version,
    about = "Native Phenix frontend",
    args_override_self = true
)]
struct Arguments {
    /// Read config.lua and referenced definitions from this Phenix Harness directory.
    #[arg(short = 'p', long = "config-dir", value_name = "DIR")]
    config_dir: Option<PathBuf>,

    /// Do not load the built-in frontend keymaps, theme, and layout defaults.
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

    let config_directory = resolve_config_directory(arguments.config_dir.as_deref())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cannot resolve the Phenix Harness configuration directory; set XDG_CONFIG_HOME or HOME, or pass -p/--config-dir"))?;
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
        source_path: Some(config_directory.join("config.lua")),
        load_defaults: !arguments.no_default_config,
    })?;
    let acp_config = provider.acp_config().cloned();
    Ok((Rc::new(RefCell::new(provider)), acp_config))
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
        match parse_backend_kind(env::var("PHENIX_BACKEND").ok().as_deref())? {
            BackendKind::Process => Box::new(create_process_backend()?),
            BackendKind::Acp => Box::new(create_acp_backend(config_directory, acp_config)?),
        };
    Ok(BackendRuntime::spawn(backend, CHANNEL_CAPACITY)?)
}

fn parse_backend_kind(value: Option<&str>) -> Result<BackendKind, io::Error> {
    match value.map(str::trim) {
        None | Some("") | Some("acp") => Ok(BackendKind::Acp),
        Some("process") => Ok(BackendKind::Process),
        Some(value) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("unsupported PHENIX_BACKEND value: {value}"),
        )),
    }
}

fn create_acp_backend(
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<GatewayAgentBackend, Box<dyn Error>> {
    let acp_config = acp_config.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} must call phenix.acp.configure(...) and register workflow/routing definitions",
                config_directory.join("config.lua").display()
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

fn create_process_backend() -> Result<ProcessAgentBackend, Box<dyn Error>> {
    let program = env::var_os("PHENIX_HEADLESS_PROGRAM")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"));
    let entry = env::var("PHENIX_HEADLESS_ENTRY").map_err(|_| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "PHENIX_HEADLESS_ENTRY is not set; use the packaged `phenix` command or point it to headless/main.ts",
        )
    })?;
    let mut config = ProcessBackendConfig::new(program);
    config.arguments = vec!["--experimental-strip-types".to_owned(), entry];
    config.cwd = env::current_dir().ok();
    config.environment = inherited_headless_environment();
    Ok(ProcessAgentBackend::new(config)?)
}

fn inherited_headless_environment() -> BTreeMap<String, String> {
    [
        "HOME",
        "PATH",
        "TERM",
        "COLORTERM",
        "LANG",
        "LC_ALL",
        "PI_CODING_AGENT_DIR",
        "PI_SKIP_VERSION_CHECK",
        "PI_TELEMETRY",
        "PHENIX_SOURCE_ROOT",
        "PHENIX_ROOT",
        "PHENIX_DEV",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
    ]
    .into_iter()
    .filter_map(|key| env::var(key).ok().map(|value| (key.to_owned(), value)))
    .collect()
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
                    let _ = mailbox.shutdown();
                    return;
                }
            }
            let event = match event::read() {
                Ok(event) => event,
                Err(_) => {
                    let _ = mailbox.shutdown();
                    return;
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
    fn xdg_config_uses_the_phenix_harness_application_directory() {
        let path = PathBuf::from("/tmp/xdg-config").join("phenix-harness");
        assert_eq!(path, PathBuf::from("/tmp/xdg-config/phenix-harness"));
        assert_eq!(
            path.join("config.lua"),
            PathBuf::from("/tmp/xdg-config/phenix-harness/config.lua")
        );
    }

    #[test]
    fn headless_environment_overrides_exclude_unrelated_values() {
        let environment = inherited_headless_environment();
        assert!(!environment.contains_key("GITHUB_TOKEN"));
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
    fn backend_selection_defaults_to_acp_and_keeps_process_fallback_explicit() {
        assert_eq!(parse_backend_kind(None).expect("default"), BackendKind::Acp);
        assert_eq!(
            parse_backend_kind(Some("acp")).expect("ACP"),
            BackendKind::Acp
        );
        assert_eq!(
            parse_backend_kind(Some("process")).expect("process"),
            BackendKind::Process
        );
        assert!(parse_backend_kind(Some("pi-jsonl")).is_err());
        assert!(parse_backend_kind(Some("unknown")).is_err());
    }
}
