use phenix_conductor::{ConductorError, ConductorRuntime};
use phenix_core::{CallableDescriptor, OrchestrationDefinition, RoutingProfile};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};

/// Process-owned executable configuration for one conductor deployment.
///
/// The conductor owns validation and execution semantics, while applications
/// own the concrete agent, orchestration, and routing-profile instances supplied in
/// this file. Durable journals intentionally store only revision references and
/// runtime state, so this configuration is rebound on process startup.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeConfiguration {
    #[serde(default)]
    pub agents: Vec<CallableDescriptor>,
    #[serde(default)]
    pub orchestrations: Vec<OrchestrationDefinition>,
    #[serde(default)]
    pub routing_profiles: Vec<RoutingProfile>,
}

impl RuntimeConfiguration {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ConfigurationError> {
        let path = path.as_ref();
        let source = fs::read_to_string(path).map_err(|source| ConfigurationError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        serde_json::from_str(&source).map_err(|source| ConfigurationError::Parse {
            path: path.to_path_buf(),
            source,
        })
    }

    pub fn apply(self, runtime: &mut ConductorRuntime) -> Result<(), ConfigurationError> {
        for agent in self.agents {
            runtime.register_agent(agent)?;
        }
        for orchestration in self.orchestrations {
            runtime.register_orchestration(orchestration)?;
        }
        for profile in self.routing_profiles {
            runtime.register_routing_profile(profile)?;
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum ConfigurationError {
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
    Runtime(ConductorError),
}

impl Display for ConfigurationError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, source } => {
                write!(
                    f,
                    "failed to read conductor configuration {}: {source}",
                    path.display()
                )
            }
            Self::Parse { path, source } => {
                write!(
                    f,
                    "invalid conductor configuration {}: {source}",
                    path.display()
                )
            }
            Self::Runtime(source) => write!(f, "invalid conductor configuration: {source}"),
        }
    }
}

impl Error for ConfigurationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Read { source, .. } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::Runtime(source) => Some(source),
        }
    }
}

impl From<ConductorError> for ConfigurationError {
    fn from(value: ConductorError) -> Self {
        Self::Runtime(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{
        AgentNode, BackendId, CallableId, CallableKind, CallablePolicy, CapabilitySet,
        ExecutionTarget, InferenceOptions, ModelId, ModelTarget, OrchestrationPolicy, ProviderId,
        RoutingProfileId,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind,
            description: format!("{id} fixture"),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    fn target(model: &str) -> ModelTarget {
        ModelTarget {
            backend: BackendId::parse("phenix").unwrap(),
            provider: ProviderId::parse("fixture").unwrap(),
            model: ModelId::parse(model).unwrap(),
            inference: InferenceOptions::default(),
        }
    }

    #[test]
    fn application_configuration_rebinds_agents_workflows_and_routes() {
        let agent = descriptor("agent.fixture", CallableKind::Agent);
        let orchestration = OrchestrationDefinition {
            descriptor: descriptor("orchestration.fixture", CallableKind::Orchestration),
            policy: OrchestrationPolicy::Sequential,
            nodes: vec![AgentNode {
                callable: agent.id.clone(),
                objective: Some("inspect the objective".to_owned()),
            }],
        };
        let route = RoutingProfile {
            id: RoutingProfileId::parse("router.fixture").unwrap(),
            default_target: target("fallback"),
            callable_targets: BTreeMap::from([(agent.id.clone(), target("agent"))]),
        };
        let encoded = serde_json::to_string(&RuntimeConfiguration {
            agents: vec![agent.clone()],
            orchestrations: vec![orchestration],
            routing_profiles: vec![route],
        })
        .unwrap();
        let configuration: RuntimeConfiguration = serde_json::from_str(&encoded).unwrap();
        let mut runtime = ConductorRuntime::new();
        configuration.apply(&mut runtime).unwrap();

        assert_eq!(runtime.callable_descriptors().len(), 2);
        assert_eq!(
            runtime
                .callable_descriptors()
                .into_iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec![
                agent.id,
                CallableId::parse("orchestration.fixture").unwrap()
            ]
        );

        let session = runtime
            .create_session(
                None,
                None,
                ExecutionTarget::Routed(RoutingProfileId::parse("router.fixture").unwrap()),
            )
            .unwrap();
        let execution = runtime.submit(&session.id, "route me").unwrap();
        assert_eq!(
            runtime.resolve_invocation(&execution.id).unwrap().model,
            target("fallback")
        );
    }

    #[test]
    fn configured_workflow_step_keeps_the_user_objective() {
        let agent = descriptor("agent.worker", CallableKind::Agent);
        let workflow_id = CallableId::parse("orchestration.implement").unwrap();
        let configuration = RuntimeConfiguration {
            agents: vec![agent.clone()],
            orchestrations: vec![OrchestrationDefinition {
                descriptor: descriptor(workflow_id.as_str(), CallableKind::Orchestration),
                policy: OrchestrationPolicy::Sequential,
                nodes: vec![AgentNode {
                    callable: agent.id,
                    objective: Some("Implement the bounded change.".to_owned()),
                }],
            }],
            ..RuntimeConfiguration::default()
        };
        let mut runtime = ConductorRuntime::new();
        configuration.apply(&mut runtime).unwrap();

        let session = runtime
            .create_session(None, None, ExecutionTarget::Fixed(target("worker")))
            .unwrap();
        let root = runtime.submit(&session.id, "root").unwrap();
        let orchestration = runtime
            .start_orchestration(&root.id, &workflow_id, "Fix routing selection")
            .unwrap();
        let child = runtime
            .snapshot()
            .executions
            .into_iter()
            .find(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
            .expect("orchestration child exists");

        assert_eq!(
            runtime.resolve_invocation(&child.id).unwrap().prompt,
            "Implement the bounded change.\n\nOrchestration objective:\nFix routing selection"
        );
    }

    #[test]
    fn application_configuration_rejects_wrong_callable_kinds() {
        let configuration = RuntimeConfiguration {
            agents: vec![descriptor("tool.not-an-agent", CallableKind::Tool)],
            ..RuntimeConfiguration::default()
        };
        assert!(matches!(
            configuration.apply(&mut ConductorRuntime::new()),
            Err(ConfigurationError::Runtime(_))
        ));
    }
}
