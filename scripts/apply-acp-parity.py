from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old in text:
        file.write_text(text.replace(old, new, 1))
    elif new not in text:
        raise RuntimeError(f"missing replacement anchor in {file}: {old}")


protocol = "rust/crates/phenix-runtime-api/src/protocol.rs"
replace_once(
    protocol,
    "use std::fmt::{self, Debug, Formatter};",
    "use std::collections::BTreeMap;\nuse std::fmt::{self, Debug, Formatter};",
)
replace_once(
    protocol,
    "    pub api_keys: bool,\n    pub device_code: bool,",
    "    pub api_keys: bool,\n    pub terminal: bool,\n    pub device_code: bool,",
)
replace_once(
    protocol,
    "pub struct ModelSummary {\n    pub model: ModelRef,\n    pub display_name: String,\n    pub supports_images: bool,\n    pub supports_thinking: bool,\n}\n",
    "pub struct ModelSummary {\n    pub model: ModelRef,\n    pub display_name: String,\n    pub supports_images: bool,\n    pub supports_thinking: bool,\n}\n\n#[derive(Clone, Debug, Eq, PartialEq)]\npub struct SessionModeSummary {\n    pub id: String,\n    pub display_name: String,\n    pub description: Option<String>,\n    pub selected: bool,\n}\n",
)
replace_once(
    protocol,
    "pub enum AuthMethod {\n    OAuth,\n    ApiKey,\n}",
    "pub enum AuthMethod {\n    OAuth,\n    ApiKey,\n    Terminal,\n}",
)
replace_once(
    protocol,
    "pub struct AuthProviderSummary {\n    pub id: String,\n    pub display_name: String,\n    pub methods: Vec<AuthMethod>,\n    pub configured: bool,\n    pub source: Option<String>,\n}\n",
    "pub struct AuthProviderSummary {\n    pub id: String,\n    pub display_name: String,\n    pub methods: Vec<AuthMethod>,\n    pub configured: bool,\n    pub source: Option<String>,\n}\n\n#[derive(Clone, Debug, Eq, PartialEq)]\npub struct ExternalCommand {\n    pub program: String,\n    pub arguments: Vec<String>,\n    pub environment: BTreeMap<String, String>,\n}\n",
)
replace_once(
    protocol,
    "    SessionTree {\n        session_id: SessionId,\n    },\n    SessionExport {",
    "    SessionTree {\n        session_id: SessionId,\n    },\n    SessionModes {\n        run_id: RunId,\n    },\n    SessionModeSelect {\n        run_id: RunId,\n        mode_id: String,\n    },\n    SessionExport {",
)
replace_once(
    protocol,
    "    AuthLoginCancel {\n        flow_id: AuthFlowId,\n    },\n    AuthLogout {",
    "    AuthLoginCancel {\n        flow_id: AuthFlowId,\n    },\n    AuthTerminalFinished {\n        flow_id: AuthFlowId,\n        success: bool,\n        message: Option<String>,\n    },\n    AuthLogout {",
)
replace_once(
    protocol,
    "    SessionTree(PersistedSessionTreeSnapshot),\n    Models(Vec<ModelSummary>),",
    "    SessionTree(PersistedSessionTreeSnapshot),\n    SessionModes(Vec<SessionModeSummary>),\n    Models(Vec<ModelSummary>),",
)
replace_once(
    protocol,
    "    AuthPromptRequested {\n        flow_id: AuthFlowId,",
    "    ExternalCommandRequested {\n        flow_id: AuthFlowId,\n        command: ExternalCommand,\n    },\n    AuthPromptRequested {\n        flow_id: AuthFlowId,",
)

reducer = "rust/crates/phenix-ui-core/src/reducer.rs"
replace_once(
    reducer,
    "pub enum AppEffect {\n    Send(BackendCommand),\n    Render,",
    "pub enum AppEffect {\n    Send(BackendCommand),\n    RunExternal {\n        flow_id: AuthFlowId,\n        command: phenix_runtime_api::ExternalCommand,\n    },\n    Render,",
)
replace_once(
    reducer,
    "        \"thinking\" => {",
    "        \"mode\" => {\n            let Some(run_id) = state.input_target().cloned() else {\n                return no_run_notification(state);\n            };\n            if arguments.is_empty() {\n                vec![AppEffect::Send(BackendCommand::SessionModes { run_id })]\n            } else {\n                vec![AppEffect::Send(BackendCommand::SessionModeSelect {\n                    run_id,\n                    mode_id: arguments.to_owned(),\n                })]\n            }\n        }\n        \"thinking\" => {",
)
replace_once(
    reducer,
    "        BackendReply::Models(models) => state.models = models,",
    "        BackendReply::SessionModes(modes) => state.notifications.push_back(\n            modes.into_iter().map(|mode| {\n                format!(\"{}{}\", if mode.selected { \"* \" } else { \"  \" }, mode.id)\n            }).collect::<Vec<_>>().join(\" · \")\n        ),\n        BackendReply::Models(models) => state.models = models,",
)
replace_once(
    reducer,
    "        BackendOutput::Event(event) => reduce_backend_event(state, event),",
    "        BackendOutput::Event(BackendEvent::ExternalCommandRequested { flow_id, command }) => {\n            return vec![\n                AppEffect::RunExternal { flow_id, command },\n                AppEffect::Render,\n            ];\n        }\n        BackendOutput::Event(event) => reduce_backend_event(state, event),",
)
replace_once(
    reducer,
    "        BackendEvent::AuthPromptRequested { flow_id, prompt } => {",
    "        BackendEvent::ExternalCommandRequested { .. } => unreachable!(\"handled before reducer projection\"),\n        BackendEvent::AuthPromptRequested { flow_id, prompt } => {",
)

runtime = "rust/crates/phenix-ui-runtime/src/runtime.rs"
replace_once(
    runtime,
    "use std::sync::mpsc::{self, Receiver, TryRecvError};",
    "use std::process::Command;\nuse std::sync::atomic::{AtomicBool, Ordering};\nuse std::sync::mpsc::{self, Receiver, TryRecvError};\nuse std::sync::Arc;",
)
replace_once(
    runtime,
    "pub trait UiRenderer {\n    fn render(&mut self, state: &AppState) -> Result<(), String>;\n}",
    "pub trait UiRenderer {\n    fn render(&mut self, state: &AppState) -> Result<(), String>;\n\n    fn suspend(&mut self) -> Result<(), String> {\n        Ok(())\n    }\n\n    fn resume(&mut self) -> Result<(), String> {\n        Ok(())\n    }\n}",
)
replace_once(
    runtime,
    "    drain_limit: usize,\n}",
    "    drain_limit: usize,\n    external_io_pause: Option<Arc<AtomicBool>>,\n}",
)
replace_once(
    runtime,
    "            drain_limit: DEFAULT_DRAIN_LIMIT,\n        })",
    "            drain_limit: DEFAULT_DRAIN_LIMIT,\n            external_io_pause: None,\n        })",
)
replace_once(
    runtime,
    "    pub fn set_drain_limit(&mut self, drain_limit: usize) -> Result<(), UiRuntimeError> {",
    "    pub fn set_external_io_pause(&mut self, pause: Arc<AtomicBool>) {\n        self.external_io_pause = Some(pause);\n    }\n\n    pub fn set_drain_limit(&mut self, drain_limit: usize) -> Result<(), UiRuntimeError> {",
)
replace_once(
    runtime,
    "                AppEffect::Render => dirty = true,",
    "                AppEffect::RunExternal { flow_id, command } => {\n                    if let Some(pause) = &self.external_io_pause {\n                        pause.store(true, Ordering::Release);\n                    }\n                    let result = (|| {\n                        self.renderer.suspend().map_err(UiRuntimeError::Render)?;\n                        let status = Command::new(&command.program)\n                            .args(&command.arguments)\n                            .envs(&command.environment)\n                            .status()\n                            .map_err(|error| UiRuntimeError::Start(error.to_string()));\n                        let resume = self.renderer.resume().map_err(UiRuntimeError::Render);\n                        match (status, resume) {\n                            (Ok(status), Ok(())) => Ok((status.success(), status.code().map(|code| format!(\"exit code {code}\")))),\n                            (Err(error), Ok(())) | (_, Err(error)) => Err(error),\n                        }\n                    })();\n                    if let Some(pause) = &self.external_io_pause {\n                        pause.store(false, Ordering::Release);\n                    }\n                    let command = match result {\n                        Ok((success, message)) => BackendCommand::AuthTerminalFinished { flow_id, success, message },\n                        Err(error) => BackendCommand::AuthTerminalFinished {\n                            flow_id,\n                            success: false,\n                            message: Some(error.to_string()),\n                        },\n                    };\n                    if let Err(error) = self.backend.submit(command) {\n                        effects.extend(reduce(\n                            &mut self.state,\n                            AppEvent::BackendSubmitFailed(error.to_string()),\n                        ));\n                    }\n                    dirty = true;\n                }\n                AppEffect::Render => dirty = true,",
)

renderer = "rust/crates/phenix-tui/src/renderer.rs"
replace_once(
    renderer,
    "            .map_err(|error| error.to_string())\n    }\n}",
    "            .map_err(|error| error.to_string())\n    }\n\n    fn suspend(&mut self) -> Result<(), String> {\n        self.terminal.take();\n        ratatui::restore();\n        Ok(())\n    }\n\n    fn resume(&mut self) -> Result<(), String> {\n        self.terminal = Some(ratatui::try_init().map_err(|error| error.to_string())?);\n        Ok(())\n    }\n}",
)

main = "rust/crates/phenix-tui/src/main.rs"
replace_once(
    main,
    "use std::sync::mpsc::{Receiver, RecvTimeoutError};",
    "use std::sync::atomic::{AtomicBool, Ordering};\nuse std::sync::mpsc::{Receiver, RecvTimeoutError};\nuse std::sync::Arc;",
)
replace_once(
    main,
    "    let runtime = UiRuntime::from_backend_with_frontend(",
    "    let mut runtime = UiRuntime::from_backend_with_frontend(",
)
replace_once(
    main,
    "    let mailbox = runtime.mailbox();\n    let _ticker = runtime.spawn_ticker(Duration::from_millis(250))?;\n    let _input_thread = spawn_terminal_input(mailbox)?;",
    "    let mailbox = runtime.mailbox();\n    let external_io_pause = Arc::new(AtomicBool::new(false));\n    runtime.set_external_io_pause(Arc::clone(&external_io_pause));\n    let _ticker = runtime.spawn_ticker(Duration::from_millis(250))?;\n    let _input_thread = spawn_terminal_input(mailbox, external_io_pause)?;",
)
replace_once(
    main,
    "fn spawn_terminal_input(\n    mailbox: phenix_ui_runtime::UiMailbox,\n) -> Result<thread::JoinHandle<()>, Box<dyn Error>> {",
    "fn spawn_terminal_input(\n    mailbox: phenix_ui_runtime::UiMailbox,\n    external_io_pause: Arc<AtomicBool>,\n) -> Result<thread::JoinHandle<()>, Box<dyn Error>> {",
)
replace_once(
    main,
    "        .spawn(move || loop {\n            match event::poll(INPUT_POLL_PERIOD) {",
    "        .spawn(move || loop {\n            if external_io_pause.load(Ordering::Acquire) {\n                thread::sleep(INPUT_POLL_PERIOD);\n                continue;\n            }\n            match event::poll(INPUT_POLL_PERIOD) {",
)
