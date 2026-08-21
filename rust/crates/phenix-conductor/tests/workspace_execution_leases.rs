use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    AgentDefinition, BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy,
    CapabilitySet, ExecutionAuthority, ExecutionState, ExecutionTarget, FilesystemAuthority,
    InferenceOptions, ModelId, ModelTarget, ProviderId, SessionId,
};
use phenix_protocol::{ClientMessage, Command};
use serde_json::json;
use std::collections::BTreeSet;
use std::io::Cursor;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Default)]
struct DispatchState {
    entered: usize,
    active: usize,
    overlapped: bool,
    release_first: bool,
}

type DispatchGate = Arc<(Mutex<DispatchState>, Condvar)>;

struct BlockingWriterBackend {
    gate: DispatchGate,
}

struct BlockingWriterSession {
    gate: DispatchGate,
}

impl Backend for BlockingWriterBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::new(),
            images: false,
            persistent_sessions: false,
        }
    }

    fn open_session(
        &mut self,
        _request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        Ok(Arc::new(BlockingWriterSession {
            gate: self.gate.clone(),
        }))
    }
}

impl BackendSession for BlockingWriterSession {
    fn execute(
        &self,
        _request: BackendExecutionRequest,
        _host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        let (lock, ready) = &*self.gate;
        let mut state = lock
            .lock()
            .map_err(|_| BackendError::Transport("dispatch gate lock poisoned".to_owned()))?;
        state.entered += 1;
        state.active += 1;
        state.overlapped |= state.active > 1;
        let first = state.entered == 1;
        ready.notify_all();

        if first {
            state = ready
                .wait_while(state, |state| !state.release_first)
                .map_err(|_| BackendError::Transport("dispatch gate lock poisoned".to_owned()))?;
        }

        state.active -= 1;
        ready.notify_all();
        Ok(())
    }

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

fn model_target() -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("fixture").unwrap(),
        provider: ProviderId::parse("fixture").unwrap(),
        model: ModelId::parse("fixture-model").unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn writer_agent() -> AgentDefinition {
    let descriptor = CallableDescriptor {
        id: CallableId::parse("agent.writer").unwrap(),
        kind: CallableKind::Agent,
        description: "writer authority fixture".to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    };
    let mut authority = ExecutionAuthority::read_only();
    authority.filesystem = FilesystemAuthority::Write;
    AgentDefinition::new(descriptor, authority)
}

fn encode(commands: impl IntoIterator<Item = Command>) -> String {
    let mut input = commands
        .into_iter()
        .enumerate()
        .map(|(index, command)| {
            serde_json::to_string(&ClientMessage {
                id: index as u64 + 1,
                command,
            })
            .unwrap()
        })
        .collect::<Vec<_>>()
        .join("\n");
    input.push('\n');
    input
}

#[test]
fn writer_executions_on_one_workspace_do_not_overlap_backend_dispatch() {
    let gate = Arc::new((Mutex::new(DispatchState::default()), Condvar::new()));
    let mut runtime = ConductorRuntime::new();
    runtime.register_agent(writer_agent()).unwrap();
    let mut server = ConductorServer::new(runtime);
    server
        .register_backend(
            BackendId::parse("fixture").unwrap(),
            Box::new(BlockingWriterBackend { gate: gate.clone() }),
        )
        .unwrap();

    let target = ExecutionTarget::Fixed(model_target());
    let input = encode([
        Command::CreateSession {
            parent_session: None,
            name: Some("first".to_owned()),
            target: target.clone(),
        },
        Command::CreateSession {
            parent_session: None,
            name: Some("second".to_owned()),
            target,
        },
        Command::Submit {
            session_id: SessionId::parse("session-1").unwrap(),
            text: "first write".to_owned(),
        },
        Command::Submit {
            session_id: SessionId::parse("session-2").unwrap(),
            text: "second write".to_owned(),
        },
    ]);

    let worker = thread::spawn(move || {
        server
            .serve_ndjson(Cursor::new(input), std::io::sink())
            .unwrap();
        let snapshot = server.runtime().snapshot();
        snapshot
    });

    let (lock, ready) = &*gate;
    let state = lock.lock().unwrap();
    let (state, _) = ready
        .wait_timeout_while(state, Duration::from_secs(1), |state| state.entered == 0)
        .unwrap();
    assert_eq!(
        state.entered, 1,
        "first writer never reached backend dispatch"
    );

    let (mut state, _) = ready
        .wait_timeout_while(state, Duration::from_millis(500), |state| state.entered < 2)
        .unwrap();
    assert_eq!(
        state.entered, 1,
        "second writer reached backend while the first writer still held its workspace lease"
    );
    assert!(!state.overlapped);
    state.release_first = true;
    ready.notify_all();
    drop(state);

    let snapshot = worker.join().unwrap();
    let state = lock.lock().unwrap();
    assert_eq!(state.entered, 2);
    assert!(!state.overlapped);
    assert_eq!(snapshot.executions.len(), 2);
    assert!(
        snapshot
            .executions
            .iter()
            .all(|execution| execution.state == ExecutionState::Completed),
        "writer execution states: {:?}",
        snapshot.executions
    );
}
