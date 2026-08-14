use crate::{ArtifactId, CallableId, RoleId, RunId, SchemaId, WorkflowId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

/// Immutable, schema-labelled output produced by one completed callable run.
/// Values are persisted separately from transcripts so workflows exchange data,
/// not prompt text.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub id: ArtifactId,
    pub schema: SchemaId,
    pub content_hash: String,
    pub producer: RunId,
    #[serde(default)]
    pub provenance: Vec<ArtifactId>,
}

/// A schema-labelled value passed to a callable. Natural language belongs only
/// in fields declared by the schema; orchestration consumes this value as data.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallableInput {
    pub schema: SchemaId,
    pub value: Value,
    #[serde(default)]
    pub artifacts: Vec<ArtifactRef>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum CallableExecutor {
    Agent { role: RoleId },
    Workflow { workflow: WorkflowId },
}

/// Selection labels describe what a callable does. They are deliberately not
/// invocation authority; callers are constrained by `InvocationPolicy`.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SelectionMetadata {
    #[serde(default)]
    pub capabilities: BTreeSet<String>,
    #[serde(default)]
    pub tags: BTreeSet<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct InvocationPolicy {
    #[serde(default)]
    pub callable_allowlist: BTreeSet<CallableId>,
}

impl InvocationPolicy {
    pub fn permits(&self, callable: &CallableId) -> bool {
        self.callable_allowlist.contains(callable)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CallableDefinition {
    pub id: CallableId,
    pub title: String,
    pub description: String,
    pub input_schema: SchemaId,
    pub output_schema: SchemaId,
    pub executor: CallableExecutor,
    #[serde(default)]
    pub selection: SelectionMetadata,
    #[serde(default)]
    pub invocation: InvocationPolicy,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CallableInvocation {
    pub callable: CallableId,
    pub input: CallableInput,
}

/// Validates catalog membership, caller authority, and the declared input
/// schema before execution reaches a workflow or ACP session.
#[derive(Clone, Debug, Default)]
pub struct CallableCatalog {
    definitions: BTreeMap<CallableId, CallableDefinition>,
}

impl CallableCatalog {
    pub fn insert(&mut self, definition: CallableDefinition) -> Result<(), CallableCatalogError> {
        let id = definition.id.clone();
        if self.definitions.insert(id.clone(), definition).is_some() {
            return Err(CallableCatalogError::DuplicateCallable(id));
        }
        Ok(())
    }

    pub fn get(&self, id: &CallableId) -> Option<&CallableDefinition> {
        self.definitions.get(id)
    }

    pub fn available_to(&self, policy: &InvocationPolicy) -> Vec<&CallableDefinition> {
        policy
            .callable_allowlist
            .iter()
            .filter_map(|id| self.definitions.get(id))
            .collect()
    }

    pub fn validate_invocation(
        &self,
        policy: &InvocationPolicy,
        invocation: &CallableInvocation,
    ) -> Result<&CallableDefinition, CallableCatalogError> {
        let definition = self
            .get(&invocation.callable)
            .ok_or_else(|| CallableCatalogError::UnknownCallable(invocation.callable.clone()))?;
        if !policy.permits(&invocation.callable) {
            return Err(CallableCatalogError::InvocationDenied(
                invocation.callable.clone(),
            ));
        }
        if definition.input_schema != invocation.input.schema {
            return Err(CallableCatalogError::InputSchemaMismatch {
                callable: invocation.callable.clone(),
                expected: definition.input_schema.clone(),
                actual: invocation.input.schema.clone(),
            });
        }
        Ok(definition)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CallableCatalogError {
    DuplicateCallable(CallableId),
    UnknownCallable(CallableId),
    InvocationDenied(CallableId),
    InputSchemaMismatch {
        callable: CallableId,
        expected: SchemaId,
        actual: SchemaId,
    },
}

impl Display for CallableCatalogError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateCallable(id) => write!(formatter, "duplicate callable {id}"),
            Self::UnknownCallable(id) => write!(formatter, "unknown callable {id}"),
            Self::InvocationDenied(id) => write!(formatter, "invocation of {id} is denied"),
            Self::InputSchemaMismatch {
                callable,
                expected,
                actual,
            } => write!(
                formatter,
                "callable {callable} expects input schema {expected}, received {actual}"
            ),
        }
    }
}

impl Error for CallableCatalogError {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunFailure {
    InvalidInput,
    InvalidOutput,
    CallableUnavailable,
    CapabilityDenied,
    DependencyFailed,
    ExecutionFailed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RunOutcome {
    Success {
        artifact: ArtifactRef,
    },
    Failed {
        failure: RunFailure,
        message: String,
    },
    Cancelled {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition() -> CallableDefinition {
        CallableDefinition {
            id: CallableId::parse("agent.scout").expect("valid callable identifier"),
            title: "Scout".to_owned(),
            description: "Collect repository evidence.".to_owned(),
            input_schema: SchemaId::parse("question.v1").expect("valid schema identifier"),
            output_schema: SchemaId::parse("evidence.v1").expect("valid schema identifier"),
            executor: CallableExecutor::Agent {
                role: RoleId::parse("scout").expect("valid role identifier"),
            },
            selection: SelectionMetadata::default(),
            invocation: InvocationPolicy::default(),
        }
    }

    #[test]
    fn selection_metadata_does_not_grant_invocation_authority() {
        let callable = CallableId::parse("workflow.implement").expect("valid callable identifier");
        let policy = InvocationPolicy::default();
        assert!(!policy.permits(&callable));

        let policy = InvocationPolicy {
            callable_allowlist: BTreeSet::from([callable.clone()]),
        };
        assert!(policy.permits(&callable));
    }

    #[test]
    fn catalog_validates_authority_and_schema_before_execution() {
        let definition = definition();
        let policy = InvocationPolicy {
            callable_allowlist: BTreeSet::from([definition.id.clone()]),
        };
        let mut catalog = CallableCatalog::default();
        catalog.insert(definition.clone()).expect("insert callable");
        let invocation = CallableInvocation {
            callable: definition.id.clone(),
            input: CallableInput {
                schema: definition.input_schema.clone(),
                value: serde_json::json!({ "question": "Where is this configured?" }),
                artifacts: Vec::new(),
            },
        };
        assert_eq!(
            catalog
                .validate_invocation(&policy, &invocation)
                .expect("valid invocation")
                .id,
            definition.id
        );

        let denied = catalog
            .validate_invocation(&InvocationPolicy::default(), &invocation)
            .expect_err("authority is required");
        assert!(matches!(denied, CallableCatalogError::InvocationDenied(_)));

        let mismatch = CallableInvocation {
            input: CallableInput {
                schema: SchemaId::parse("change.v1").expect("valid schema identifier"),
                ..invocation.input
            },
            ..invocation
        };
        assert!(matches!(
            catalog.validate_invocation(&policy, &mismatch),
            Err(CallableCatalogError::InputSchemaMismatch { .. })
        ));
    }

    #[test]
    fn run_outcomes_preserve_typed_artifact_provenance() {
        let outcome = RunOutcome::Success {
            artifact: ArtifactRef {
                id: ArtifactId::parse("artifact.plan.1").expect("valid artifact identifier"),
                schema: SchemaId::parse("plan.v1").expect("valid schema identifier"),
                content_hash: "sha256:abc".to_owned(),
                producer: RunId::parse("run.planner.1").expect("valid run identifier"),
                provenance: vec![
                    ArtifactId::parse("artifact.evidence.1").expect("valid artifact identifier")
                ],
            },
        };
        let encoded = serde_json::to_value(&outcome).expect("serialize outcome");
        assert_eq!(encoded["status"], "success");
        assert_eq!(encoded["artifact"]["schema"], "plan.v1");
        assert_eq!(encoded["artifact"]["provenance"][0], "artifact.evidence.1");
    }
}
