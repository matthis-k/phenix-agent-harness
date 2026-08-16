#[test]
fn runtime_starts_with_an_empty_reconstructible_snapshot() {
    let runtime = phenix_conductor::ConductorRuntime::new();
    let snapshot = runtime.snapshot();
    assert!(snapshot.sessions.is_empty());
    assert!(snapshot.executions.is_empty());
    assert_eq!(snapshot.last_event_sequence, 0);
}
