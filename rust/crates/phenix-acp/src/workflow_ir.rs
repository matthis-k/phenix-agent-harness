use crate::{CallableCatalog, CallableId, SchemaId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

/// A named, schema-labelled value at a workflow boundary or node boundary.
/// Names are structural; schemas are the contract that makes an edge valid.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowPort {
    pub name: String,
    pub schema: SchemaId,
}

/// The source of one input field for a node.  Workflows exchange artifacts;
/// prompts and transcripts are never implicit dataflow edges.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkflowValueSource {
    Input { port: String },
    NodeOutput { node: String, port: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowInputBinding {
    pub field: String,
    pub schema: SchemaId,
    pub source: WorkflowValueSource,
}

/// Failure handling is declarative workflow policy, never agent reasoning.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyFailurePolicy {
    Abort,
    Continue,
}

impl Default for DependencyFailurePolicy {
    fn default() -> Self {
        Self::Abort
    }
}

/// A callable invocation in a static workflow graph.  The conductor creates
/// runs, sessions, retries, and context from this definition; a node cannot
/// create arbitrary child callables itself.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowNodeDefinition {
    pub key: String,
    pub callable: CallableId,
    pub input_schema: SchemaId,
    #[serde(default)]
    pub inputs: Vec<WorkflowInputBinding>,
    #[serde(default)]
    pub outputs: Vec<WorkflowPort>,
    #[serde(default)]
    pub on_dependency_failure: DependencyFailurePolicy,
}

/// A statically validated, bounded workflow graph.  It deliberately has no
/// dynamic node creation, loops, or recursive dispatch.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CallableWorkflowDefinition {
    pub inputs: Vec<WorkflowPort>,
    pub nodes: Vec<WorkflowNodeDefinition>,
    pub outputs: Vec<WorkflowInputBinding>,
}

impl CallableWorkflowDefinition {
    /// Validate graph shape and dataflow schemas independently of a particular
    /// callable catalog.  This makes malformed workflow definitions load-time
    /// errors rather than surprising runtime prompt failures.
    pub fn validate(&self) -> Result<(), WorkflowDefinitionError> {
        let input_ports = ports("workflow input", &self.inputs)?;
        let mut nodes = BTreeMap::new();
        for node in &self.nodes {
            required_name("workflow node", &node.key)?;
            if nodes.insert(node.key.as_str(), node).is_some() {
                return Err(WorkflowDefinitionError::DuplicateNode(node.key.clone()));
            }
            ports(&format!("outputs of node {}", node.key), &node.outputs)?;
            let mut fields = BTreeSet::new();
            for binding in &node.inputs {
                required_name("input field", &binding.field)?;
                if !fields.insert(binding.field.as_str()) {
                    return Err(WorkflowDefinitionError::DuplicateInputField {
                        node: node.key.clone(),
                        field: binding.field.clone(),
                    });
                }
            }
        }
        if nodes.is_empty() {
            return Err(WorkflowDefinitionError::Empty);
        }

        for node in &self.nodes {
            for binding in &node.inputs {
                self.validate_source(&input_ports, &nodes, &node.key, binding)?;
            }
        }
        for output in &self.outputs {
            self.validate_source(&input_ports, &nodes, "workflow output", output)?;
        }
        self.validate_acyclic(&nodes)
    }

    /// Validate that every node calls a catalogued callable with the exact
    /// declared input schema.  Output ports remain explicit because one
    /// callable result can project multiple typed artifacts.
    pub fn validate_against(
        &self,
        catalog: &CallableCatalog,
    ) -> Result<(), WorkflowDefinitionError> {
        self.validate()?;
        for node in &self.nodes {
            let callable = catalog
                .get(&node.callable)
                .ok_or_else(|| WorkflowDefinitionError::UnknownCallable(node.callable.clone()))?;
            if callable.input_schema != node.input_schema {
                return Err(WorkflowDefinitionError::CallableInputSchemaMismatch {
                    node: node.key.clone(),
                    callable: node.callable.clone(),
                    expected: callable.input_schema.clone(),
                    actual: node.input_schema.clone(),
                });
            }
        }
        Ok(())
    }

    fn validate_source(
        &self,
        inputs: &BTreeMap<&str, &WorkflowPort>,
        nodes: &BTreeMap<&str, &WorkflowNodeDefinition>,
        consumer: &str,
        binding: &WorkflowInputBinding,
    ) -> Result<(), WorkflowDefinitionError> {
        let actual = match &binding.source {
            WorkflowValueSource::Input { port } => inputs
                .get(port.as_str())
                .map(|port| port.schema.clone())
                .ok_or_else(|| WorkflowDefinitionError::UnknownInputPort(port.clone()))?,
            WorkflowValueSource::NodeOutput { node, port } => nodes
                .get(node.as_str())
                .ok_or_else(|| WorkflowDefinitionError::UnknownSourceNode(node.clone()))?
                .outputs
                .iter()
                .find(|candidate| candidate.name == *port)
                .map(|port| port.schema.clone())
                .ok_or_else(|| WorkflowDefinitionError::UnknownOutputPort {
                    node: node.clone(),
                    port: port.clone(),
                })?,
        };
        if actual != binding.schema {
            return Err(WorkflowDefinitionError::EdgeSchemaMismatch {
                consumer: consumer.to_owned(),
                field: binding.field.clone(),
                expected: binding.schema.clone(),
                actual,
            });
        }
        Ok(())
    }

    fn validate_acyclic(
        &self,
        nodes: &BTreeMap<&str, &WorkflowNodeDefinition>,
    ) -> Result<(), WorkflowDefinitionError> {
        fn visit(
            node: &str,
            nodes: &BTreeMap<&str, &WorkflowNodeDefinition>,
            visiting: &mut BTreeSet<String>,
            visited: &mut BTreeSet<String>,
        ) -> Result<(), WorkflowDefinitionError> {
            if visited.contains(node) {
                return Ok(());
            }
            if !visiting.insert(node.to_owned()) {
                return Err(WorkflowDefinitionError::Cycle(node.to_owned()));
            }
            let definition = nodes[node];
            for binding in &definition.inputs {
                if let WorkflowValueSource::NodeOutput { node, .. } = &binding.source {
                    visit(node, nodes, visiting, visited)?;
                }
            }
            visiting.remove(node);
            visited.insert(node.to_owned());
            Ok(())
        }

        let mut visiting = BTreeSet::new();
        let mut visited = BTreeSet::new();
        for node in nodes.keys() {
            visit(node, nodes, &mut visiting, &mut visited)?;
        }
        Ok(())
    }
}

fn required_name(kind: &str, name: &str) -> Result<(), WorkflowDefinitionError> {
    if name.trim().is_empty() {
        return Err(WorkflowDefinitionError::EmptyName(kind.to_owned()));
    }
    Ok(())
}

fn ports<'a>(
    owner: &str,
    values: &'a [WorkflowPort],
) -> Result<BTreeMap<&'a str, &'a WorkflowPort>, WorkflowDefinitionError> {
    let mut ports = BTreeMap::new();
    for port in values {
        required_name("port", &port.name)?;
        if ports.insert(port.name.as_str(), port).is_some() {
            return Err(WorkflowDefinitionError::DuplicatePort {
                owner: owner.to_owned(),
                port: port.name.clone(),
            });
        }
    }
    Ok(ports)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkflowDefinitionError {
    Empty,
    EmptyName(String),
    DuplicateNode(String),
    DuplicatePort {
        owner: String,
        port: String,
    },
    DuplicateInputField {
        node: String,
        field: String,
    },
    UnknownInputPort(String),
    UnknownSourceNode(String),
    UnknownOutputPort {
        node: String,
        port: String,
    },
    EdgeSchemaMismatch {
        consumer: String,
        field: String,
        expected: SchemaId,
        actual: SchemaId,
    },
    Cycle(String),
    UnknownCallable(CallableId),
    CallableInputSchemaMismatch {
        node: String,
        callable: CallableId,
        expected: SchemaId,
        actual: SchemaId,
    },
}

impl Display for WorkflowDefinitionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "workflow must contain at least one node"),
            Self::EmptyName(kind) => write!(f, "{kind} name must not be empty"),
            Self::DuplicateNode(node) => write!(f, "duplicate workflow node {node}"),
            Self::DuplicatePort { owner, port } => write!(f, "duplicate port {port} on {owner}"),
            Self::DuplicateInputField { node, field } => {
                write!(f, "duplicate input field {field} on node {node}")
            }
            Self::UnknownInputPort(port) => write!(f, "unknown workflow input port {port}"),
            Self::UnknownSourceNode(node) => write!(f, "unknown workflow source node {node}"),
            Self::UnknownOutputPort { node, port } => {
                write!(f, "unknown output port {port} on node {node}")
            }
            Self::EdgeSchemaMismatch {
                consumer,
                field,
                expected,
                actual,
            } => write!(
                f,
                "{consumer}.{field} expects schema {expected}, received {actual}"
            ),
            Self::Cycle(node) => write!(f, "workflow dependency cycle at node {node}"),
            Self::UnknownCallable(callable) => write!(f, "unknown callable {callable}"),
            Self::CallableInputSchemaMismatch {
                node,
                callable,
                expected,
                actual,
            } => write!(
                f,
                "node {node} invokes {callable} with schema {actual}; expected {expected}"
            ),
        }
    }
}

impl Error for WorkflowDefinitionError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CallableDefinition, CallableExecutor, InvocationPolicy, RoleId, SelectionMetadata,
    };

    fn schema(value: &str) -> SchemaId {
        SchemaId::parse(value).expect("schema")
    }
    fn workflow() -> CallableWorkflowDefinition {
        CallableWorkflowDefinition {
            inputs: vec![WorkflowPort {
                name: "change".into(),
                schema: schema("change.v1"),
            }],
            nodes: vec![
                WorkflowNodeDefinition {
                    key: "scout".into(),
                    callable: CallableId::parse("agent.scout").unwrap(),
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
                    on_dependency_failure: DependencyFailurePolicy::Abort,
                },
                WorkflowNodeDefinition {
                    key: "plan".into(),
                    callable: CallableId::parse("agent.plan").unwrap(),
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
                    on_dependency_failure: DependencyFailurePolicy::Abort,
                },
            ],
            outputs: vec![WorkflowInputBinding {
                field: "result".into(),
                schema: schema("plan.v1"),
                source: WorkflowValueSource::NodeOutput {
                    node: "plan".into(),
                    port: "plan".into(),
                },
            }],
        }
    }

    #[test]
    fn validates_typed_dataflow_independent_of_node_order() {
        workflow().validate().expect("valid graph");
    }

    #[test]
    fn rejects_invalid_edge_schemas_at_definition_load() {
        let mut definition = workflow();
        definition.nodes[1].inputs[0].schema = schema("plan.v1");
        assert!(matches!(
            definition.validate(),
            Err(WorkflowDefinitionError::EdgeSchemaMismatch { .. })
        ));
    }

    #[test]
    fn rejects_cycles() {
        let mut definition = workflow();
        definition.nodes[0].inputs.push(WorkflowInputBinding {
            field: "plan".into(),
            schema: schema("plan.v1"),
            source: WorkflowValueSource::NodeOutput {
                node: "plan".into(),
                port: "plan".into(),
            },
        });
        assert!(matches!(
            definition.validate(),
            Err(WorkflowDefinitionError::Cycle(_))
        ));
    }

    #[test]
    fn validates_callable_input_contracts() {
        let mut catalog = CallableCatalog::default();
        for (id, input) in [
            ("agent.scout", "change.v1"),
            ("agent.plan", "plan_input.v1"),
        ] {
            catalog
                .insert(CallableDefinition {
                    id: CallableId::parse(id).unwrap(),
                    title: id.into(),
                    description: String::new(),
                    input_schema: schema(input),
                    output_schema: schema("result.v1"),
                    executor: CallableExecutor::Agent {
                        role: RoleId::parse("worker").unwrap(),
                    },
                    selection: SelectionMetadata::default(),
                    invocation: InvocationPolicy::default(),
                })
                .unwrap();
        }
        workflow()
            .validate_against(&catalog)
            .expect("catalog matches");
    }
}
