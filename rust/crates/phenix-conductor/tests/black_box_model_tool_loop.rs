#[test]
fn conductor_has_no_acp_application_dependency() {
    let mut runtime = phenix_conductor::ConductorRuntime::new();
    runtime.mark_ready();
    assert_eq!(format!("{:?}", runtime.health()), "Ready");
}
