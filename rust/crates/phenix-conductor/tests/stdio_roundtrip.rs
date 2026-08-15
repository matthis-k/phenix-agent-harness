use phenix_conductor::ConductorRuntime;
use phenix_runtime_api::{ExecutionTarget, ModelTarget};

#[test]
fn snapshot_is_reconstructible_from_conductor_state() {
    let mut runtime = ConductorRuntime::new();
    let session = runtime
        .create_session(
            None,
            Some("test".to_owned()),
            ExecutionTarget::Fixed {
                model: ModelTarget {
                    backend: "mock".to_owned(),
                    provider: "mock".to_owned(),
                    model: "model".to_owned(),
                },
            },
        )
        .unwrap();
    runtime.submit(&session.id, None, "hello").unwrap();

    let snapshot = runtime.snapshot();
    assert_eq!(snapshot.sessions.len(), 1);
    assert_eq!(snapshot.executions.len(), 1);
    assert!(snapshot.last_event_sequence >= 2);
}
