#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidId;

impl Display for InvalidId {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str("identifier must not be empty")
    }
}

impl std::error::Error for InvalidId {}

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);
        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, InvalidId> {
                let value = value.into();
                if value.trim().is_empty() {
                    Err(InvalidId)
                } else {
                    Ok(Self(value))
                }
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl Display for $name {
            fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_type!(SessionId);
id_type!(ExecutionId);
id_type!(CallableId);
id_type!(ToolCallId);
id_type!(ConfigRevisionId);
id_type!(BackendId);
id_type!(ProviderId);
id_type!(ModelId);
id_type!(RoutingProfileId);
id_type!(AuthenticationMethodId);

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct InferenceOptions {
    pub effort: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelTarget {
    pub backend: BackendId,
    pub provider: ProviderId,
    pub model: ModelId,
    pub inference: InferenceOptions,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelDescriptor {
    pub target: ModelTarget,
    pub name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationMethodKind {
    Agent,
    Environment,
    Terminal,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthenticationMethodDescriptor {
    pub id: AuthenticationMethodId,
    pub backend: BackendId,
    pub provider: ProviderId,
    pub kind: AuthenticationMethodKind,
    pub name: String,
    pub description: Option<String>,
    pub selectable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationState {
    NotRequired,
    Required,
    Authenticated,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendCatalog {
    pub backend: BackendId,
    pub models: Vec<ModelDescriptor>,
    pub authentication_state: AuthenticationState,
    pub authentication_methods: Vec<AuthenticationMethodDescriptor>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ExecutionTarget {
    Fixed(ModelTarget),
    Routed(RoutingProfileId),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallableKind {
    Tool,
    Agent,
    Workflow,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct CapabilitySet(pub BTreeSet<String>);

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct CallablePolicy {
    pub requires_permission: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallableDescriptor {
    pub id: CallableId,
    pub kind: CallableKind,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub capabilities: CapabilitySet,
    pub policy: CallablePolicy,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RoutingProfile {
    pub id: RoutingProfileId,
    pub default_target: ModelTarget,
    pub callable_targets: BTreeMap<CallableId, ModelTarget>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowExecutionPolicy {
    Sequential,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub callable: CallableId,
    pub objective: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    pub descriptor: CallableDescriptor,
    pub policy: WorkflowExecutionPolicy,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionKind {
    Root,
    Agent,
    Workflow,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    #[default]
    Active,
    Closed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: SessionId,
    pub parent_session: Option<SessionId>,
    pub name: Option<String>,
    pub config_revision: ConfigRevisionId,
    pub default_target: ExecutionTarget,
    #[serde(default)]
    pub state: SessionState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExecutionSummary {
    pub id: ExecutionId,
    pub session_id: SessionId,
    pub parent_execution: Option<ExecutionId>,
    pub kind: ExecutionKind,
    pub callable: Option<CallableId>,
    pub target: ExecutionTarget,
    pub state: ExecutionState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExecutionEvent {
    pub sequence: u64,
    pub session_id: SessionId,
    pub execution_id: ExecutionId,
    pub kind: ExecutionEventKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionEventKind {
    UserInput {
        text: String,
    },
    ExecutionStateChanged {
        state: ExecutionState,
    },
    AssistantContentDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCallStarted {
        tool_call_id: ToolCallId,
        callable: CallableId,
    },
    ToolCallArguments {
        tool_call_id: ToolCallId,
        arguments: String,
    },
    ToolCallFinished {
        tool_call_id: ToolCallId,
        output: String,
        success: bool,
    },
    ChildExecutionStarted {
        child: ExecutionId,
    },
    ChildExecutionFinished {
        child: ExecutionId,
        state: ExecutionState,
    },
    Error {
        code: String,
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_is_one_mode_only() {
        let target = ExecutionTarget::Routed(RoutingProfileId::parse("default").unwrap());
        assert!(matches!(target, ExecutionTarget::Routed(_)));
    }

    #[test]
    fn missing_session_state_deserializes_as_active_for_old_journals() {
        let value = serde_json::json!({
            "id": "session-1",
            "parent_session": null,
            "name": null,
            "config_revision": "config-1",
            "default_target": {
                "kind": "routed",
                "value": "default"
            }
        });
        let session: SessionSummary = serde_json::from_value(value).unwrap();
        assert_eq!(session.state, SessionState::Active);
    }
}
