const ACP_CONFIG: &str = include_str!("../src/acp_config.rs");
const MAIN: &str = include_str!("../src/main.rs");

#[test]
fn frontend_emits_sources_without_constructing_the_phenix_runtime() {
    for forbidden in [
        "PhenixAcpGateway",
        "PhenixAcpGatewayBuilder",
        "GatewayAgentBackend",
        "Definitions::new",
        "SessionTreeDefinition::builder",
        "AcpAgentBackend::gateway_transport",
    ] {
        assert!(
            !ACP_CONFIG.contains(forbidden) && !MAIN.contains(forbidden),
            "native frontend must not own or construct ACP runtime state: found {forbidden}"
        );
    }

    assert!(ACP_CONFIG.contains("ConfigurationSource::Path"));
    assert!(ACP_CONFIG.contains("ConfigurationSource::Inline"));
    assert!(ACP_CONFIG.contains("ConfigurationApplyParams"));
    assert!(MAIN.contains("AcpAgentBackend"));
}

#[test]
fn frontend_configuration_is_described_as_authoring_input() {
    assert!(MAIN.contains("authoring directory"));
    assert!(!MAIN.contains("frontend tree is configured for backend"));
}
