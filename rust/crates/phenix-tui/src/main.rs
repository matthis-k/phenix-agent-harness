use phenix_process_backend::{ProcessAgentBackend, ProcessBackendConfig};
use phenix_runtime_api::{
    BackendCommand, BackendRuntime, ClientInformation,
};
use phenix_tui::{PhenixInputController, RatatuiRenderer};
use phenix_ui_core::{
    AppState, KeyCode, KeyInput, KeyModifiers, MouseAction, MouseButton, MouseInput, UiInput,
};
use phenix_ui_runtime::{UiIngressError, UiRuntime};
use ratatui::crossterm::event::{
    self, Event, KeyCode as CrosstermKeyCode, KeyEvent, KeyEventKind, KeyModifiers as CrosstermModifiers,
    MouseButton as CrosstermMouseButton, MouseEvent, MouseEventKind,
};
use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

const CHANNEL_CAPACITY: usize = 1_024;

fn main() -> Result<(), Box<dyn Error>> {
    let backend = BackendRuntime::spawn(Box::new(create_process_backend()?), CHANNEL_CAPACITY)?;
    backend.client.submit(BackendCommand::Initialize {
        client: ClientInformation {
            name: "phenix-tui".to_owned(),
            build: env!("CARGO_PKG_VERSION").to_owned(),
        },
    })?;

    let renderer = RatatuiRenderer::initialize()?;
    let controller = PhenixInputController::default();
    let runtime = UiRuntime::from_backend_with_controller(
        AppState::default(),
        backend,
        renderer,
        controller,
        CHANNEL_CAPACITY,
    )?;
    let mailbox = runtime.mailbox();
    let _ticker = runtime.spawn_ticker(Duration::from_millis(250))?;
    let input_thread = spawn_terminal_input(mailbox)?;
    let result = runtime.run();
    let _ = input_thread.join();
    result?;
    Ok(())
}

fn create_process_backend() -> Result<ProcessAgentBackend, Box<dyn Error>> {
    let program = env::var_os("PHENIX_HEADLESS_PROGRAM")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"));
    let entry = env::var("PHENIX_HEADLESS_ENTRY").map_err(|_| {
        "PHENIX_HEADLESS_ENTRY is not set; use the packaged `phenix` command or point it to headless/main.ts"
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
) -> Result<thread::JoinHandle<()>, Box<dyn Error>> {
    Ok(thread::Builder::new()
        .name("phenix-terminal-input".to_owned())
        .spawn(move || loop {
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
        Event::Key(key) if key.kind != KeyEventKind::Release => Some(UiInput::Key(convert_key(key))),
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
            CrosstermKeyCode::Null => KeyCode::Character('\0'),
            CrosstermKeyCode::Esc => KeyCode::Escape,
            CrosstermKeyCode::CapsLock
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
    fn headless_environment_is_explicitly_allowlisted() {
        let environment = inherited_headless_environment();
        assert!(!environment.contains_key("GITHUB_TOKEN"));
        assert!(!environment.contains_key("OPENAI_API_KEY"));
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
}
