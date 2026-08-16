#![allow(dead_code)]

use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolInvocation, ToolPresentation, ToolResult,
};
use phenix_conductor::{ConductorRuntime, ConductorServer, RuntimeJournal};
use phenix_core::{
    AuthenticationState, BackendCatalog, BackendId, CallableId, ExecutionEvent, ExecutionId,
    ExecutionState, ExecutionTarget, InferenceOptions, ModelDescriptor, ModelId, ModelTarget,
    ProviderId, SessionId,
};
use phenix_protocol::{
    ClientMessage, Command, Reply, ResponsePayload, RuntimeSnapshot, ServerMessage,
};
use std::collections::BTreeSet;
use std::io::{BufReader, Cursor, Read, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc::{self, Receiver},
    Arc, Condvar, Mutex,
};
use std::thread;

#[derive(Clone, Debug)]
pub enum MockAction {
    Reasoning(String),
    Content(String),
    InvokeTool {
        callable: CallableId,
        arguments_json: String,
    },
    AwaitCancel,
    Fail(String),
}

impl MockAction {
    #[must_use]
    pub fn reasoning(text: impl Into<String>) -> Self {
        Self::Reasoning(text.into())
    }

    #[must_use]
    pub fn content(text: impl Into<String>) -> Self {
        Self::Content(text.into())
    }

    #[must_use]
    pub fn tool(callable: impl AsRef<str>, arguments_json: impl Into<String>) -> Self {
        Self::InvokeTool {
            callable: CallableId::parse(callable.as_ref()).expect("valid fixture callable id"),
            arguments_json: arguments_json.into(),
        }
    }

    #[must_use]
    pub fn await_cancel() -> Self {
        Self::AwaitCancel
    }

    #[must_use]
    pub fn fail(message: impl Into<String>) -> Self {
        Self::Fail(message.into())
    }
}

#[derive(Clone, Debug)]
pub struct MockModelScript {
    actions: Vec<MockAction>,
}

impl MockModelScript {
    #[must_use]
    pub fn sequence(actions: impl IntoIterator<Item = MockAction>) -> Self {
        Self {
            actions: actions.into_iter().collect(),
        }
    }

    #[must_use]
    pub fn reply(content: impl Into<String>) -> Self {
        Self::sequence([MockAction::content(content)])
    }

    #[must_use]
    pub fn reasoning_then_reply(
        reasoning: impl IntoIterator<Item = impl Into<String>>,
        content: impl Into<String>,
    ) -> Self {
        let mut actions = reasoning
            .into_iter()
            .map(|text| MockAction::reasoning(text.into()))
            .collect::<Vec<_>>();
        actions.push(MockAction::content(content));
        Self::sequence(actions)
    }

    #[must_use]
    pub fn tool(
        callable: impl AsRef<str>,
        arguments_json: impl Into<String>,
        content_after: impl Into<String>,
    ) -> Self {
        Self::sequence([
            MockAction::tool(callable, arguments_json),
            MockAction::content(content_after),
        ])
    }

    #[must_use]
    pub fn fail(message: impl Into<String>) -> Self {
        Self::sequence([MockAction::fail(message)])
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObservedAction {
    Reasoning(String),
    Content(String),
    InvokeTool(CallableId),
    AwaitCancel,
    Fail(String),
}

impl From<&MockAction> for ObservedAction {
    fn from(value: &MockAction) -> Self {
        match value {
            MockAction::Reasoning(text) => Self::Reasoning(text.clone()),
            MockAction::Content(text) => Self::Content(text.clone()),
            MockAction::InvokeTool { callable, .. } => Self::InvokeTool(callable.clone()),
            MockAction::AwaitCancel => Self::AwaitCancel,
            MockAction::Fail(message) => Self::Fail(message.clone()),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservedOpen {
    pub model: ModelTarget,
    pub tool_presentation: Option<ToolPresentation>,
    pub tool_ids: Vec<CallableId>,
}

#[derive(Debug, Default)]
pub struct MockBackendState {
    opened: AtomicUsize,
    executed: AtomicUsize,
    cancelled: AtomicUsize,
    opens: Mutex<Vec<ObservedOpen>>,
    prompts: Mutex<Vec<String>>,
    tool_results: Mutex<Vec<ToolResult>>,
    actions: Mutex<Vec<ObservedAction>>,
    action_changed: Condvar,
}

impl MockBackendState {
    #[must_use]
    pub fn opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn executed(&self) -> usize {
        self.executed.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn cancelled(&self) -> usize {
        self.cancelled.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn prompts(&self) -> Vec<String> {
        self.prompts.lock().unwrap().clone()
    }

    #[must_use]
    pub fn opens(&self) -> Vec<ObservedOpen> {
        self.opens.lock().unwrap().clone()
    }

    #[must_use]
    pub fn tool_results(&self) -> Vec<ToolResult> {
        self.tool_results.lock().unwrap().clone()
    }

    #[must_use]
    pub fn actions(&self) -> Vec<ObservedAction> {
        self.actions.lock().unwrap().clone()
    }

    fn record_action(&self, action: ObservedAction) {
        self.actions.lock().unwrap().push(action);
        self.action_changed.notify_all();
    }

    fn wait_for_action(&self, index: usize) {
        let mut actions = self.actions.lock().unwrap();
        while actions.len() < index {
            actions = self.action_changed.wait(actions).unwrap();
        }
    }
}

#[derive(Debug, Default)]
pub struct ProtocolSignal {
    signaled: Mutex<bool>,
    changed: Condvar,
}

impl ProtocolSignal {
    pub fn signal(&self) {
        *self.signaled.lock().unwrap() = true;
        self.changed.notify_all();
    }

    pub fn wait(&self) {
        let mut signaled = self.signaled.lock().unwrap();
        while !*signaled {
            signaled = self.changed.wait(signaled).unwrap();
        }
    }
}

#[derive(Default)]
struct CancelGate {
    cancelled: Mutex<bool>,
    changed: Condvar,
}

impl CancelGate {
    fn cancel(&self) {
        *self.cancelled.lock().unwrap() = true;
        self.changed.notify_all();
    }

    fn wait(&self) {
        let mut cancelled = self.cancelled.lock().unwrap();
        while !*cancelled {
            cancelled = self.changed.wait(cancelled).unwrap();
        }
    }
}

pub struct MockBackend {
    state: Arc<MockBackendState>,
    script: MockModelScript,
    tool_presentations: BTreeSet<ToolPresentation>,
}

impl MockBackend {
    #[must_use]
    pub fn new(state: Arc<MockBackendState>, script: MockModelScript) -> Self {
        Self {
            state,
            script,
            tool_presentations: BTreeSet::new(),
        }
    }

    #[must_use]
    pub fn with_tool_presentations(
        mut self,
        presentations: impl IntoIterator<Item = ToolPresentation>,
    ) -> Self {
        self.tool_presentations = presentations.into_iter().collect();
        self
    }
}

impl Backend for MockBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: self.tool_presentations.clone(),
            images: false,
            persistent_sessions: false,
        }
    }

    fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
        Ok(BackendCatalog {
            backend: backend_id(),
            models: vec![ModelDescriptor {
                target: model_target("mock-model"),
                name: "Mock Model".to_owned(),
            }],
            authentication_state: AuthenticationState::NotRequired,
            authentication_methods: Vec::new(),
        })
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        self.state.opened.fetch_add(1, Ordering::SeqCst);
        self.state.opens.lock().unwrap().push(ObservedOpen {
            model: request.model,
            tool_presentation: request.tools.presentation(),
            tool_ids: request
                .tools
                .callables()
                .iter()
                .map(|descriptor| descriptor.id.clone())
                .collect(),
        });
        Ok(Arc::new(MockSession {
            state: self.state.clone(),
            script: self.script.clone(),
            cancel_gate: Arc::new(CancelGate::default()),
        }))
    }
}

struct MockSession {
    state: Arc<MockBackendState>,
    script: MockModelScript,
    cancel_gate: Arc<CancelGate>,
}

impl BackendSession for MockSession {
    fn execute(
        &self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        self.state.executed.fetch_add(1, Ordering::SeqCst);
        self.state.prompts.lock().unwrap().push(request.prompt);
        for action in &self.script.actions {
            self.state.record_action(action.into());
            match action {
                MockAction::Reasoning(text) => {
                    host.emit(BackendEvent::ReasoningDelta(text.clone()))?;
                }
                MockAction::Content(text) => {
                    host.emit(BackendEvent::ContentDelta(text.clone()))?;
                }
                MockAction::InvokeTool {
                    callable,
                    arguments_json,
                } => {
                    let result = host.invoke_tool(ToolInvocation {
                        callable: callable.clone(),
                        arguments_json: arguments_json.clone(),
                    })?;
                    self.state.tool_results.lock().unwrap().push(result);
                }
                MockAction::AwaitCancel => self.cancel_gate.wait(),
                MockAction::Fail(message) => return Err(BackendError::Protocol(message.clone())),
            }
        }
        Ok(())
    }

    fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), BackendError> {
        self.state.cancelled.fetch_add(1, Ordering::SeqCst);
        self.cancel_gate.cancel();
        Ok(())
    }
}

#[derive(Clone, Default)]
struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct ChannelInput {
    receiver: Receiver<Vec<u8>>,
    current: Cursor<Vec<u8>>,
}

impl ChannelInput {
    fn new(receiver: Receiver<Vec<u8>>) -> Self {
        Self {
            receiver,
            current: Cursor::new(Vec::new()),
        }
    }
}

impl Read for ChannelInput {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let read = self.current.read(buffer)?;
            if read > 0 {
                return Ok(read);
            }
            match self.receiver.recv() {
                Ok(bytes) => self.current = Cursor::new(bytes),
                Err(_) => return Ok(0),
            }
        }
    }
}

enum DeferredTrigger {
    BackendAction(usize),
    Signal(Arc<ProtocolSignal>),
}

struct DeferredCommand {
    trigger: DeferredTrigger,
    message: ClientMessage,
}

pub struct ProtocolHarness {
    runtime: ConductorRuntime,
    script: MockModelScript,
    tool_presentations: BTreeSet<ToolPresentation>,
    commands: Vec<ClientMessage>,
    deferred_commands: Vec<DeferredCommand>,
    next_request_id: u64,
}

impl ProtocolHarness {
    #[must_use]
    pub fn model(script: MockModelScript) -> Self {
        Self {
            runtime: ConductorRuntime::new(),
            script,
            tool_presentations: BTreeSet::new(),
            commands: Vec::new(),
            deferred_commands: Vec::new(),
            next_request_id: 1,
        }
    }

    #[must_use]
    pub fn runtime(mut self, runtime: ConductorRuntime) -> Self {
        self.runtime = runtime;
        self
    }

    #[must_use]
    pub fn configure_runtime(mut self, configure: impl FnOnce(&mut ConductorRuntime)) -> Self {
        configure(&mut self.runtime);
        self
    }

    #[must_use]
    pub fn with_tool_presentations(
        mut self,
        presentations: impl IntoIterator<Item = ToolPresentation>,
    ) -> Self {
        self.tool_presentations = presentations.into_iter().collect();
        self
    }

    #[must_use]
    pub fn input(mut self, text: impl Into<String>) -> Self {
        self.push(Command::Initialize {
            after_sequence: Some(0),
        });
        self.push(Command::CreateSession {
            parent_session: None,
            name: Some("e2e".to_owned()),
            target: ExecutionTarget::Fixed(model_target("mock-model")),
        });
        self.push(Command::Submit {
            session_id: SessionId::parse("session-1").expect("fixture session id"),
            text: text.into(),
        });
        self
    }

    #[must_use]
    pub fn command(mut self, command: Command) -> Self {
        self.push(command);
        self
    }

    #[must_use]
    pub fn commands(mut self, commands: impl IntoIterator<Item = Command>) -> Self {
        for command in commands {
            self.push(command);
        }
        self
    }

    #[must_use]
    pub fn after_action(mut self, action_index: usize, command: Command) -> Self {
        assert!(action_index > 0, "backend action indices are 1-based");
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.deferred_commands.push(DeferredCommand {
            trigger: DeferredTrigger::BackendAction(action_index),
            message: ClientMessage { id, command },
        });
        self
    }

    #[must_use]
    pub fn after_signal(mut self, signal: Arc<ProtocolSignal>, command: Command) -> Self {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.deferred_commands.push(DeferredCommand {
            trigger: DeferredTrigger::Signal(signal),
            message: ClientMessage { id, command },
        });
        self
    }

    #[must_use]
    pub fn raw_message(mut self, message: ClientMessage) -> Self {
        self.next_request_id = self.next_request_id.max(message.id + 1);
        self.commands.push(message);
        self
    }

    fn push(&mut self, command: Command) {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.commands.push(ClientMessage { id, command });
    }

    #[must_use]
    pub fn run(self) -> ProtocolRun {
        let state = Arc::new(MockBackendState::default());
        let backend = MockBackend::new(state.clone(), self.script)
            .with_tool_presentations(self.tool_presentations);
        run_protocol(
            self.runtime,
            backend,
            state,
            self.commands,
            self.deferred_commands,
        )
    }
}

pub struct ProtocolRun {
    pub messages: Vec<ServerMessage>,
    pub snapshot: RuntimeSnapshot,
    pub journal: RuntimeJournal,
    pub backend: Arc<MockBackendState>,
}

impl ProtocolRun {
    #[must_use]
    pub fn response_ok(&self, id: u64) -> bool {
        self.messages.iter().any(|message| {
            matches!(
                message,
                ServerMessage::Response {
                    id: response_id,
                    response: ResponsePayload::Ok { .. },
                } if *response_id == id
            )
        })
    }

    #[must_use]
    pub fn reply(&self, id: u64) -> Option<&Reply> {
        self.messages.iter().find_map(|message| match message {
            ServerMessage::Response {
                id: response_id,
                response: ResponsePayload::Ok { result },
            } if *response_id == id => Some(result),
            _ => None,
        })
    }

    pub fn events(&self) -> impl Iterator<Item = &ExecutionEvent> {
        self.messages.iter().filter_map(|message| match message {
            ServerMessage::Event { event } => Some(event),
            _ => None,
        })
    }

    #[must_use]
    pub fn has_event(&self, predicate: impl Fn(&ExecutionEvent) -> bool) -> bool {
        self.events().any(predicate)
    }

    #[must_use]
    pub fn execution_state(&self, index: usize) -> Option<&ExecutionState> {
        self.snapshot
            .executions
            .get(index)
            .map(|execution| &execution.state)
    }

    #[must_use]
    pub fn only_execution_state(&self) -> Option<&ExecutionState> {
        (self.snapshot.executions.len() == 1).then(|| &self.snapshot.executions[0].state)
    }
}

fn run_protocol(
    runtime: ConductorRuntime,
    backend: MockBackend,
    state: Arc<MockBackendState>,
    commands: Vec<ClientMessage>,
    deferred_commands: Vec<DeferredCommand>,
) -> ProtocolRun {
    let writer = SharedWriter::default();
    let captured = writer.0.clone();
    let mut server = ConductorServer::new(runtime);
    server
        .register_backend(backend_id(), Box::new(backend))
        .unwrap();

    let (input_sender, input_receiver) = mpsc::channel::<Vec<u8>>();
    let feeder_state = state.clone();
    let feeder = thread::spawn(move || {
        if !commands.is_empty() {
            input_sender.send(encode_messages(commands)).unwrap();
        }
        for deferred in deferred_commands {
            match deferred.trigger {
                DeferredTrigger::BackendAction(index) => feeder_state.wait_for_action(index),
                DeferredTrigger::Signal(signal) => signal.wait(),
            }
            input_sender
                .send(encode_messages([deferred.message]))
                .unwrap();
        }
    });

    server
        .serve_ndjson(BufReader::new(ChannelInput::new(input_receiver)), writer)
        .unwrap();
    feeder.join().unwrap();

    let runtime = server.runtime();
    let snapshot = runtime.snapshot();
    let journal = runtime.journal().clone();
    drop(runtime);
    let messages = String::from_utf8(captured.lock().unwrap().clone())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<ServerMessage>(line).unwrap())
        .collect();
    ProtocolRun {
        messages,
        snapshot,
        journal,
        backend: state,
    }
}

fn encode_messages(messages: impl IntoIterator<Item = ClientMessage>) -> Vec<u8> {
    messages
        .into_iter()
        .map(|message| format!("{}\n", serde_json::to_string(&message).unwrap()))
        .collect::<String>()
        .into_bytes()
}

#[must_use]
pub fn backend_id() -> BackendId {
    BackendId::parse("mock").unwrap()
}

#[must_use]
pub fn model_target(name: &str) -> ModelTarget {
    ModelTarget {
        backend: backend_id(),
        provider: ProviderId::parse("mock-provider").unwrap(),
        model: ModelId::parse(name).unwrap(),
        inference: InferenceOptions::default(),
    }
}

#[must_use]
pub fn execution_id(index: u64) -> ExecutionId {
    ExecutionId::parse(format!("execution-{index}")).expect("fixture execution id")
}
