#[test]
fn purge_keeps_a_constructible_runtime_spine() {
    let runtime = phenix_conductor::ConductorRuntime::new();
    assert_eq!(format!("{:?}", runtime.health()), "Starting");
}
