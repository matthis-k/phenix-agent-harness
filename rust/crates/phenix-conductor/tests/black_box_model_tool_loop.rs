use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolHostingCapability,
};
use phenix_conductor::{ConductorError, ConductorRuntime};
use phenix_core::{
    BackendId, ExecutionEventKind, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
    ProviderId, RoutingProfileId,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

struct MockBackend {
    opened: Arc<AtomicBool>,
}
struct MockSession;

impl Backend for MockBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_hosting: ToolHostingCapability::Unsupported,
            images: false,
            persistent_sessions: false,
        }
    }
    fn open_session(
        &mut self,
        _request: BackendSessionRequest,
    ) -> Result<Box<dyn BackendSession>, BackendError> {
        self.opened.store(true, Ordering::SeqCst);
        Ok(Box::new(MockSession))
    }
}

impl BackendSession for MockSession {
    fn execute(
        &mut self,
        _request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        host.emit(BackendEvent::ReasoningDelta("think".to_owned()))?;
        host.emit(BackendEvent::ContentDelta("answer".to_owned()))?;
        Ok(())
    }
    fn cancel(&mut self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

fn fixed() -> ExecutionTarget {
    ExecutionTarget::Fixed(ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("model").unwrap(),
        inference: InferenceOptions::default(),
    })
}

#[test]
fn mock_backend_preserves_mixed_event_order() {
    let opened = Arc::new(AtomicBool::new(false));
    let mut backend = MockBackend {
        opened: opened.clone(),
    };
    let mut runtime = ConductorRuntime::new();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let execution = runtime.submit(&session.id, "hello").unwrap();
    runtime
        .drive_execution(&execution.id, &mut backend)
        .unwrap();

    assert!(opened.load(Ordering::SeqCst));
    let events = runtime.events_since(0);
    let reasoning = events
        .iter()
        .position(|e| matches!(e.kind, ExecutionEventKind::ReasoningDelta { .. }))
        .unwrap();
    let content = events
        .iter()
        .position(|e| matches!(e.kind, ExecutionEventKind::AssistantContentDelta { .. }))
        .unwrap();
    assert!(reasoning < content);
    assert!(events
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
}

#[test]
fn routed_execution_fails_before_backend_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let mut backend = MockBackend {
        opened: opened.clone(),
    };
    let mut runtime = ConductorRuntime::new();
    let session = runtime
        .create_session(
            None,
            None,
            ExecutionTarget::Routed(RoutingProfileId::parse("default").unwrap()),
        )
        .unwrap();
    let execution = runtime.submit(&session.id, "hello").unwrap();

    assert_eq!(
        runtime.drive_execution(&execution.id, &mut backend),
        Err(ConductorError::RoutingUnavailable)
    );
    assert!(!opened.load(Ordering::SeqCst));
}
