const ACP_CONFIG: &str = include_str!("../src/acp_config.rs");
const MAIN: &str = include_str!("../src/main.rs");

#[test]
fn frontend_emits_wire_configuration_without_constructing_the_phenix_runtime() {
    for forbidden_construct in [
        "PhenixAcpGateway::",
        "PhenixAcpGatewayBuilder::",
        "GatewayAgentBackend::",
        "Definitions::new(",
        "SessionTreeDefinition::builder(",
        "AcpAgentBackend::gateway_transport(",
        "PHENIX_CONFIGURATION_FILE",
        "write_configuration_request",
    ] {
        assert!(
            !ACP_CONFIG.contains(forbidden_construct) && !MAIN.contains(forbidden_construct),
            "native frontend must not own or bootstrap ACP runtime state out of band: found {forbidden_construct}"
        );
    }

    assert!(ACP_CONFIG.contains("ConfigurationSource::Path"));
    assert!(ACP_CONFIG.contains("ConfigurationSource::Inline"));
    assert!(ACP_CONFIG.contains("ConfigurationApplyParams"));
    assert!(ACP_CONFIG.contains("encode_extension_request::<ConfigurationApply>"));
    assert!(ACP_CONFIG.contains("with_startup_request"));
    assert!(MAIN.contains("AcpAgentBackend"));
}

#[test]
fn frontend_configuration_is_described_as_authoring_input() {
    assert!(MAIN.contains("authoring directory"));
    assert!(!MAIN.contains("frontend tree is configured for backend"));
}
