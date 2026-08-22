use super::*;
use phenix_core::{
    AgentDefinition, BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy,
    CapabilitySet, ExecutionAuthority, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
    ProviderId, RoutingProfileId,
};

fn model(name: &str) -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse(name).unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn routed_configuration(profile: &RoutingProfileId, name: &str) -> CompiledConfiguration {
    let mut configuration = CompiledConfiguration::default();
    configuration
        .register_routing_profile(RoutingProfile {
            id: profile.clone(),
            default_target: model(name),
            callable_targets: BTreeMap::new(),
        })
        .unwrap();
    configuration
}

fn agent_configuration(
    profile: &RoutingProfileId,
    name: &str,
) -> (CompiledConfiguration, CallableId) {
    let mut configuration = routed_configuration(profile, name);
    let callable = CallableId::parse("worker").unwrap();
    configuration
        .register_agent(AgentDefinition {
            descriptor: CallableDescriptor {
                id: callable.clone(),
                description: "worker".to_owned(),
                kind: CallableKind::Agent,
                input_schema: serde_json::json!({"type": "object"}),
                output_schema: serde_json::json!({"type": "object"}),
                capabilities: CapabilitySet::default(),
                policy: CallablePolicy::default(),
            },
            authority: ExecutionAuthority::read_only(),
        })
        .unwrap();
    (configuration, callable)
}

#[test]
fn session_rebase_only_changes_future_root_execution_semantics() {
    let mut runtime = ConductorRuntime::new();
    let profile = RoutingProfileId::parse("route").unwrap();
    let first_revision = runtime
        .reload_configuration(routed_configuration(&profile, "first"))
        .unwrap();
    let session = runtime
        .create_session(None, None, ExecutionTarget::Routed(profile.clone()))
        .unwrap();
    let first = runtime.submit(&session.id, "first").unwrap();

    let second_revision = runtime
        .reload_configuration(routed_configuration(&profile, "second"))
        .unwrap();
    runtime
        .rebase_session(&session.id, &second_revision)
        .unwrap();
    let second = runtime.submit(&session.id, "second").unwrap();

    assert_eq!(
        runtime.execution_config_revision(&first.id).unwrap(),
        first_revision
    );
    assert_eq!(
        runtime.execution_config_revision(&second.id).unwrap(),
        second_revision
    );
    assert_eq!(
        runtime.resolve_invocation(&first.id).unwrap().model,
        model("first")
    );
    assert_eq!(
        runtime.resolve_invocation(&second.id).unwrap().model,
        model("second")
    );
}

#[test]
fn descendants_inherit_parent_revision_after_session_rebase() {
    let mut runtime = ConductorRuntime::new();
    let profile = RoutingProfileId::parse("route").unwrap();
    let (first_configuration, callable) = agent_configuration(&profile, "first");
    let first_revision = runtime
        .reload_configuration(first_configuration.clone())
        .unwrap();
    let session = runtime
        .create_session(None, None, ExecutionTarget::Routed(profile.clone()))
        .unwrap();
    let parent = runtime.submit(&session.id, "parent").unwrap();

    let second_revision = runtime.reload_configuration(first_configuration).unwrap();
    runtime
        .rebase_session(&session.id, &second_revision)
        .unwrap();
    let child = runtime.start_agent(&parent.id, &callable, "child").unwrap();

    assert_eq!(
        runtime.execution_config_revision(&parent.id).unwrap(),
        first_revision
    );
    assert_eq!(
        runtime.execution_config_revision(&child.id).unwrap(),
        first_revision
    );
}

#[test]
fn replay_keeps_current_catalog_unbound_until_explicit_binding() {
    let mut runtime = ConductorRuntime::new();
    let profile = RoutingProfileId::parse("route").unwrap();
    let configuration = routed_configuration(&profile, "first");
    let revision = runtime.reload_configuration(configuration.clone()).unwrap();
    let restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();

    assert!(matches!(
        restored.callable_descriptors(),
        Err(ConductorError::UnboundConfigRevision(id)) if id == revision
    ));
}

#[test]
fn replay_rejects_configuration_substitution_for_recorded_revision() {
    let mut runtime = ConductorRuntime::new();
    let profile = RoutingProfileId::parse("route").unwrap();
    let first = routed_configuration(&profile, "first");
    let revision = runtime.reload_configuration(first.clone()).unwrap();
    let mut restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();

    let error = restored
        .bind_configuration_revision(&revision, routed_configuration(&profile, "second"))
        .unwrap_err();
    assert!(matches!(
        error,
        ConductorError::ConfigRevisionFingerprintMismatch { revision: id, .. } if id == revision
    ));

    restored
        .bind_configuration_revision(&revision, first)
        .unwrap();
}

#[test]
fn replay_requires_and_uses_recorded_revision_bindings() {
    let mut runtime = ConductorRuntime::new();
    let profile = RoutingProfileId::parse("route").unwrap();
    let first_configuration = routed_configuration(&profile, "first");
    let second_configuration = routed_configuration(&profile, "second");
    let first_revision = runtime
        .reload_configuration(first_configuration.clone())
        .unwrap();
    let session = runtime
        .create_session(None, None, ExecutionTarget::Routed(profile.clone()))
        .unwrap();
    let first = runtime.submit(&session.id, "first").unwrap();
    let second_revision = runtime
        .reload_configuration(second_configuration.clone())
        .unwrap();
    runtime
        .rebase_session(&session.id, &second_revision)
        .unwrap();
    let second = runtime.submit(&session.id, "second").unwrap();

    let mut restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();
    assert!(matches!(
        restored.resolve_invocation(&first.id),
        Err(ConductorError::UnboundConfigRevision(id)) if id == first_revision
    ));
    restored
        .bind_configuration_revision(&first_revision, first_configuration)
        .unwrap();
    restored
        .bind_configuration_revision(&second_revision, second_configuration)
        .unwrap();

    assert_eq!(
        restored.resolve_invocation(&first.id).unwrap().model,
        model("first")
    );
    assert_eq!(
        restored.resolve_invocation(&second.id).unwrap().model,
        model("second")
    );
}
