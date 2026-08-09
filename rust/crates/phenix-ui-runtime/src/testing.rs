use crate::{UiRenderer, UiRuntime, UiRuntimeError};
use phenix_frontend_config::FrontendProviderRef;
use phenix_runtime_api::{
    AgentBackend, BackendCommand, BackendError, BackendOutputSender, BackendReply, BackendRequest,
    BackendRuntime,
};
use phenix_ui_core::{AppState, EventEnvelope, UiInput, UserIntent};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::thread;

const SCENARIO_CAPACITY: usize = 128;

#[derive(Debug, Eq, PartialEq)]
pub enum FrontendScenarioStep {
    Input(UiInput),
    Ui(EventEnvelope<crate::UiEvent>),
    User(UserIntent),
}

pub struct FrontendScenario {
    state: AppState,
    provider: FrontendProviderRef,
    steps: Vec<FrontendScenarioStep>,
}

impl FrontendScenario {
    pub fn new(provider: FrontendProviderRef) -> Self {
        Self {
            state: AppState::default(),
            provider,
            steps: Vec::new(),
        }
    }

    pub fn with_state(mut self, state: AppState) -> Self {
        self.state = state;
        self
    }

    pub fn input(mut self, input: UiInput) -> Self {
        self.steps.push(FrontendScenarioStep::Input(input));
        self
    }

    pub fn ui(mut self, event: EventEnvelope<crate::UiEvent>) -> Self {
        self.steps.push(FrontendScenarioStep::Ui(event));
        self
    }

    pub fn user(mut self, intent: UserIntent) -> Self {
        self.steps.push(FrontendScenarioStep::User(intent));
        self
    }

    pub fn run(self) -> Result<FrontendScenarioResult, FrontendScenarioError> {
        let commands = Arc::new(Mutex::new(Vec::new()));
        let backend = BackendRuntime::spawn(
            Box::new(RecordingBackend {
                commands: Arc::clone(&commands),
            }),
            SCENARIO_CAPACITY,
        )
        .map_err(|error| FrontendScenarioError::Backend(error.to_string()))?;
        let rendered_states = Arc::new(Mutex::new(Vec::new()));
        let renderer = RecordingRenderer {
            states: Arc::clone(&rendered_states),
        };
        let runtime = UiRuntime::from_backend_with_frontend(
            self.state,
            backend,
            renderer,
            self.provider,
            SCENARIO_CAPACITY,
        )
        .map_err(FrontendScenarioError::Runtime)?;
        let mailbox = runtime.mailbox();
        let producer = thread::Builder::new()
            .name("phenix-frontend-scenario".to_owned())
            .spawn(move || {
                for step in self.steps {
                    let result = match step {
                        FrontendScenarioStep::Input(input) => mailbox.send_input(input),
                        FrontendScenarioStep::Ui(event) => mailbox.send_ui(event),
                        FrontendScenarioStep::User(intent) => mailbox.send_user(intent),
                    };
                    if result.is_err() {
                        return;
                    }
                }
                let _ = mailbox.shutdown();
            })
            .map_err(|error| FrontendScenarioError::Producer(error.to_string()))?;
        let state = runtime.run().map_err(FrontendScenarioError::Runtime)?;
        producer.join().map_err(|_| {
            FrontendScenarioError::Producer("scenario producer panicked".to_owned())
        })?;

        let commands = Arc::try_unwrap(commands)
            .map_err(|_| {
                FrontendScenarioError::Capture("backend command recorder is shared".to_owned())
            })?
            .into_inner()
            .map_err(|_| {
                FrontendScenarioError::Capture("backend command recorder is poisoned".to_owned())
            })?;
        let rendered_states = Arc::try_unwrap(rendered_states)
            .map_err(|_| FrontendScenarioError::Capture("renderer recorder is shared".to_owned()))?
            .into_inner()
            .map_err(|_| {
                FrontendScenarioError::Capture("renderer recorder is poisoned".to_owned())
            })?;

        Ok(FrontendScenarioResult {
            state,
            commands,
            rendered_states,
        })
    }
}

pub struct FrontendScenarioResult {
    pub state: AppState,
    pub commands: Vec<BackendCommand>,
    pub rendered_states: Vec<AppState>,
}

impl FrontendScenarioResult {
    pub fn emitted(&self, predicate: impl Fn(&BackendCommand) -> bool) -> bool {
        self.commands.iter().any(predicate)
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

struct RecordingRenderer {
    states: Arc<Mutex<Vec<AppState>>>,
}

impl UiRenderer for RecordingRenderer {
    fn render(&mut self, state: &AppState) -> Result<(), String> {
        self.states
            .lock()
            .map_err(|_| "renderer recorder is poisoned".to_owned())?
            .push(state.clone());
        Ok(())
    }
}

#[derive(Debug)]
pub enum FrontendScenarioError {
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
        let result = FrontendScenario::new(provider)
            .with_state(sidebar_state())
            .input(key(' ', false, false, false))
            .input(key('f', false, false, false))
            .input(key('a', false, false, false))
            .run()
            .expect("scenario");
        assert!(result.emitted(|command| matches!(command, BackendCommand::AuthProviders)));
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
