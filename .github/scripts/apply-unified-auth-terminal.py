from __future__ import annotations

from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, source: str) -> None:
    Path(path).write_text(source)


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one {label}, found {count}")
    return source.replace(old, new, 1)


def replace_optional(source: str, old: str, new: str) -> str:
    return source.replace(old, new)


# Canonicalize the backend/frontend contract around authentication terminals.
for path in Path(".").rglob("*"):
    if not path.is_file() or path.suffix not in {".rs", ".ts", ".tsx", ".md"}:
        continue
    source = path.read_text()
    source = source.replace("ExternalCommandRequested", "AuthTerminalRequested")
    source = source.replace("ExternalCommand", "AuthTerminalRequest")
    source = source.replace("external_command.requested", "auth.terminal.requested")
    source = source.replace("external.command.requested", "auth.terminal.requested")
    source = source.replace("external_command_requested", "auth_terminal_requested")
    path.write_text(source)

# Runtime API: terminal authentication is a typed backend request, not arbitrary UI shell escape.
path = "rust/crates/phenix-runtime-api/src/protocol.rs"
source = read(path)
source = replace_once(
    source,
    '''pub struct AuthTerminalRequest {
    pub program: String,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
}
''',
    '''pub struct AuthTerminalRequest {
    pub program: String,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
}
''',
    "authentication terminal request",
)
write(path, source)

# ACP terminal authentication now supplies frontend-host metadata.
path = "rust/crates/phenix-acp-backend/src/lib.rs"
source = read(path)
source = replace_once(
    source,
    '''            let command = AuthTerminalRequest {
                program: invocation.remove(0),
                arguments: invocation,
                environment: method.env.into_iter().collect(),
            };
''',
    '''            let command = AuthTerminalRequest {
                program: invocation.remove(0),
                arguments: invocation,
                environment: method.env.into_iter().collect(),
                cwd: Some(config.cwd.to_string_lossy().into_owned()),
                title: Some(format!("Authenticate with {provider_id}")),
            };
''',
    "ACP authentication terminal construction",
)
write(path, source)

# UI state owns the visible terminal projection.
path = "rust/crates/phenix-ui-core/src/state.rs"
source = read(path)
source = replace_once(
    source,
    '''#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppState {
''',
    '''#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthTerminalState {
    pub flow_id: AuthFlowId,
    pub title: String,
    pub screen: String,
    pub cursor_row: u16,
    pub cursor_column: u16,
    pub running: bool,
    pub result: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppState {
''',
    "authentication terminal state",
)
source = replace_once(
    source,
    '''    pub auth_flows: BTreeMap<AuthFlowId, AuthFlowState>,
    pub commands: Vec<CommandSummary>,
''',
    '''    pub auth_flows: BTreeMap<AuthFlowId, AuthFlowState>,
    pub auth_terminal: Option<AuthTerminalState>,
    pub commands: Vec<CommandSummary>,
''',
    "authentication terminal app state field",
)
source = replace_once(
    source,
    '''            auth_flows: BTreeMap::new(),
            commands: Vec::new(),
''',
    '''            auth_flows: BTreeMap::new(),
            auth_terminal: None,
            commands: Vec::new(),
''',
    "authentication terminal default state",
)
write(path, source)

# A native terminal is a first-class overlay.
path = "rust/crates/phenix-ui-core/src/view.rs"
source = read(path)
source = replace_once(
    source,
    '''    AuthenticationPrompt {
        flow_id: AuthFlowId,
        prompt: AuthPrompt,
        input: String,
        selected: usize,
    },
''',
    '''    AuthenticationPrompt {
        flow_id: AuthFlowId,
        prompt: AuthPrompt,
        input: String,
        selected: usize,
    },
    AuthenticationTerminal {
        flow_id: AuthFlowId,
    },
''',
    "authentication terminal overlay",
)
write(path, source)

# Reducer: model the terminal lifecycle and effects explicitly.
path = "rust/crates/phenix-ui-core/src/reducer.rs"
source = read(path)
source = replace_once(
    source,
    '''use crate::state::{AppState, DialogState, RuntimeConnectionState};
''',
    '''use crate::state::{AppState, AuthTerminalState, DialogState, RuntimeConnectionState};
''',
    "reducer state imports",
)
source = replace_once(
    source,
    '''    AuthFlowId, AuthMethod, AuthPromptResponse, BackendCommand, BackendError, BackendEvent,
    BackendOutput, BackendReply, ExtensionUiResponse, ModelRef, RunId, SessionId,
''',
    '''    AuthFlowId, AuthMethod, AuthPromptResponse, AuthTerminalRequest, BackendCommand,
    BackendError, BackendEvent, BackendOutput, BackendReply, ExtensionUiResponse, ModelRef, RunId,
    SessionId,
''',
    "reducer runtime API imports",
)
source = replace_once(
    source,
    '''    RespondToAuthentication {
        flow_id: AuthFlowId,
        response: AuthPromptResponse,
    },
    CancelAuthentication(AuthFlowId),
''',
    '''    RespondToAuthentication {
        flow_id: AuthFlowId,
        response: AuthPromptResponse,
    },
    WriteAuthenticationTerminal {
        flow_id: AuthFlowId,
        bytes: Vec<u8>,
    },
    CancelAuthentication(AuthFlowId),
''',
    "authentication terminal user intent",
)
source = replace_once(
    source,
    '''pub enum AppEvent {
    User(UserIntent),
    Backend(Box<BackendOutput>),
    BackendSubmitFailed(String),
}
''',
    '''pub enum AppEvent {
    User(UserIntent),
    Backend(Box<BackendOutput>),
    AuthenticationTerminalFrame {
        flow_id: AuthFlowId,
        screen: String,
        cursor_row: u16,
        cursor_column: u16,
    },
    AuthenticationTerminalExited {
        flow_id: AuthFlowId,
        success: bool,
        message: Option<String>,
    },
    BackendSubmitFailed(String),
}
''',
    "authentication terminal app events",
)
source = replace_once(
    source,
    '''pub enum AppEffect {
    Send(BackendCommand),
    RunExternal {
        flow_id: AuthFlowId,
        command: phenix_runtime_api::AuthTerminalRequest,
    },
    Render,
    Quit,
}
''',
    '''pub enum AppEffect {
    Send(BackendCommand),
    StartAuthenticationTerminal {
        flow_id: AuthFlowId,
        request: AuthTerminalRequest,
    },
    WriteAuthenticationTerminal {
        flow_id: AuthFlowId,
        bytes: Vec<u8>,
    },
    CancelAuthenticationTerminal {
        flow_id: AuthFlowId,
    },
    ReleaseAuthenticationTerminal {
        flow_id: AuthFlowId,
    },
    Render,
    Quit,
}
''',
    "authentication terminal effects",
)
source = replace_once(
    source,
    '''        AppEvent::Backend(output) => reduce_backend_output(state, *output),
        AppEvent::BackendSubmitFailed(message) => {
''',
    '''        AppEvent::Backend(output) => reduce_backend_output(state, *output),
        AppEvent::AuthenticationTerminalFrame {
            flow_id,
            screen,
            cursor_row,
            cursor_column,
        } => {
            if let Some(terminal) = state
                .auth_terminal
                .as_mut()
                .filter(|terminal| terminal.flow_id == flow_id)
            {
                terminal.screen = screen;
                terminal.cursor_row = cursor_row;
                terminal.cursor_column = cursor_column;
            }
            vec![AppEffect::Render]
        }
        AppEvent::AuthenticationTerminalExited {
            flow_id,
            success,
            message,
        } => {
            if let Some(terminal) = state
                .auth_terminal
                .as_mut()
                .filter(|terminal| terminal.flow_id == flow_id)
            {
                terminal.running = false;
                terminal.result = message.clone().or_else(|| {
                    Some(if success {
                        "Authentication command completed.".to_owned()
                    } else {
                        "Authentication command failed.".to_owned()
                    })
                });
            }
            vec![
                AppEffect::Send(BackendCommand::AuthTerminalFinished {
                    flow_id,
                    success,
                    message,
                }),
                AppEffect::Render,
            ]
        }
        AppEvent::BackendSubmitFailed(message) => {
''',
    "authentication terminal event reduction",
)
source = replace_once(
    source,
    '''        UserIntent::RespondToAuthentication { flow_id, response } => {
            close_overlay(state);
            vec![
                AppEffect::Send(BackendCommand::AuthLoginRespond { flow_id, response }),
                AppEffect::Render,
            ]
        }
        UserIntent::CancelAuthentication(flow_id) => {
            close_overlay(state);
            vec![
                AppEffect::Send(BackendCommand::AuthLoginCancel { flow_id }),
                AppEffect::Render,
            ]
        }
''',
    '''        UserIntent::RespondToAuthentication { flow_id, response } => {
            close_overlay(state);
            vec![
                AppEffect::Send(BackendCommand::AuthLoginRespond { flow_id, response }),
                AppEffect::Render,
            ]
        }
        UserIntent::WriteAuthenticationTerminal { flow_id, bytes } => {
            vec![AppEffect::WriteAuthenticationTerminal { flow_id, bytes }]
        }
        UserIntent::CancelAuthentication(flow_id) => {
            let terminal_active = state
                .auth_terminal
                .as_ref()
                .is_some_and(|terminal| terminal.flow_id == flow_id);
            close_overlay(state);
            state.auth_terminal = None;
            let mut effects = Vec::new();
            if terminal_active {
                effects.push(AppEffect::CancelAuthenticationTerminal {
                    flow_id: flow_id.clone(),
                });
            }
            effects.extend([
                AppEffect::Send(BackendCommand::AuthLoginCancel { flow_id }),
                AppEffect::Render,
            ]);
            effects
        }
''',
    "authentication terminal intent reduction",
)
source = replace_once(
    source,
    '''fn reduce_backend_output(state: &mut AppState, output: BackendOutput) -> Vec<AppEffect> {
    match output {
''',
    '''fn begin_authentication_terminal(
    state: &mut AppState,
    flow_id: AuthFlowId,
    request: AuthTerminalRequest,
) -> Vec<AppEffect> {
    let title = request
        .title
        .clone()
        .unwrap_or_else(|| "Authentication".to_owned());
    state.auth_flow_mut(flow_id.clone());
    state.auth_terminal = Some(AuthTerminalState {
        flow_id: flow_id.clone(),
        title,
        screen: String::new(),
        cursor_row: 0,
        cursor_column: 0,
        running: true,
        result: None,
    });
    state.view.overlay = Some(OverlayState::AuthenticationTerminal {
        flow_id: flow_id.clone(),
    });
    state.view.focus = FocusTarget::Overlay;
    vec![
        AppEffect::StartAuthenticationTerminal { flow_id, request },
        AppEffect::Render,
    ]
}

fn reduce_backend_output(state: &mut AppState, output: BackendOutput) -> Vec<AppEffect> {
    match output {
''',
    "authentication terminal reducer helper",
)
source = replace_once(
    source,
    '''        BackendOutput::Event(BackendEvent::AuthTerminalRequested { flow_id, command }) => vec![
            AppEffect::RunExternal { flow_id, command },
            AppEffect::Render,
        ],
        BackendOutput::Event(event) => {
            reduce_backend_event(state, event);
            vec![AppEffect::Render]
        }
''',
    '''        BackendOutput::Event(BackendEvent::AuthTerminalRequested { flow_id, command }) => {
            begin_authentication_terminal(state, flow_id, command)
        }
        BackendOutput::Event(
            event @ BackendEvent::AuthFinished {
                ref flow_id, ..
            },
        ) => {
            let flow_id = flow_id.clone();
            reduce_backend_event(state, event);
            vec![
                AppEffect::ReleaseAuthenticationTerminal { flow_id },
                AppEffect::Render,
            ]
        }
        BackendOutput::Event(event) => {
            reduce_backend_event(state, event);
            vec![AppEffect::Render]
        }
''',
    "authentication terminal backend output",
)
source = replace_once(
    source,
    '''        BackendEvent::AuthTerminalRequested { .. } => {
            unreachable!("handled before reducer projection")
        }
''',
    '''        BackendEvent::AuthTerminalRequested { .. } => {
            unreachable!("handled before reducer projection")
        }
''',
    "authentication terminal unreachable arm",
)
source = replace_once(
    source,
    '''            state.auth_flows.remove(&flow_id);
            match result {
''',
    '''            state.auth_flows.remove(&flow_id);
            if state
                .auth_terminal
                .as_ref()
                .is_some_and(|terminal| terminal.flow_id == flow_id)
            {
                state.auth_terminal = None;
            }
            match result {
''',
    "authentication terminal completion state",
)
source = replace_once(
    source,
    '''                Some(OverlayState::AuthenticationProviders { .. })
                )
''',
    '''                Some(OverlayState::AuthenticationProviders { .. })
                    | Some(OverlayState::AuthenticationTerminal { .. })
                )
''',
    "authentication terminal overlay close",
)
source = replace_once(
    source,
    '''        AuthPrompt, BackendHealth, DialogId, ExtensionUiRequest, RunKind, RunState, RunSummary,
        RuntimeSnapshot, TranscriptBlock, TranscriptRole,
''',
    '''        AuthPrompt, BackendCapabilities, BackendHealth, DialogId, ExtensionUiRequest, RunKind,
        RunState, RunSummary, RuntimeSnapshot, TranscriptBlock, TranscriptRole,
''',
    "reducer test capability import",
)
source = replace_once(
    source,
    '''    #[test]
    fn authentication_prompt_becomes_a_native_overlay() {
''',
    '''    #[test]
    fn terminal_authentication_is_owned_by_the_native_ui() {
        let flow_id = AuthFlowId::parse("auth-terminal").expect("flow ID");
        let request = AuthTerminalRequest {
            program: "backend-auth".to_owned(),
            arguments: vec!["login".to_owned()],
            environment: Default::default(),
            cwd: None,
            title: Some("Backend login".to_owned()),
        };
        let mut state = AppState::default();
        let effects = reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Event(
                BackendEvent::AuthTerminalRequested {
                    flow_id: flow_id.clone(),
                    command: request.clone(),
                },
            ))),
        );
        assert!(matches!(
            state.view.overlay,
            Some(OverlayState::AuthenticationTerminal { ref flow_id: active }) if active == &flow_id
        ));
        assert!(matches!(
            effects.first(),
            Some(AppEffect::StartAuthenticationTerminal {
                flow_id: active,
                request: active_request,
            }) if active == &flow_id && active_request == &request
        ));
    }

    #[test]
    fn authentication_prompt_becomes_a_native_overlay() {
''',
    "authentication terminal reducer test",
)
write(path, source)

# Event fabric owns terminal dimensions.
path = "rust/crates/phenix-ui-runtime/src/fabric.rs"
source = read(path)
source = replace_once(
    source,
    '''    MoveOverlaySelection(i32),
    Notify(String),
''',
    '''    MoveOverlaySelection(i32),
    SetTerminalSize { width: u16, height: u16 },
    Notify(String),
''',
    "terminal size view mutation",
)
write(path, source)

path = "rust/crates/phenix-ui-runtime/src/consumers.rs"
source = read(path)
source = replace_once(
    source,
    '''            UiEvent::Invalidate => return ReactionBatch::one(BusReaction::Render),
            UiEvent::Input(_) | UiEvent::ShutdownRequested => None,
''',
    '''            UiEvent::Input(phenix_ui_core::UiInput::Resize { width, height }) => {
                Some(ViewMutation::SetTerminalSize {
                    width: *width,
                    height: *height,
                })
            }
            UiEvent::Invalidate => return ReactionBatch::one(BusReaction::Render),
            UiEvent::Input(_) | UiEvent::ShutdownRequested => None,
''',
    "terminal resize consumption",
)
write(path, source)

# Frontend input is routed directly to the active authentication PTY before Lua keymaps.
path = "rust/crates/phenix-ui-runtime/src/frontend.rs"
source = read(path)
source = replace_once(
    source,
    '''        match &envelope.event {
            UiEvent::Input(UiInput::Paste(text)) => ReactionBatch::stop(vec![BusReaction::View(
''',
    '''        match &envelope.event {
            UiEvent::Input(UiInput::Paste(text)) if active_auth_terminal(state).is_some() => {
                let flow_id = active_auth_terminal(state).expect("checked active terminal");
                ReactionBatch::stop(vec![BusReaction::App(AppEvent::User(
                    UserIntent::WriteAuthenticationTerminal {
                        flow_id,
                        bytes: text.as_bytes().to_vec(),
                    },
                ))])
            }
            UiEvent::Input(UiInput::Key(key)) if active_auth_terminal(state).is_some() => {
                terminal_key_reactions(
                    active_auth_terminal(state).expect("checked active terminal"),
                    *key,
                )
            }
            UiEvent::Input(UiInput::Paste(text)) => ReactionBatch::stop(vec![BusReaction::View(
''',
    "authentication terminal input routing",
)
source = replace_once(
    source,
    '''fn frontend_context(state: &AppState) -> FrontendContext {
''',
    '''fn active_auth_terminal(state: &AppState) -> Option<phenix_runtime_api::AuthFlowId> {
    match &state.view.overlay {
        Some(OverlayState::AuthenticationTerminal { flow_id }) => Some(flow_id.clone()),
        _ => None,
    }
}

fn terminal_key_reactions(
    flow_id: phenix_runtime_api::AuthFlowId,
    key: phenix_ui_core::KeyInput,
) -> ReactionBatch {
    if key.modifiers.control && key.code == KeyCode::Character(']') {
        return ReactionBatch::stop(vec![BusReaction::App(AppEvent::User(
            UserIntent::CancelAuthentication(flow_id),
        ))]);
    }
    terminal_key_bytes(key).map_or_else(ReactionBatch::none, |bytes| {
        ReactionBatch::stop(vec![BusReaction::App(AppEvent::User(
            UserIntent::WriteAuthenticationTerminal { flow_id, bytes },
        ))])
    })
}

fn terminal_key_bytes(key: phenix_ui_core::KeyInput) -> Option<Vec<u8>> {
    let mut bytes = match key.code {
        KeyCode::Character(character) if key.modifiers.control => {
            let upper = character.to_ascii_uppercase();
            if ('@'..='_').contains(&upper) {
                vec![(upper as u8) & 0x1f]
            } else if character == '?' {
                vec![0x7f]
            } else {
                return None;
            }
        }
        KeyCode::Character(character) => character.to_string().into_bytes(),
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Escape => vec![0x1b],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        KeyCode::Insert => b"\x1b[2~".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        KeyCode::Tab => vec![b'\t'],
        KeyCode::BackTab => b"\x1b[Z".to_vec(),
        KeyCode::Function(number) => match number {
            1 => b"\x1bOP".to_vec(),
            2 => b"\x1bOQ".to_vec(),
            3 => b"\x1bOR".to_vec(),
            4 => b"\x1bOS".to_vec(),
            5..=12 => format!("\x1b[{}~", number + 10).into_bytes(),
            _ => return None,
        },
    };
    if key.modifiers.alt {
        bytes.insert(0, 0x1b);
    }
    Some(bytes)
}

fn frontend_context(state: &AppState) -> FrontendContext {
''',
    "authentication terminal key encoding",
)
source = replace_once(
    source,
    '''        Some(OverlayState::ExtensionDialog { .. }) => Vec::new(),
        Some(OverlayState::CommandPalette { .. }) | Some(OverlayState::Help) | None => Vec::new(),
''',
    '''        Some(OverlayState::AuthenticationTerminal { .. })
        | Some(OverlayState::ExtensionDialog { .. }) => Vec::new(),
        Some(OverlayState::CommandPalette { .. }) | Some(OverlayState::Help) | None => Vec::new(),
''',
    "authentication terminal overlay acceptance",
)
source = replace_once(
    source,
    '''        Some(OverlayState::AuthenticationPrompt { flow_id, .. }) = &state.view.overlay {
''',
    '''        Some(OverlayState::AuthenticationPrompt { flow_id, .. })
        | Some(OverlayState::AuthenticationTerminal { flow_id }) = &state.view.overlay {
''',
    "authentication terminal overlay cancellation",
)
source = replace_once(
    source,
    '''        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
''',
    '''        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
''',
    "overlay selected unchanged variants",
)
source = replace_once(
    source,
    '''        Some(OverlayState::Help) | None => 0,
''',
    '''        Some(OverlayState::AuthenticationTerminal { .. })
        | Some(OverlayState::Help)
        | None => 0,
''',
    "authentication terminal selected value",
)
write(path, source)

# Backend-neutral injectable terminal host with a native PTY implementation.
write(
    "rust/crates/phenix-ui-runtime/src/auth_terminal.rs",
    r'''use crate::UiMailbox;
use phenix_runtime_api::{AuthFlowId, AuthTerminalRequest};
use phenix_ui_core::{AppEvent, TerminalSize};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize, PtySystem};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLUMNS: u16 = 80;
const SCROLLBACK_ROWS: usize = 2_000;

pub trait AuthTerminalHost {
    fn start(
        &mut self,
        flow_id: AuthFlowId,
        request: AuthTerminalRequest,
        size: TerminalSize,
        mailbox: UiMailbox,
    ) -> Result<(), String>;

    fn write(&mut self, flow_id: &AuthFlowId, bytes: &[u8]) -> Result<(), String>;

    fn resize(&mut self, flow_id: &AuthFlowId, size: TerminalSize) -> Result<(), String>;

    fn cancel(&mut self, flow_id: &AuthFlowId) -> Result<(), String>;

    fn release(&mut self, flow_id: &AuthFlowId);
}

#[derive(Default)]
pub struct NativeAuthTerminalHost {
    sessions: BTreeMap<AuthFlowId, NativeAuthTerminalSession>,
}

struct NativeAuthTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    parser: Arc<Mutex<vt100::Parser>>,
}

impl AuthTerminalHost for NativeAuthTerminalHost {
    fn start(
        &mut self,
        flow_id: AuthFlowId,
        request: AuthTerminalRequest,
        size: TerminalSize,
        mailbox: UiMailbox,
    ) -> Result<(), String> {
        self.release(&flow_id);
        let size = normalized_size(size);
        let pair = native_pty_system()
            .openpty(pty_size(size))
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new(request.program);
        command.args(request.arguments);
        for (name, value) in request.environment {
            command.env(name, value);
        }
        if let Some(cwd) = request.cwd {
            command.cwd(PathBuf::from(cwd));
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let killer = child.clone_killer();
        let parser = Arc::new(Mutex::new(vt100::Parser::new(
            size.height,
            size.width,
            SCROLLBACK_ROWS,
        )));

        let reader_parser = Arc::clone(&parser);
        let reader_flow = flow_id.clone();
        let reader_mailbox = mailbox.clone();
        thread::Builder::new()
            .name(format!("phenix-auth-terminal-reader-{flow_id}"))
            .spawn(move || {
                let mut bytes = [0_u8; 8_192];
                loop {
                    let count = match reader.read(&mut bytes) {
                        Ok(0) | Err(_) => return,
                        Ok(count) => count,
                    };
                    let frame = {
                        let Ok(mut parser) = reader_parser.lock() else {
                            return;
                        };
                        parser.process(&bytes[..count]);
                        let screen = parser.screen();
                        let (cursor_row, cursor_column) = screen.cursor_position();
                        (screen.contents(), cursor_row, cursor_column)
                    };
                    if reader_mailbox
                        .send_app(AppEvent::AuthenticationTerminalFrame {
                            flow_id: reader_flow.clone(),
                            screen: frame.0,
                            cursor_row: frame.1,
                            cursor_column: frame.2,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        let waiter_flow = flow_id.clone();
        thread::Builder::new()
            .name(format!("phenix-auth-terminal-waiter-{flow_id}"))
            .spawn(move || {
                let (success, message) = match child.wait() {
                    Ok(status) => (
                        status.success(),
                        (!status.success()).then(|| format!("authentication process exited: {status:?}")),
                    ),
                    Err(error) => (false, Some(format!("authentication process wait failed: {error}"))),
                };
                let _ = mailbox.send_app(AppEvent::AuthenticationTerminalExited {
                    flow_id: waiter_flow,
                    success,
                    message,
                });
            })
            .map_err(|error| error.to_string())?;

        self.sessions.insert(
            flow_id,
            NativeAuthTerminalSession {
                master: pair.master,
                writer,
                killer,
                parser,
            },
        );
        Ok(())
    }

    fn write(&mut self, flow_id: &AuthFlowId, bytes: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(flow_id)
            .ok_or_else(|| format!("unknown authentication terminal {flow_id}"))?;
        session.writer.write_all(bytes).map_err(|error| error.to_string())?;
        session.writer.flush().map_err(|error| error.to_string())
    }

    fn resize(&mut self, flow_id: &AuthFlowId, size: TerminalSize) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(flow_id)
            .ok_or_else(|| format!("unknown authentication terminal {flow_id}"))?;
        let size = normalized_size(size);
        session
            .master
            .resize(pty_size(size))
            .map_err(|error| error.to_string())?;
        session
            .parser
            .lock()
            .map_err(|_| "authentication terminal parser lock poisoned".to_owned())?
            .screen_mut()
            .set_size(size.height, size.width);
        Ok(())
    }

    fn cancel(&mut self, flow_id: &AuthFlowId) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(flow_id)
            .ok_or_else(|| format!("unknown authentication terminal {flow_id}"))?;
        session.killer.kill().map_err(|error| error.to_string())
    }

    fn release(&mut self, flow_id: &AuthFlowId) {
        self.sessions.remove(flow_id);
    }
}

fn normalized_size(size: TerminalSize) -> TerminalSize {
    TerminalSize {
        width: if size.width == 0 {
            DEFAULT_COLUMNS
        } else {
            size.width
        },
        height: if size.height == 0 {
            DEFAULT_ROWS
        } else {
            size.height
        },
    }
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.height,
        cols: size.width,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_terminal_dimensions_use_usable_defaults() {
        assert_eq!(
            normalized_size(TerminalSize::default()),
            TerminalSize {
                width: DEFAULT_COLUMNS,
                height: DEFAULT_ROWS,
            }
        );
    }
}
''',
)

# Mailbox accepts host-originated typed application events.
path = "rust/crates/phenix-ui-runtime/src/mailbox.rs"
source = read(path)
source = replace_once(
    source,
    '''    pub fn send_user(&self, intent: UserIntent) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::App(AppEvent::User(intent)))
    }
''',
    '''    pub fn send_user(&self, intent: UserIntent) -> Result<(), UiIngressError> {
        self.send_app(AppEvent::User(intent))
    }

    pub fn send_app(&self, event: AppEvent) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::App(event))
    }
''',
    "mailbox application event ingress",
)
write(path, source)

# Runtime delegates terminal execution to the injected host and never suspends Ratatui.
path = "rust/crates/phenix-ui-runtime/src/runtime.rs"
source = read(path)
source = replace_once(
    source,
    '''use crate::{
    install_core_consumers, install_frontend_provider, BusReaction, EventRouter, InputEdit,
    UiIngressError, UiMailbox, UiMessage, ViewMutation,
};
''',
    '''use crate::{
    install_core_consumers, install_frontend_provider, AuthTerminalHost, BusReaction, EventRouter,
    InputEdit, NativeAuthTerminalHost, UiIngressError, UiMailbox, UiMessage, ViewMutation,
};
''',
    "runtime authentication terminal imports",
)
source = replace_once(
    source,
    '''use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
''',
    '''use std::sync::mpsc::{self, Receiver, TryRecvError};
''',
    "runtime external process imports",
)
source = replace_once(
    source,
    '''pub trait UiRenderer {
    fn render(&mut self, state: &AppState) -> Result<(), String>;

    fn suspend(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn resume(&mut self) -> Result<(), String> {
        Ok(())
    }
}
''',
    '''pub trait UiRenderer {
    fn render(&mut self, state: &AppState) -> Result<(), String>;
}
''',
    "renderer contract",
)
source = replace_once(
    source,
    '''    drain_limit: usize,
    external_io_pause: Option<Arc<AtomicBool>>,
''',
    '''    drain_limit: usize,
    auth_terminal_host: Box<dyn AuthTerminalHost>,
''',
    "runtime terminal host field",
)
source = replace_once(
    source,
    '''            drain_limit: DEFAULT_DRAIN_LIMIT,
            external_io_pause: None,
''',
    '''            drain_limit: DEFAULT_DRAIN_LIMIT,
            auth_terminal_host: Box::new(NativeAuthTerminalHost::default()),
''',
    "runtime terminal host initialization",
)
source = replace_once(
    source,
    '''    pub fn set_external_io_pause(&mut self, pause: Arc<AtomicBool>) {
        self.external_io_pause = Some(pause);
    }
''',
    '''    pub fn set_auth_terminal_host(&mut self, host: Box<dyn AuthTerminalHost>) {
        self.auth_terminal_host = host;
    }
''',
    "runtime terminal host injection",
)
old_block_start = '''                AppEffect::RunExternal { flow_id, command } => {
'''
start = source.find(old_block_start)
if start < 0:
    raise SystemExit("missing external command effect block")
end = source.find('''                AppEffect::Render => dirty = true,
''', start)
if end < 0:
    raise SystemExit("missing effect block end")
replacement = '''                AppEffect::StartAuthenticationTerminal { flow_id, request } => {
                    let size = self.state.view.terminal;
                    if let Err(message) = self.auth_terminal_host.start(
                        flow_id.clone(),
                        request,
                        size,
                        self.mailbox.clone(),
                    ) {
                        effects.push_back(AppEffect::Render);
                        effects.extend(reduce(
                            &mut self.state,
                            AppEvent::AuthenticationTerminalExited {
                                flow_id,
                                success: false,
                                message: Some(message),
                            },
                        ));
                    }
                    dirty = true;
                }
                AppEffect::WriteAuthenticationTerminal { flow_id, bytes } => {
                    if let Err(message) = self.auth_terminal_host.write(&flow_id, &bytes) {
                        effects.extend(reduce(
                            &mut self.state,
                            AppEvent::AuthenticationTerminalExited {
                                flow_id,
                                success: false,
                                message: Some(message),
                            },
                        ));
                    }
                }
                AppEffect::CancelAuthenticationTerminal { flow_id } => {
                    if let Err(message) = self.auth_terminal_host.cancel(&flow_id) {
                        effects.extend(reduce(
                            &mut self.state,
                            AppEvent::BackendSubmitFailed(message),
                        ));
                    }
                    self.auth_terminal_host.release(&flow_id);
                    dirty = true;
                }
                AppEffect::ReleaseAuthenticationTerminal { flow_id } => {
                    self.auth_terminal_host.release(&flow_id);
                    dirty = true;
                }
'''
source = source[:start] + replacement + source[end:]
source = replace_once(
    source,
    '''                BusReaction::View(mutation) => {
                    apply_view_mutation(&mut self.state, mutation);
                    dirty = true;
                }
''',
    '''                BusReaction::View(mutation) => {
                    let terminal_resize = match mutation {
                        ViewMutation::SetTerminalSize { width, height } => {
                            Some(phenix_ui_core::TerminalSize { width, height })
                        }
                        _ => None,
                    };
                    apply_view_mutation(&mut self.state, mutation);
                    if let (Some(size), Some(terminal)) =
                        (terminal_resize, self.state.auth_terminal.as_ref())
                    {
                        if let Err(message) =
                            self.auth_terminal_host.resize(&terminal.flow_id, size)
                        {
                            self.state.notifications.push_back(message);
                        }
                    }
                    dirty = true;
                }
''',
    "runtime terminal resize dispatch",
)
source = replace_once(
    source,
    '''        ViewMutation::MoveOverlaySelection(delta) => move_overlay_selection(state, delta),
        ViewMutation::Notify(message) => state.notifications.push_back(message),
''',
    '''        ViewMutation::MoveOverlaySelection(delta) => move_overlay_selection(state, delta),
        ViewMutation::SetTerminalSize { width, height } => {
            state.view.terminal = phenix_ui_core::TerminalSize { width, height };
        }
        ViewMutation::Notify(message) => state.notifications.push_back(message),
''',
    "terminal size application",
)
source = replace_once(
    source,
    '''        Some(OverlayState::AuthenticationPrompt { prompt, .. }) => match prompt {
            phenix_runtime_api::AuthPrompt::Select { options, .. } => options.len(),
            _ => 0,
        },
''',
    '''        Some(OverlayState::AuthenticationPrompt { prompt, .. }) => match prompt {
            phenix_runtime_api::AuthPrompt::Select { options, .. } => options.len(),
            _ => 0,
        },
        Some(OverlayState::AuthenticationTerminal { .. }) => 0,
''',
    "runtime authentication terminal selection length",
)
source = replace_once(
    source,
    '''        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
''',
    '''        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
''',
    "runtime selected overlay variants unchanged",
)
source = replace_once(
    source,
    '''        Some(OverlayState::Help) | None => return,
''',
    '''        Some(OverlayState::AuthenticationTerminal { .. })
        | Some(OverlayState::Help)
        | None => return,
''',
    "runtime authentication terminal selection mutation",
)
write(path, source)

# Export the host interface.
path = "rust/crates/phenix-ui-runtime/src/lib.rs"
source = read(path)
source = replace_once(source, "mod consumers;\n", "mod auth_terminal;\nmod consumers;\n", "auth terminal module")
source = replace_once(
    source,
    '''pub use consumers::install_core_consumers;
''',
    '''pub use auth_terminal::{AuthTerminalHost, NativeAuthTerminalHost};
pub use consumers::install_core_consumers;
''',
    "auth terminal exports",
)
write(path, source)

# Ratatui renders the embedded terminal and keeps the cursor inside Phenix.
path = "rust/crates/phenix-tui/src/renderer.rs"
source = read(path)
start = source.find('''    fn suspend(&mut self) -> Result<(), String> {
''')
if start < 0:
    raise SystemExit("missing renderer suspend implementation")
end = source.find("}\n\nimpl Drop for RatatuiRenderer", start)
if end < 0:
    raise SystemExit("missing renderer implementation end")
source = source[:start] + source[end:]
source = replace_once(
    source,
    '''        OverlayState::AuthenticationPrompt {
            flow_id,
            prompt,
            selected,
            ..
        } => render_auth_prompt(
''',
    '''        OverlayState::AuthenticationPrompt {
            flow_id,
            prompt,
            selected,
            ..
        } => render_auth_prompt(
''',
    "authentication prompt renderer arm",
)
needle = '''        OverlayState::ExtensionDialog {
            request, selected, ..
        } => render_extension_dialog(frame, overlay_area, request, *selected, state, theme),
'''
source = replace_once(
    source,
    needle,
    '''        OverlayState::AuthenticationTerminal { flow_id } => {
            render_auth_terminal(frame, centered(area, 90, 80), flow_id, state, theme)
        }
''' + needle,
    "authentication terminal renderer arm",
)
source = replace_once(
    source,
    '''fn render_extension_dialog(
''',
    '''fn render_auth_terminal(
    frame: &mut Frame<'_>,
    area: Rect,
    flow_id: &phenix_runtime_api::AuthFlowId,
    state: &AppState,
    theme: &ThemeConfig,
) {
    frame.render_widget(Clear, area);
    let Some(terminal) = state
        .auth_terminal
        .as_ref()
        .filter(|terminal| &terminal.flow_id == flow_id)
    else {
        frame.render_widget(
            Paragraph::new("Authentication terminal is not available.")
                .block(panel("Authentication", true, theme)),
            area,
        );
        return;
    };
    let title = format!("{} · Ctrl+] cancel", terminal.title);
    let block = panel(&title, true, theme);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut text = terminal.screen.clone();
    if let Some(result) = &terminal.result {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(result);
    }
    frame.render_widget(
        Paragraph::new(text)
            .style(theme_style(theme, "Normal"))
            .wrap(Wrap { trim: false }),
        inner,
    );
    if terminal.running && inner.width > 0 && inner.height > 0 {
        frame.set_cursor_position((
            inner.x.saturating_add(
                terminal
                    .cursor_column
                    .min(inner.width.saturating_sub(1)),
            ),
            inner
                .y
                .saturating_add(terminal.cursor_row.min(inner.height.saturating_sub(1))),
        ));
    }
}

fn render_extension_dialog(
''',
    "authentication terminal renderer",
)
source = replace_once(
    source,
    '''        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
''',
    '''        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
''',
    "renderer selected overlay variants unchanged",
)
source = replace_once(
    source,
    '''        Some(OverlayState::Help) | None => 0,
''',
    '''        Some(OverlayState::AuthenticationTerminal { .. })
        | Some(OverlayState::Help)
        | None => 0,
''',
    "renderer authentication terminal selection",
)
write(path, source)

# TUI input remains live while the embedded authentication terminal is active.
path = "rust/crates/phenix-tui/src/main.rs"
source = read(path)
source = replace_once(
    source,
    '''use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
''',
    '''use std::sync::mpsc::{Receiver, RecvTimeoutError};
''',
    "TUI external I/O pause imports",
)
source = replace_once(
    source,
    '''    let external_io_pause = Arc::new(AtomicBool::new(false));
    runtime.set_external_io_pause(Arc::clone(&external_io_pause));
    let _ticker = runtime.spawn_ticker(Duration::from_millis(250))?;
    let _input_thread = spawn_terminal_input(mailbox, external_io_pause)?;
''',
    '''    let _ticker = runtime.spawn_ticker(Duration::from_millis(250))?;
    let _input_thread = spawn_terminal_input(mailbox)?;
''',
    "TUI embedded authentication runtime",
)
source = replace_once(
    source,
    '''fn spawn_terminal_input(
    mailbox: phenix_ui_runtime::UiMailbox,
    external_io_pause: Arc<AtomicBool>,
) -> Result<thread::JoinHandle<()>, Box<dyn Error>> {
''',
    '''fn spawn_terminal_input(
    mailbox: phenix_ui_runtime::UiMailbox,
) -> Result<thread::JoinHandle<()>, Box<dyn Error>> {
''',
    "TUI terminal input signature",
)
source = replace_once(
    source,
    '''        .spawn(move || loop {
            if external_io_pause.load(Ordering::Acquire) {
                thread::sleep(INPUT_POLL_PERIOD);
                continue;
            }
            match event::poll(INPUT_POLL_PERIOD) {
''',
    '''        .spawn(move || loop {
            match event::poll(INPUT_POLL_PERIOD) {
''',
    "TUI terminal input loop",
)
write(path, source)

# Dependencies for the native cross-platform PTY and terminal parser.
path = "rust/Cargo.toml"
source = read(path)
source = replace_once(
    source,
    '''mlua = { version = "0.12.0", features = ["lua54", "vendored"] }
ratatui = "0.30.2"
''',
    '''mlua = { version = "0.12.0", features = ["lua54", "vendored"] }
portable-pty = "0.9.0"
ratatui = "0.30.2"
''',
    "portable PTY workspace dependency",
)
source = replace_once(
    source,
    '''shell-words = "1.1"
''',
    '''shell-words = "1.1"
vt100 = "0.16.2"
''',
    "VT100 workspace dependency",
)
write(path, source)

path = "rust/crates/phenix-ui-runtime/Cargo.toml"
source = read(path)
source = replace_once(
    source,
    '''phenix-ui-core = { path = "../phenix-ui-core" }
''',
    '''phenix-ui-core = { path = "../phenix-ui-core" }
portable-pty.workspace = true
vt100.workspace = true
''',
    "UI runtime terminal dependencies",
)
write(path, source)

# Process wire field names are canonicalized where present.
for path in Path(".").rglob("*"):
    if not path.is_file() or path.suffix not in {".rs", ".ts", ".tsx"}:
        continue
    source = path.read_text()
    source = source.replace('"external.command.requested"', '"auth.terminal.requested"')
    source = source.replace('"external_command.requested"', '"auth.terminal.requested"')
    source = source.replace('"externalCommandRequested"', '"authTerminalRequested"')
    path.write_text(source)

# Temporary workflows are implementation scaffolding, not product files.
for temporary in [
    Path(".github/workflows/apply-acp-ui-compile-fix-once.yml"),
    Path(".github/workflows/verify-acp-ui-fix.yml"),
]:
    if temporary.exists():
        temporary.unlink()
