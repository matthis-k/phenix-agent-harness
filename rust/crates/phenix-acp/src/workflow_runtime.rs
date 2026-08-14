use crate::{
    ArtifactId, ArtifactRef, CallableCatalog, CallableInput, CallableInvocation, InvocationPolicy,
    RunFailure, RunId, SchemaId,
};
use crate::{CallableWorkflowDefinition, WorkflowDefinitionError, WorkflowValueSource};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

/// An immutable artifact plus the value retained by the conductor. Transcripts
/// are intentionally absent: only schema-labelled values cross run boundaries.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StoredArtifact {
    pub reference: ArtifactRef,
    pub value: Value,
}

#[derive(Clone, Debug, Default)]
pub struct ArtifactStore {
    artifacts: BTreeMap<ArtifactId, StoredArtifact>,
}

impl ArtifactStore {
    pub fn insert(&mut self, artifact: StoredArtifact) -> Result<(), WorkflowRuntimeError> {
        let id = artifact.reference.id.clone();
        if self.artifacts.insert(id.clone(), artifact).is_some() {
            return Err(WorkflowRuntimeError::DuplicateArtifact(id));
        }
        Ok(())
    }

    pub fn get(&self, id: &ArtifactId) -> Option<&StoredArtifact> {
        self.artifacts.get(id)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkflowNodeRunState {
    Pending,
    Running {
        run: RunId,
    },
    Succeeded {
        run: RunId,
    },
    Failed {
        run: RunId,
        failure: RunFailure,
    },
    /// The node never began because a required predecessor could not produce
    /// its declared artifact.
    Blocked {
        failure: RunFailure,
    },
    Cancelled {
        run: RunId,
    },
}

/// A fully hydrated invocation ready for an executor. All orchestration data
/// has been resolved before this reaches an agent/ACP adapter.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ReadyInvocation {
    pub node: String,
    pub invocation: CallableInvocation,
}

/// Names an immutable result artifact by the static port it satisfies.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WorkflowOutput {
    pub port: String,
    pub artifact: StoredArtifact,
}

/// Executes a validated static workflow. `ready` returns an entire ready batch:
/// callers may run its members concurrently; graph dependencies, not a model,
/// determine that parallelism.
#[derive(Clone, Debug)]
pub struct WorkflowRuntime {
    definition: CallableWorkflowDefinition,
    catalog: CallableCatalog,
    caller: InvocationPolicy,
    inputs: BTreeMap<String, StoredArtifact>,
    artifacts: ArtifactStore,
    states: BTreeMap<String, WorkflowNodeRunState>,
    outputs: BTreeMap<(String, String), ArtifactId>,
}

impl WorkflowRuntime {
    pub fn new(
        definition: CallableWorkflowDefinition,
        catalog: CallableCatalog,
        caller: InvocationPolicy,
        inputs: BTreeMap<String, StoredArtifact>,
    ) -> Result<Self, WorkflowRuntimeError> {
        definition.validate_against(&catalog)?;
        for port in &definition.inputs {
            let artifact = inputs
                .get(&port.name)
                .ok_or_else(|| WorkflowRuntimeError::MissingWorkflowInput(port.name.clone()))?;
            if artifact.reference.schema != port.schema {
                return Err(WorkflowRuntimeError::InputSchemaMismatch {
                    port: port.name.clone(),
                    expected: port.schema.clone(),
                    actual: artifact.reference.schema.clone(),
                });
            }
        }
        let states = definition
            .nodes
            .iter()
            .map(|node| (node.key.clone(), WorkflowNodeRunState::Pending))
            .collect();
        Ok(Self {
            definition,
            catalog,
            caller,
            inputs,
            artifacts: ArtifactStore::default(),
            states,
            outputs: BTreeMap::new(),
        })
    }

    pub fn states(&self) -> &BTreeMap<String, WorkflowNodeRunState> {
        &self.states
    }

    pub fn artifacts(&self) -> &ArtifactStore {
        &self.artifacts
    }

    /// Produces every currently independent invocation in deterministic node
    /// key order. Nodes are not marked running until `start` records a RunId.
    pub fn ready(&mut self) -> Result<Vec<ReadyInvocation>, WorkflowRuntimeError> {
        self.propagate_dependency_failures();
        self.definition
            .nodes
            .iter()
            .filter(|node| self.states.get(&node.key) == Some(&WorkflowNodeRunState::Pending))
            .filter_map(|node| self.hydrate(node).transpose())
            .collect()
    }

    pub fn start(&mut self, node: &str, run: RunId) -> Result<(), WorkflowRuntimeError> {
        let definition = self.node(node)?.clone();
        if self.hydrate(&definition)?.is_none() {
            return Err(WorkflowRuntimeError::NodeNotReady(node.to_owned()));
        }
        let state = self
            .states
            .get_mut(node)
            .ok_or_else(|| WorkflowRuntimeError::UnknownNode(node.to_owned()))?;
        if *state != WorkflowNodeRunState::Pending {
            return Err(WorkflowRuntimeError::NodeNotReady(node.to_owned()));
        }
        *state = WorkflowNodeRunState::Running { run };
        Ok(())
    }

    /// Stores immutable outputs only after validating port names, schemas, and
    /// producer provenance. A failed output cannot accidentally satisfy an edge.
    pub fn complete(
        &mut self,
        node: &str,
        outputs: Vec<WorkflowOutput>,
    ) -> Result<(), WorkflowRuntimeError> {
        let run = match self.states.get(node) {
            Some(WorkflowNodeRunState::Running { run }) => run.clone(),
            Some(_) => return Err(WorkflowRuntimeError::NodeNotRunning(node.to_owned())),
            None => return Err(WorkflowRuntimeError::UnknownNode(node.to_owned())),
        };
        let definition = self.node(node)?;
        let expected = definition
            .outputs
            .iter()
            .map(|port| (port.name.clone(), port.schema.clone()))
            .collect::<BTreeMap<_, _>>();
        if outputs.len() != expected.len() {
            return Err(WorkflowRuntimeError::OutputCount {
                node: node.to_owned(),
                expected: expected.len(),
                actual: outputs.len(),
            });
        }
        for output in &outputs {
            if output.artifact.reference.producer != run {
                return Err(WorkflowRuntimeError::InvalidProducer {
                    node: node.to_owned(),
                    expected: run.clone(),
                    actual: output.artifact.reference.producer.clone(),
                });
            }
            let schema = expected.get(&output.port).ok_or_else(|| {
                WorkflowRuntimeError::UnknownOutputPort {
                    node: node.to_owned(),
                    port: output.port.clone(),
                }
            })?;
            if *schema != output.artifact.reference.schema {
                return Err(WorkflowRuntimeError::UnexpectedOutputSchema {
                    node: node.to_owned(),
                    actual: output.artifact.reference.schema.clone(),
                });
            }
            if self
                .outputs
                .contains_key(&(node.to_owned(), output.port.clone()))
            {
                return Err(WorkflowRuntimeError::DuplicateOutputPort {
                    node: node.to_owned(),
                    port: output.port.clone(),
                });
            }
            self.outputs.insert(
                (node.to_owned(), output.port.clone()),
                output.artifact.reference.id.clone(),
            );
        }
        for output in outputs {
            self.artifacts.insert(output.artifact)?;
        }
        self.states
            .insert(node.to_owned(), WorkflowNodeRunState::Succeeded { run });
        Ok(())
    }

    pub fn fail(&mut self, node: &str, failure: RunFailure) -> Result<(), WorkflowRuntimeError> {
        let run = match self.states.get(node) {
            Some(WorkflowNodeRunState::Running { run }) => run.clone(),
            Some(_) => return Err(WorkflowRuntimeError::NodeNotRunning(node.to_owned())),
            None => return Err(WorkflowRuntimeError::UnknownNode(node.to_owned())),
        };
        self.states.insert(
            node.to_owned(),
            WorkflowNodeRunState::Failed { run, failure },
        );
        Ok(())
    }

    fn hydrate(
        &self,
        node: &crate::WorkflowNodeDefinition,
    ) -> Result<Option<ReadyInvocation>, WorkflowRuntimeError> {
        let mut fields = Map::new();
        let mut artifacts = Vec::new();
        for binding in &node.inputs {
            let artifact = match &binding.source {
                WorkflowValueSource::Input { port } => self.inputs.get(port),
                WorkflowValueSource::NodeOutput { node, port } => self
                    .outputs
                    .get(&(node.clone(), port.clone()))
                    .and_then(|id| self.artifacts.get(id)),
            };
            let Some(artifact) = artifact else {
                return Ok(None);
            };
            if artifact.reference.schema != binding.schema {
                return Err(WorkflowRuntimeError::HydrationSchemaMismatch {
                    node: node.key.clone(),
                    field: binding.field.clone(),
                    expected: binding.schema.clone(),
                    actual: artifact.reference.schema.clone(),
                });
            }
            fields.insert(binding.field.clone(), artifact.value.clone());
            artifacts.push(artifact.reference.clone());
        }
        let invocation = CallableInvocation {
            callable: node.callable.clone(),
            input: CallableInput {
                schema: node.input_schema.clone(),
                value: Value::Object(fields),
                artifacts,
            },
        };
        self.catalog
            .validate_invocation(&self.caller, &invocation)?;
        Ok(Some(ReadyInvocation {
            node: node.key.clone(),
            invocation,
        }))
    }

    fn propagate_dependency_failures(&mut self) {
        for node in &self.definition.nodes {
            if self.states.get(&node.key) != Some(&WorkflowNodeRunState::Pending) {
                continue;
            }
            let failed = node.inputs.iter().any(|binding| match &binding.source {
                WorkflowValueSource::Input { .. } => false,
                WorkflowValueSource::NodeOutput { node, .. } => matches!(
                    self.states.get(node),
                    Some(
                        WorkflowNodeRunState::Failed { .. }
                            | WorkflowNodeRunState::Blocked { .. }
                            | WorkflowNodeRunState::Cancelled { .. }
                    )
                ),
            });
            if failed {
                // `Continue` is intentionally not treated as implicit missing
                // data. Bounded fallback/conditional nodes must supply a typed
                // replacement artifact before a dependent can run.
                self.states.insert(
                    node.key.clone(),
                    WorkflowNodeRunState::Blocked {
                        failure: RunFailure::DependencyFailed,
                    },
                );
            }
        }
    }

    fn node(&self, key: &str) -> Result<&crate::WorkflowNodeDefinition, WorkflowRuntimeError> {
        self.definition
            .nodes
            .iter()
            .find(|node| node.key == key)
            .ok_or_else(|| WorkflowRuntimeError::UnknownNode(key.to_owned()))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkflowRuntimeError {
    Definition(WorkflowDefinitionError),
    Catalog(crate::CallableCatalogError),
    DuplicateArtifact(ArtifactId),
    MissingWorkflowInput(String),
    InputSchemaMismatch {
        port: String,
        expected: SchemaId,
        actual: SchemaId,
    },
    UnknownNode(String),
    UnknownRun(RunId),
    NodeNotReady(String),
    NodeNotRunning(String),
    OutputCount {
        node: String,
        expected: usize,
        actual: usize,
    },
    InvalidProducer {
        node: String,
        expected: RunId,
        actual: RunId,
    },
    UnknownOutputPort {
        node: String,
        port: String,
    },
    UnexpectedOutputSchema {
        node: String,
        actual: SchemaId,
    },
    DuplicateOutputPort {
        node: String,
        port: String,
    },
    HydrationSchemaMismatch {
        node: String,
        field: String,
        expected: SchemaId,
        actual: SchemaId,
    },
}

impl Display for WorkflowRuntimeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Definition(error) => Display::fmt(error, f),
            Self::Catalog(error) => Display::fmt(error, f),
            Self::DuplicateArtifact(id) => write!(f, "artifact {id} already exists"),
            Self::MissingWorkflowInput(port) => write!(f, "missing workflow input {port}"),
            Self::InputSchemaMismatch {
                port,
                expected,
                actual,
            } => write!(
                f,
                "workflow input {port} expects {expected}, received {actual}"
            ),
            Self::UnknownNode(node) => write!(f, "unknown workflow node {node}"),
            Self::UnknownRun(run) => write!(f, "unknown or completed run {run}"),
            Self::NodeNotReady(node) => write!(f, "workflow node {node} is not ready"),
            Self::NodeNotRunning(node) => write!(f, "workflow node {node} is not running"),
            Self::OutputCount {
                node,
                expected,
                actual,
            } => write!(
                f,
                "node {node} produced {actual} artifacts; expected {expected}"
            ),
            Self::InvalidProducer {
                node,
                expected,
                actual,
            } => write!(
                f,
                "node {node} output producer {actual} does not match run {expected}"
            ),
            Self::UnknownOutputPort { node, port } => {
                write!(f, "node {node} produced unknown port {port}")
            }
            Self::UnexpectedOutputSchema { node, actual } => {
                write!(f, "node {node} produced undeclared schema {actual}")
            }
            Self::DuplicateOutputPort { node, port } => {
                write!(f, "node {node} produced port {port} more than once")
            }
            Self::HydrationSchemaMismatch {
                node,
                field,
                expected,
                actual,
            } => write!(
                f,
                "node {node} field {field} expects {expected}, received {actual}"
            ),
        }
    }
}

impl Error for WorkflowRuntimeError {}
impl From<WorkflowDefinitionError> for WorkflowRuntimeError {
    fn from(value: WorkflowDefinitionError) -> Self {
        Self::Definition(value)
    }
}
impl From<crate::CallableCatalogError> for WorkflowRuntimeError {
    fn from(value: crate::CallableCatalogError) -> Self {
        Self::Catalog(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CallableDefinition, CallableExecutor, CallableId, ExecutionPolicy, RoleId,
        SelectionMetadata, WorkflowInputBinding, WorkflowNodeDefinition, WorkflowPort,
    };
    use std::collections::BTreeSet;

    fn schema(value: &str) -> SchemaId {
        SchemaId::parse(value).unwrap()
    }

    fn artifact(id: &str, schema_name: &str, producer: &str, value: Value) -> StoredArtifact {
        StoredArtifact {
            reference: ArtifactRef {
                id: ArtifactId::parse(id).unwrap(),
                schema: schema(schema_name),
                content_hash: "sha256:test".into(),
                producer: RunId::parse(producer).unwrap(),
                provenance: Vec::new(),
            },
            value,
        }
    }

    #[test]
    fn scheduler_hydrates_edges_and_only_releases_dependents_after_artifacts() {
        let scout = CallableId::parse("agent.scout").unwrap();
        let plan = CallableId::parse("agent.plan").unwrap();
        let mut catalog = CallableCatalog::default();
        for (id, input, output) in [
            (scout.clone(), "change.v1", "evidence.v1"),
            (plan.clone(), "plan_input.v1", "plan.v1"),
        ] {
            catalog
                .insert(CallableDefinition {
                    id,
                    title: String::new(),
                    description: String::new(),
                    input_schema: schema(input),
                    output_schema: schema(output),
                    executor: CallableExecutor::Agent {
                        role: RoleId::parse("worker").unwrap(),
                    },
                    selection: SelectionMetadata::default(),
                    invocation: InvocationPolicy::default(),
                    execution: ExecutionPolicy::default(),
                })
                .unwrap();
        }
        let definition = CallableWorkflowDefinition {
            inputs: vec![WorkflowPort {
                name: "change".into(),
                schema: schema("change.v1"),
            }],
            nodes: vec![
                WorkflowNodeDefinition {
                    key: "scout".into(),
                    callable: scout.clone(),
                    input_schema: schema("change.v1"),
                    inputs: vec![WorkflowInputBinding {
                        field: "change".into(),
                        schema: schema("change.v1"),
                        source: WorkflowValueSource::Input {
                            port: "change".into(),
                        },
                    }],
                    outputs: vec![WorkflowPort {
                        name: "evidence".into(),
                        schema: schema("evidence.v1"),
                    }],
                    on_dependency_failure: Default::default(),
                },
                WorkflowNodeDefinition {
                    key: "plan".into(),
                    callable: plan.clone(),
                    input_schema: schema("plan_input.v1"),
                    inputs: vec![WorkflowInputBinding {
                        field: "evidence".into(),
                        schema: schema("evidence.v1"),
                        source: WorkflowValueSource::NodeOutput {
                            node: "scout".into(),
                            port: "evidence".into(),
                        },
                    }],
                    outputs: vec![WorkflowPort {
                        name: "plan".into(),
                        schema: schema("plan.v1"),
                    }],
                    on_dependency_failure: Default::default(),
                },
            ],
            outputs: Vec::new(),
        };
        let policy = InvocationPolicy {
            callable_allowlist: BTreeSet::from([scout, plan]),
            ..InvocationPolicy::default()
        };
        let inputs = BTreeMap::from([(
            "change".into(),
            artifact(
                "artifact.change",
                "change.v1",
                "run.root",
                serde_json::json!({"objective":"x"}),
            ),
        )]);
        let mut runtime = WorkflowRuntime::new(definition, catalog, policy, inputs).unwrap();
        assert_eq!(
            runtime
                .ready()
                .unwrap()
                .iter()
                .map(|ready| ready.node.as_str())
                .collect::<Vec<_>>(),
            vec!["scout"]
        );
        let scout_run = RunId::parse("run.scout").unwrap();
        runtime.start("scout", scout_run).unwrap();
        runtime
            .complete(
                "scout",
                vec![WorkflowOutput {
                    port: "evidence".into(),
                    artifact: artifact(
                        "artifact.evidence",
                        "evidence.v1",
                        "run.scout",
                        serde_json::json!({"paths":["a"]}),
                    ),
                }],
            )
            .unwrap();
        assert_eq!(
            runtime
                .ready()
                .unwrap()
                .iter()
                .map(|ready| ready.node.as_str())
                .collect::<Vec<_>>(),
            vec!["plan"]
        );
    }
}
