use crate::{
    CallableOperation, ConductorError, ConductorRuntime, DomainEvent, ExecutionPayload,
    ExecutionProvider, ExecutionProviderBinding, InvocationPolicyContext, InvocationSubject,
    JournalExecutionPayload,
};
use phenix_backend::ToolResult;
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, ExecutionEventKind, ExecutionId, ExecutionKind,
    ExecutionState, ExecutionSummary, FileObservation, OrchestrationDefinition,
    OrchestrationNodeId, SessionId,
};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Debug, Display, Formatter};
use std::sync::Arc;

type ToolHandler = dyn Fn(&str) -> Result<ToolOutcome, String> + Send + Sync;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolOutcome {
    pub output: String,
    pub success: bool,
    pub file_observations: Vec<FileObservation>,
}

impl ToolOutcome {
    #[must_use]
    pub fn success(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            success: true,
            file_observations: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_file_observation(mut self, observation: FileObservation) -> Self {
        self.file_observations.push(observation);
        self
    }

    #[must_use]
    pub(crate) fn into_backend_result(self) -> ToolResult {
        ToolResult {
            output: self.output,
            success: self.success,
        }
    }

    fn failure(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            success: false,
            file_observations: Vec::new(),
        }
    }
}

impl From<String> for ToolOutcome {
    fn from(output: String) -> Self {
        Self::success(output)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CallableRegistryError {
    Duplicate(CallableId),
    Unknown(CallableId),
    WrongKind {
        callable: CallableId,
        expected: CallableKind,
        actual: CallableKind,
    },
    NotExecutable(CallableId),
    EmptyOrchestration(CallableId),
    DuplicateOrchestrationNode {
        orchestration: CallableId,
        node: OrchestrationNodeId,
    },
    UnknownOrchestrationDependency {
        orchestration: CallableId,
        node: OrchestrationNodeId,
        dependency: OrchestrationNodeId,
    },
    CyclicOrchestration(CallableId),
    InvalidOrchestrationNode {
        orchestration: CallableId,
        node: OrchestrationNodeId,
        callable: CallableId,
    },
}

impl Display for CallableRegistryError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Duplicate(id) => write!(f, "callable already registered: {id}"),
            Self::Unknown(id) => write!(f, "unknown callable: {id}"),
            Self::WrongKind {
                callable,
                expected,
                actual,
            } => write!(
                f,
                "callable {callable} has kind {actual:?}, expected {expected:?}"
            ),
            Self::NotExecutable(id) => write!(f, "callable is not execution-provider backed: {id}"),
            Self::EmptyOrchestration(id) => write!(f, "orchestration has no nodes: {id}"),
            Self::DuplicateOrchestrationNode {
                orchestration,
                node,
            } => write!(
                f,
                "orchestration {orchestration} contains duplicate node id {node}"
            ),
            Self::UnknownOrchestrationDependency {
                orchestration,
                node,
                dependency,
            } => write!(
                f,
                "orchestration {orchestration} node {node} depends on unknown node {dependency}"
            ),
            Self::CyclicOrchestration(orchestration) => {
                write!(f, "orchestration {orchestration} contains a dependency cycle")
            }
            Self::InvalidOrchestrationNode {
                orchestration,
                node,
                callable,
            } => write!(
                f,
                "orchestration {orchestration} node {node} references non-executable or unknown callable {callable}"
            ),
        }
    }
}

impl Error for CallableRegistryError {}

enum CallableImplementation {
    Tool(Arc<ToolHandler>),
    Executable(ExecutionProviderBinding),
    Orchestration(Box<OrchestrationDefinition>),
}

struct CallableEntry {
    descriptor: CallableDescriptor,
    implementation: CallableImplementation,
}

impl CallableEntry {
    fn is_executable(&self) -> bool {
        matches!(&self.implementation, CallableImplementation::Executable(_))
    }
}

impl Debug for CallableEntry {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallableEntry")
            .field("descriptor", &self.descriptor)
            .field("executable", &self.is_executable())
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
pub struct CallableRegistry {
    entries: BTreeMap<CallableId, CallableEntry>,
}

impl Debug for CallableRegistry {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("CallableRegistry")
            .field("descriptors", &self.descriptors())
            .finish()
    }
}

impl CallableRegistry {
    pub fn register_tool<F, O>(
        &mut self,
        descriptor: CallableDescriptor,
        handler: F,
    ) -> Result<(), CallableRegistryError>
    where
        F: Fn(&str) -> Result<O, String> + Send + Sync + 'static,
        O: Into<ToolOutcome> + 'static,
    {
        let handler = move |arguments: &str| handler(arguments).map(Into::into);
        self.register(
            descriptor,
            CallableKind::Tool,
            CallableImplementation::Tool(Arc::new(handler)),
        )
    }

    /// Register the canonical model-backed agent provider.
    pub fn register_agent(
        &mut self,
        descriptor: CallableDescriptor,
    ) -> Result<(), CallableRegistryError> {
        self.register(
            descriptor,
            CallableKind::Agent,
            CallableImplementation::Executable(ExecutionProviderBinding::Model),
        )
    }

    /// Register an agent whose execution mechanism is conductor-neutral and
    /// supplied by an explicit provider rather than the model backend path.
    pub fn register_provider_agent<P>(
        &mut self,
        descriptor: CallableDescriptor,
        provider: P,
    ) -> Result<(), CallableRegistryError>
    where
        P: ExecutionProvider + 'static,
    {
        self.register(
            descriptor,
            CallableKind::Agent,
            CallableImplementation::Executable(ExecutionProviderBinding::Provider(Arc::new(
                provider,
            ))),
        )
    }

    pub fn register_orchestration(
        &mut self,
        mut definition: OrchestrationDefinition,
    ) -> Result<(), CallableRegistryError> {
        if definition.descriptor.kind != CallableKind::Orchestration {
            return Err(CallableRegistryError::WrongKind {
                callable: definition.descriptor.id,
                expected: CallableKind::Orchestration,
                actual: definition.descriptor.kind,
            });
        }
        if definition.nodes.is_empty() {
            return Err(CallableRegistryError::EmptyOrchestration(
                definition.descriptor.id,
            ));
        }

        let orchestration = definition.descriptor.id.clone();
        let mut nodes = BTreeMap::new();
        for mut node in definition.nodes.drain(..) {
            node.depends_on.sort();
            node.depends_on.dedup();
            let node_id = node.id.clone();
            if nodes.insert(node_id.clone(), node).is_some() {
                return Err(CallableRegistryError::DuplicateOrchestrationNode {
                    orchestration,
                    node: node_id,
                });
            }
        }

        for node in nodes.values() {
            let Some(entry) = self.entries.get(&node.callable) else {
                return Err(CallableRegistryError::InvalidOrchestrationNode {
                    orchestration: orchestration.clone(),
                    node: node.id.clone(),
                    callable: node.callable.clone(),
                });
            };
            if !entry.is_executable() {
                return Err(CallableRegistryError::InvalidOrchestrationNode {
                    orchestration: orchestration.clone(),
                    node: node.id.clone(),
                    callable: node.callable.clone(),
                });
            }
            for dependency in &node.depends_on {
                if !nodes.contains_key(dependency) {
                    return Err(CallableRegistryError::UnknownOrchestrationDependency {
                        orchestration: orchestration.clone(),
                        node: node.id.clone(),
                        dependency: dependency.clone(),
                    });
                }
            }
        }

        let mut indegree = nodes
            .iter()
            .map(|(id, node)| (id.clone(), node.depends_on.len()))
            .collect::<BTreeMap<_, _>>();
        let mut dependents = BTreeMap::<OrchestrationNodeId, Vec<OrchestrationNodeId>>::new();
        for node in nodes.values() {
            for dependency in &node.depends_on {
                dependents
                    .entry(dependency.clone())
                    .or_default()
                    .push(node.id.clone());
            }
        }
        for children in dependents.values_mut() {
            children.sort();
        }
        let mut ready = indegree
            .iter()
            .filter_map(|(id, count)| (*count == 0).then_some(id.clone()))
            .collect::<BTreeSet<_>>();
        let expected = nodes.len();
        let mut normalized = Vec::with_capacity(expected);
        while let Some(id) = ready.pop_first() {
            let node = nodes
                .remove(&id)
                .expect("ready node must exist in orchestration node map");
            if let Some(children) = dependents.get(&id) {
                for child in children {
                    let count = indegree
                        .get_mut(child)
                        .expect("dependent node must have indegree");
                    *count -= 1;
                    if *count == 0 {
                        ready.insert(child.clone());
                    }
                }
            }
            normalized.push(node);
        }
        if normalized.len() != expected {
            return Err(CallableRegistryError::CyclicOrchestration(orchestration));
        }
        definition.nodes = normalized;

        let descriptor = definition.descriptor.clone();
        self.register(
            descriptor,
            CallableKind::Orchestration,
            CallableImplementation::Orchestration(Box::new(definition)),
        )
    }

    fn register(
        &mut self,
        descriptor: CallableDescriptor,
        expected: CallableKind,
        implementation: CallableImplementation,
    ) -> Result<(), CallableRegistryError> {
        if descriptor.kind != expected {
            return Err(CallableRegistryError::WrongKind {
                callable: descriptor.id,
                expected,
                actual: descriptor.kind,
            });
        }
        if self.entries.contains_key(&descriptor.id) {
            return Err(CallableRegistryError::Duplicate(descriptor.id));
        }
        self.entries.insert(
            descriptor.id.clone(),
            CallableEntry {
                descriptor,
                implementation,
            },
        );
        Ok(())
    }

    #[must_use]
    pub fn descriptors(&self) -> Vec<CallableDescriptor> {
        self.entries
            .values()
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    #[must_use]
    pub fn tool_descriptors(&self) -> Vec<CallableDescriptor> {
        self.entries
            .values()
            .filter(|entry| entry.descriptor.kind == CallableKind::Tool)
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    pub fn descriptor(
        &self,
        id: &CallableId,
    ) -> Result<&CallableDescriptor, CallableRegistryError> {
        self.entries
            .get(id)
            .map(|entry| &entry.descriptor)
            .ok_or_else(|| CallableRegistryError::Unknown(id.clone()))
    }

    pub fn execution_provider(
        &self,
        id: &CallableId,
    ) -> Result<&ExecutionProviderBinding, CallableRegistryError> {
        let entry = self
            .entries
            .get(id)
            .ok_or_else(|| CallableRegistryError::Unknown(id.clone()))?;
        match &entry.implementation {
            CallableImplementation::Executable(provider) => Ok(provider),
            _ => Err(CallableRegistryError::NotExecutable(id.clone())),
        }
    }

    pub fn orchestration(
        &self,
        id: &CallableId,
    ) -> Result<&OrchestrationDefinition, CallableRegistryError> {
        let entry = self
            .entries
            .get(id)
            .ok_or_else(|| CallableRegistryError::Unknown(id.clone()))?;
        match &entry.implementation {
            CallableImplementation::Orchestration(definition) => Ok(definition.as_ref()),
            _ => Err(CallableRegistryError::WrongKind {
                callable: id.clone(),
                expected: CallableKind::Orchestration,
                actual: entry.descriptor.kind.clone(),
            }),
        }
    }

    #[must_use]
    pub fn contains(&self, id: &CallableId) -> bool {
        self.entries.contains_key(id)
    }

    pub fn invoke_tool(
        &self,
        id: &CallableId,
        arguments_json: &str,
    ) -> Result<ToolOutcome, CallableRegistryError> {
        let entry = self
            .entries
            .get(id)
            .ok_or_else(|| CallableRegistryError::Unknown(id.clone()))?;
        let CallableImplementation::Tool(handler) = &entry.implementation else {
            return Err(CallableRegistryError::WrongKind {
                callable: id.clone(),
                expected: CallableKind::Tool,
                actual: entry.descriptor.kind.clone(),
            });
        };
        Ok(match handler(arguments_json) {
            Ok(outcome) => outcome,
            Err(output) => ToolOutcome::failure(output),
        })
    }
}

impl ConductorRuntime {
    /// Start an agent or orchestration as a first-class top-level execution in a
    /// session. This is the conductor-owned entrypoint used by frontends; it
    /// does not synthesize a model-backed wrapper execution.
    pub fn start_session_callable(
        &mut self,
        session_id: &SessionId,
        callable: &CallableId,
        objective: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let objective = objective.into();
        if objective.trim().is_empty() {
            return Err(ConductorError::EmptyInput);
        }
        let descriptor = self.callables.descriptor(callable)?.clone();
        let execution_id = self.new_execution_id();

        match descriptor.kind {
            CallableKind::Agent => {
                self.callables.execution_provider(callable)?;
                self.check_session_callable_policy(
                    session_id,
                    &execution_id,
                    &descriptor,
                    CallableOperation::StartAgent,
                )?;
                self.create_session_callable_execution(
                    session_id,
                    execution_id,
                    ExecutionKind::Agent,
                    callable.clone(),
                    ExecutionPayload::Invocation {
                        input: objective.clone(),
                    },
                    objective,
                )
            }
            CallableKind::Orchestration => {
                let definition = self.callables.orchestration(callable)?.clone();
                self.check_session_callable_policy(
                    session_id,
                    &execution_id,
                    &definition.descriptor,
                    CallableOperation::StartOrchestration,
                )?;
                for node in &definition.nodes {
                    let node_descriptor = self.callables.descriptor(&node.callable)?.clone();
                    self.callables.execution_provider(&node.callable)?;
                    self.check_session_callable_policy(
                        session_id,
                        &execution_id,
                        &node_descriptor,
                        CallableOperation::StartAgentNode,
                    )?;
                }
                let summary = self.create_session_callable_execution(
                    session_id,
                    execution_id,
                    ExecutionKind::Orchestration,
                    callable.clone(),
                    ExecutionPayload::Orchestration {
                        objective: objective.clone(),
                        next_node: 0,
                    },
                    objective,
                )?;
                self.set_state(&summary.id, ExecutionState::Running)?;
                self.advance_orchestration(&summary.id)?;
                Ok(self
                    .executions
                    .get(&summary.id)
                    .expect("orchestration exists after top-level creation")
                    .summary
                    .clone())
            }
            CallableKind::Tool => {
                Err(CallableRegistryError::NotExecutable(callable.clone()).into())
            }
        }
    }

    fn check_session_callable_policy(
        &self,
        session_id: &SessionId,
        execution_id: &ExecutionId,
        descriptor: &CallableDescriptor,
        operation: CallableOperation,
    ) -> Result<(), ConductorError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?;
        let context = InvocationPolicyContext {
            session_id,
            execution_id,
            config_revision: &session.summary.config_revision,
            subject: InvocationSubject::Callable {
                descriptor,
                operation,
            },
        };
        self.policy
            .check(&context)
            .map_err(|denial| ConductorError::PolicyDenied {
                execution_id: execution_id.clone(),
                denial,
            })
    }

    fn create_session_callable_execution(
        &mut self,
        session_id: &SessionId,
        execution_id: ExecutionId,
        kind: ExecutionKind,
        callable: CallableId,
        payload: ExecutionPayload,
        user_input: String,
    ) -> Result<ExecutionSummary, ConductorError> {
        let target = self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?
            .summary
            .default_target
            .clone();
        let summary = ExecutionSummary {
            id: execution_id,
            session_id: session_id.clone(),
            parent_execution: None,
            kind,
            callable: Some(callable),
            target,
            state: ExecutionState::Pending,
        };
        self.record_domain_event(DomainEvent::ExecutionCreated {
            execution: summary.clone(),
            payload: JournalExecutionPayload::from(&payload),
        })?;
        self.push_event(
            &summary.id,
            ExecutionEventKind::UserInput { text: user_input },
        )?;
        self.push_event(
            &summary.id,
            ExecutionEventKind::ExecutionStateChanged {
                state: ExecutionState::Pending,
            },
        )?;
        Ok(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ExecutionProviderError, ExecutionProviderHost, ExecutionProviderKind,
        ExecutionProviderRequest,
    };
    use phenix_core::{
        BackendId, CallablePolicy, CapabilitySet, ExecutionTarget, InferenceOptions, ModelId,
        ModelTarget, OrchestrationNode, ProviderId,
    };
    use serde_json::json;

    fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind,
            description: "test callable".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    fn node(
        id: &str,
        callable: &str,
        depends_on: &[&str],
        objective: Option<&str>,
    ) -> OrchestrationNode {
        OrchestrationNode {
            id: OrchestrationNodeId::parse(id).unwrap(),
            callable: CallableId::parse(callable).unwrap(),
            depends_on: depends_on
                .iter()
                .map(|dependency| OrchestrationNodeId::parse(*dependency).unwrap())
                .collect(),
            objective: objective.map(str::to_owned),
        }
    }

    fn fixed(name: &str) -> ExecutionTarget {
        ExecutionTarget::Fixed(ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse(name).unwrap(),
            inference: InferenceOptions::default(),
        })
    }

    struct TestProvider;

    impl ExecutionProvider for TestProvider {
        fn kind(&self) -> ExecutionProviderKind {
            ExecutionProviderKind::Native
        }

        fn execute(
            &self,
            _request: &ExecutionProviderRequest,
            _host: &mut dyn ExecutionProviderHost,
        ) -> Result<(), ExecutionProviderError> {
            Ok(())
        }

        fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), ExecutionProviderError> {
            Ok(())
        }
    }

    #[test]
    fn ids_are_unique_across_callable_kinds() {
        let mut registry = CallableRegistry::default();
        registry
            .register_agent(descriptor("same", CallableKind::Agent))
            .unwrap();
        assert!(matches!(
            registry.register_tool(
                descriptor("same", CallableKind::Tool),
                |_| Ok(String::new())
            ),
            Err(CallableRegistryError::Duplicate(_))
        ));
    }

    #[test]
    fn execution_provider_binding_replaces_bare_agent_marker() {
        let mut registry = CallableRegistry::default();
        let model = CallableId::parse("model").unwrap();
        let native = CallableId::parse("native").unwrap();
        registry
            .register_agent(descriptor("model", CallableKind::Agent))
            .unwrap();
        registry
            .register_provider_agent(descriptor("native", CallableKind::Agent), TestProvider)
            .unwrap();

        assert_eq!(
            registry.execution_provider(&model).unwrap().kind(),
            crate::ExecutionProviderKind::Model
        );
        assert_eq!(
            registry.execution_provider(&native).unwrap().kind(),
            crate::ExecutionProviderKind::Native
        );
    }

    #[test]
    fn orchestrations_validate_executable_callable_references() {
        let mut registry = CallableRegistry::default();
        registry
            .register_provider_agent(descriptor("native", CallableKind::Agent), TestProvider)
            .unwrap();
        registry
            .register_orchestration(OrchestrationDefinition {
                descriptor: descriptor("orchestration", CallableKind::Orchestration),
                nodes: vec![node("run", "native", &[], None)],
            })
            .unwrap();
    }

    #[test]
    fn orchestrations_reject_duplicate_node_ids() {
        let mut registry = CallableRegistry::default();
        registry
            .register_agent(descriptor("worker", CallableKind::Agent))
            .unwrap();
        let error = registry
            .register_orchestration(OrchestrationDefinition {
                descriptor: descriptor("orchestration", CallableKind::Orchestration),
                nodes: vec![
                    node("work", "worker", &[], None),
                    node("work", "worker", &[], None),
                ],
            })
            .unwrap_err();
        assert_eq!(
            error,
            CallableRegistryError::DuplicateOrchestrationNode {
                orchestration: CallableId::parse("orchestration").unwrap(),
                node: OrchestrationNodeId::parse("work").unwrap(),
            }
        );
    }

    #[test]
    fn orchestrations_reject_unknown_dependencies() {
        let mut registry = CallableRegistry::default();
        registry
            .register_agent(descriptor("worker", CallableKind::Agent))
            .unwrap();
        let error = registry
            .register_orchestration(OrchestrationDefinition {
                descriptor: descriptor("orchestration", CallableKind::Orchestration),
                nodes: vec![node("work", "worker", &["missing"], None)],
            })
            .unwrap_err();
        assert!(matches!(
            error,
            CallableRegistryError::UnknownOrchestrationDependency { .. }
        ));
    }

    #[test]
    fn orchestrations_reject_dependency_cycles() {
        let mut registry = CallableRegistry::default();
        registry
            .register_agent(descriptor("worker", CallableKind::Agent))
            .unwrap();
        let error = registry
            .register_orchestration(OrchestrationDefinition {
                descriptor: descriptor("orchestration", CallableKind::Orchestration),
                nodes: vec![
                    node("first", "worker", &["second"], None),
                    node("second", "worker", &["first"], None),
                ],
            })
            .unwrap_err();
        assert!(matches!(
            error,
            CallableRegistryError::CyclicOrchestration(_)
        ));
    }

    #[test]
    fn orchestrations_normalize_to_deterministic_topological_order() {
        let mut registry = CallableRegistry::default();
        for callable in ["alpha", "beta", "gamma"] {
            registry
                .register_agent(descriptor(callable, CallableKind::Agent))
                .unwrap();
        }
        let orchestration = CallableId::parse("orchestration").unwrap();
        registry
            .register_orchestration(OrchestrationDefinition {
                descriptor: descriptor(orchestration.as_str(), CallableKind::Orchestration),
                nodes: vec![
                    node("gamma", "gamma", &["alpha"], None),
                    node("beta", "beta", &["alpha"], None),
                    node("alpha", "alpha", &[], None),
                ],
            })
            .unwrap();

        assert_eq!(
            registry
                .orchestration(&orchestration)
                .unwrap()
                .nodes
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "beta", "gamma"]
        );
    }

    #[test]
    fn tool_registry_executes_handler_without_owning_policy() {
        let mut registry = CallableRegistry::default();
        registry
            .register_tool(descriptor("echo", CallableKind::Tool), |arguments| {
                Ok(arguments.to_owned())
            })
            .unwrap();
        let result = registry
            .invoke_tool(&CallableId::parse("echo").unwrap(), r#"{"value":1}"#)
            .unwrap();
        assert!(result.success);
        assert_eq!(result.output, r#"{"value":1}"#);
    }

    #[test]
    fn session_agent_entrypoint_is_parentless_and_uses_session_target() {
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(descriptor("scout", CallableKind::Agent))
            .unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let execution = runtime
            .start_session_callable(&session.id, &CallableId::parse("scout").unwrap(), "inspect")
            .unwrap();

        assert_eq!(execution.parent_execution, None);
        assert_eq!(execution.kind, ExecutionKind::Agent);
        assert_eq!(
            execution.callable,
            Some(CallableId::parse("scout").unwrap())
        );
        assert_eq!(execution.target, fixed("fixed"));
        assert_eq!(execution.state, ExecutionState::Pending);
        let user_inputs = runtime
            .events_since(0)
            .into_iter()
            .filter_map(|event| {
                if event.execution_id != execution.id {
                    return None;
                }
                match event.kind {
                    ExecutionEventKind::UserInput { text } => Some(text),
                    _ => None,
                }
            })
            .collect::<Vec<_>>();
        assert_eq!(user_inputs, vec!["inspect"]);
    }

    #[test]
    fn session_workflow_entrypoint_creates_normal_child_execution_tree() {
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(descriptor("worker", CallableKind::Agent))
            .unwrap();
        runtime
            .register_orchestration(OrchestrationDefinition {
                descriptor: descriptor("implement", CallableKind::Orchestration),
                nodes: vec![node("worker", "worker", &[], None)],
            })
            .unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let orchestration = runtime
            .start_session_callable(
                &session.id,
                &CallableId::parse("implement").unwrap(),
                "implement it",
            )
            .unwrap();

        assert_eq!(orchestration.parent_execution, None);
        assert_eq!(orchestration.kind, ExecutionKind::Orchestration);
        assert_eq!(orchestration.state, ExecutionState::Running);
        let child = runtime
            .snapshot()
            .executions
            .into_iter()
            .find(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
            .expect("orchestration started its first ordinary child execution");
        assert_eq!(child.kind, ExecutionKind::Agent);
        assert_eq!(child.callable, Some(CallableId::parse("worker").unwrap()));
        let user_inputs = runtime
            .events_since(0)
            .into_iter()
            .filter_map(|event| match event.kind {
                ExecutionEventKind::UserInput { text } => Some((event.execution_id, text)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            user_inputs,
            vec![(orchestration.id.clone(), "implement it".to_owned())]
        );
    }
}
