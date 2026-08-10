use crate::{UiRenderer, UiRuntime, UiRuntimeError};
use phenix_frontend_config::FrontendProviderRef;
use phenix_runtime_api::{
    AgentBackend, BackendCommand, BackendError, BackendOutputSender, BackendReply, BackendRequest,
    BackendRuntime,
};
use phenix_ui_core::{AppState, UiInput};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread;

const SCENARIO_CAPACITY: usize = 128;

struct FrontendScenario {
    state: AppState,
    provider: FrontendProviderRef,
    inputs: Vec<UiInput>,
}

impl FrontendScenario {
    fn new(provider: FrontendProviderRef) -> Self {
        Self {
            state: AppState::default(),
            provider,
            inputs: Vec::new(),
        }
    }

    fn with_state(mut self, state: AppState) -> Self {
        self.state = state;
        self
    }

    fn input(mut self, input: UiInput) -> Self {
        self.inputs.push(input);
        self
    }

    fn run(self) -> Result<Vec<BackendCommand>, FrontendScenarioError> {
        let commands = Arc::new(Mutex::new(Vec::new()));
        let backend = BackendRuntime::spawn(
            Box::new(RecordingBackend {
                commands: Arc::clone(&commands),
            }),
            SCENARIO_CAPACITY,
        )
        .map_err(|error| FrontendScenarioError::Backend(error.to_string()))?;
        let runtime = UiRuntime::from_backend_with_frontend(
            self.state,
            backend,
            RecordingRenderer,
            self.provider,
            SCENARIO_CAPACITY,
        )
        .map_err(FrontendScenarioError::Runtime)?;
        let mailbox = runtime.mailbox();
        let producer = thread::Builder::new()
            .name("phenix-frontend-scenario".to_owned())
            .spawn(move || {
                for input in self.inputs {
                    if mailbox.send_input(input).is_err() {
                        return;
                    }
                }
                let _ = mailbox.shutdown();
            })
            .map_err(|error| FrontendScenarioError::Producer(error.to_string()))?;
        runtime.run().map_err(FrontendScenarioError::Runtime)?;
        producer.join().map_err(|_| {
            FrontendScenarioError::Producer("scenario producer panicked".to_owned())
        })?;

        Arc::try_unwrap(commands)
            .map_err(|_| {
                FrontendScenarioError::Capture("backend command recorder is shared".to_owned())
            })?
            .into_inner()
            .map_err(|_| {
                FrontendScenarioError::Capture("backend command recorder is poisoned".to_owned())
            })
    }
}

struct RecordingBackend {
    commands: Arc<Mutex<Vec<BackendCommand>>>,
}

impl AgentBackend for RecordingBackend {
    fn run(
        self: Box<Self>,
        requests: Receiver<BackendRequest>,
        outputs: BackendOutputSender,
    ) -> Result<(), BackendError> {
        for request in requests {
            let shutdown = matches!(&request.command, BackendCommand::Shutdown);
            self.commands
                .lock()
                .map_err(|_| {
                    BackendError::Protocol("scenario command recorder is poisoned".to_owned())
                })?
                .push(request.command);
            outputs.reply(
                request.id,
                Ok(if shutdown {
                    BackendReply::Completed
                } else {
                    BackendReply::Accepted
                }),
            )?;
            if shutdown {
                return Ok(());
            }
        }
        Ok(())
    }
}

struct RecordingRenderer;

impl UiRenderer for RecordingRenderer {
    fn render(&mut self, _state: &AppState) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug)]
enum FrontendScenarioError {
    Backend(String),
    Runtime(UiRuntimeError),
    Producer(String),
    Capture(String),
}

impl Display for FrontendScenarioError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Backend(message) => write!(formatter, "scenario backend failed: {message}"),
            Self::Runtime(error) => Display::fmt(error, formatter),
            Self::Producer(message) => write!(formatter, "scenario producer failed: {message}"),
            Self::Capture(message) => write!(formatter, "scenario capture failed: {message}"),
        }
    }
}

impl Error for FrontendScenarioError {}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_ui_core::{KeyCode, KeyInput, KeyModifiers};
    use phenix_ui_lua::{LuaFrontendOptions, LuaFrontendProvider};
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn configured_authentication_keymap_emits_the_authentication_action() {
        let provider: FrontendProviderRef = Rc::new(RefCell::new(
            LuaFrontendProvider::new(LuaFrontendOptions::default()).expect("Lua provider"),
        ));
        let commands = FrontendScenario::new(provider)
            .with_state(sidebar_state())
            .input(key(' ', false, false, false))
            .input(key('f', false, false, false))
            .input(key('a', false, false, false))
            .run()
            .expect("scenario");
        assert!(commands
            .iter()
            .any(|command| matches!(command, BackendCommand::AuthProviders)));
    }

    fn sidebar_state() -> AppState {
        let mut state = AppState::default();
        state.view.focus = phenix_ui_core::FocusTarget::Sidebar;
        state
    }

    fn key(character: char, control: bool, alt: bool, shift: bool) -> UiInput {
        UiInput::Key(KeyInput {
            code: KeyCode::Character(character),
            modifiers: KeyModifiers {
                control,
                alt,
                shift,
            },
            repeat: false,
        })
    }
}
