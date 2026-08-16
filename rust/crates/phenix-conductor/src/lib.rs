#![forbid(unsafe_code)]

mod callables;
mod execution_provider;
mod persistence;
mod policy;
mod routing;
mod server;

pub use callables::{CallableRegistry, CallableRegistryError};
pub use execution_provider::{
    ExecutionProvider, ExecutionProviderBinding, ExecutionProviderError, ExecutionProviderEvent,
    ExecutionProviderHost, ExecutionProviderKind, ExecutionProviderRequest,
};
pub use persistence::{JsonFileStore, PersistenceError, RuntimeCheckpoint};
pub use policy::{
    CallableOperation, CallablePermissionGuard, InvocationGuard, InvocationPolicy,
    InvocationPolicyContext, InvocationSubject, PolicyDenial,
};
pub use routing::{RoutingRegistry, RoutingRegistryError};
pub use server::{ConductorServer, ServerError};

use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSessionRequest, PreparedToolSurface, ToolInvocation, ToolProvision, ToolResult,
};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, ConfigRevisionId, ExecutionEvent,
    ExecutionEventKind, ExecutionId, ExecutionKind, ExecutionState, ExecutionSummary,
    ExecutionTarget, ModelTarget, RoutingProfile, SessionId, SessionSummary, ToolCallId,
    WorkflowDefinition,
};
use phenix_protocol::RuntimeSnapshot;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConductorError {
    UnknownSession(SessionId),
    UnknownExecution(ExecutionId),
    EmptyInput,
    InvalidLifecycle(ExecutionId),
    NonModelExecution(ExecutionId),
    NonProviderExecution(ExecutionId),
    PolicyDenied {
        execution_id: ExecutionId,
        denial: PolicyDenial,
    },
    CallableRegistry(CallableRegistryError),
    ExecutionProvider(ExecutionProviderError),
    Routing(RoutingRegistryError),
    Backend(BackendError),
}

impl Display for ConductorError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSession(id) => write!(f, "unknown session: {id}"),
            Self::UnknownExecution(id) => write!(f, "unknown execution: {id}"),
            Self::EmptyInput => f.write_str("input must not be empty"),
            Self::InvalidLifecycle(id) => write!(f, "execution is not runnable: {id}"),
            Self::NonModelExecution(id) => {
                write!(f, "execution is not model-provider backed: {id}")
            }
            Self::NonProviderExecution(id) => {
                write!(f, "execution is not non-model-provider backed: {id}")
            }
            Self::PolicyDenied { denial, .. } => Display::fmt(denial, f),
            Self::CallableRegistry(error) => Display::fmt(error, f),
            Self::ExecutionProvider(error) => Display::fmt(error, f),
            Self::Routing(error) => Display::fmt(error, f),
            Self::Backend(error) => Display::fmt(error, f),
        }
    }
}

impl Error for ConductorError {}

impl From<BackendError> for ConductorError {
    fn from(value: BackendError) -> Self {
        Self::Backend(value)
    }
}

impl From<CallableRegistryError> for ConductorError {
    fn from(value: CallableRegistryError) -> Self {
        Self::CallableRegistry(value)
    }
}

impl From<ExecutionProviderError> for ConductorError {
    fn from(value: ExecutionProviderError) -> Self {
        Self::ExecutionProvider(value)
    }
}

impl From<RoutingRegistryError> for ConductorError {
    fn from(value: RoutingRegistryError) -> Self {
        Self::Routing(value)
    }
}

#[derive(Clone, Debug)]
struct SessionRecord {
    summary: SessionSummary,
}

/// Input owned by one executable child. The provider binding, not this payload,
/// decides whether the invocation is model-backed or handled by another
/// execution provider.
#[derive(Clone, Debug)]
enum ExecutionPayload {
    Invocation { input: String },
    Workflow { objective: String, next_step: usize },
}

#[derive(Clone, Debug)]
struct ExecutionRecord {
    summary: ExecutionSummary,
    payload: ExecutionPayload,
}

/// Immutable result of conductor-owned target resolution for one model step.
///
/// Once this value exists no downstream layer is allowed to route the step
/// again. It captures both the requested target and the concrete target so
/// diagnostics can explain a routed decision without making the backend aware
/// of routing profiles.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedInvocation {
    pub execution_id: ExecutionId,
    pub session_id: SessionId,
    pub config_revision: ConfigRevisionId,
    pub callable: Option<CallableId>,
    pub requested_target: ExecutionTarget,
    pub model: ModelTarget,
    pub prompt: String,
    pub tools: ToolProvision,
}

/// A resolved invocation after backend capability negotiation, lifecycle
/// validation, and conductor-owned policy evaluation. This is the only value
/// from which backend session/execution requests should be materialized.
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedInvocation {
    pub resolved: ResolvedInvocation,
    pub tools: PreparedToolSurface,
}

impl PreparedInvocation {
    #[must_use]
    pub fn backend_session_request(&self) -> BackendSessionRequest {
        BackendSessionRequest {
            model: self.resolved.model.clone(),
            tools: self.tools.clone(),
        }
    }

    #[must_use]
    pub fn backend_execution_request(&self) -> BackendExecutionRequest {
        BackendExecutionRequest {
            execution_id: self.resolved.execution_id.clone(),
            prompt: self.resolved.prompt.clone(),
        }
    }

    #[must_use]
    pub fn allowed_tools(&self) -> BTreeSet<CallableId> {
        self.tools
            .callables()
            .iter()
            .map(|descriptor| descriptor.id.clone())
            .collect()
    }
}

/// In-memory reference runtime proving conductor-owned semantics before
/// persistence and concrete backend adapters are introduced.
#[derive(Debug)]
pub struct ConductorRuntime {
    config_revision: ConfigRevisionId,
    sessions: BTreeMap<SessionId, SessionRecord>,
    executions: BTreeMap<ExecutionId, ExecutionRecord>,
    events: Vec<ExecutionEvent>,
    callables: CallableRegistry,
    routing: RoutingRegistry,
    policy: InvocationPolicy,
    event_sink: Option<std::sync::mpsc::SyncSender<ExecutionEvent>>,
    next_session: u64,
    next_execution: u64,
    next_event: u64,
    next_tool_call: u64,
}

impl Default for ConductorRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl ConductorRuntime {
    #[must_use]
    pub fn new() -> Self {
        Self {
            config_revision: ConfigRevisionId::parse("config-1").expect("static config id"),
            sessions: BTreeMap::new(),
            executions: BTreeMap::new(),
            events: Vec::new(),
            callables: CallableRegistry::default(),
            routing: RoutingRegistry::default(),
            policy: InvocationPolicy::new(),
            event_sink: None,
            next_session: 0,
            next_execution: 0,
            next_event: 0,
            next_tool_call: 0,
        }
    }

    pub fn register_invocation_guard<G>(&mut self, guard: G)
    where
        G: InvocationGuard + 'static,
    {
        self.policy.register(guard);
    }

    pub fn register_tool<F>(
        &mut self,
        descriptor: CallableDescriptor,
        handler: F,
    ) -> Result<(), ConductorError>
    where
        F: Fn(&str) -> Result<String, String> + Send + Sync + 'static,
    {
        self.callables.register_tool(descriptor, handler)?;
        Ok(())
    }

    /// Register the canonical model-backed agent provider.
    pub fn register_agent(&mut self, descriptor: CallableDescriptor) -> Result<(), ConductorError> {
        self.callables.register_agent(descriptor)?;
        Ok(())
    }

    /// Register an agent whose execution is supplied by a backend-neutral
    /// provider instead of the model backend path.
    pub fn register_provider_agent<P>(
        &mut self,
        descriptor: CallableDescriptor,
        provider: P,
    ) -> Result<(), ConductorError>
    where
        P: ExecutionProvider + 'static,
    {
        self.callables
            .register_provider_agent(descriptor, provider)?;
        Ok(())
    }

    pub fn register_workflow(
        &mut self,
        definition: WorkflowDefinition,
    ) -> Result<(), ConductorError> {
        self.callables.register_workflow(definition)?;
        Ok(())
    }

    pub fn register_routing_profile(
        &mut self,
        profile: RoutingProfile,
    ) -> Result<(), ConductorError> {
        self.routing.register(profile)?;
        Ok(())
    }

    #[must_use]
    pub fn callable_descriptors(&self) -> Vec<CallableDescriptor> {
        self.callables.descriptors()
    }

    #[must_use]
    pub fn tool_descriptors(&self) -> Vec<CallableDescriptor> {
        self.callables.tool_descriptors()
    }

    pub fn create_session(
        &mut self,
        parent_session: Option<SessionId>,
        name: Option<String>,
        target: ExecutionTarget,
    ) -> Result<SessionSummary, ConductorError> {
        if let Some(parent) = parent_session.as_ref() {
            if !self.sessions.contains_key(parent) {
                return Err(ConductorError::UnknownSession(parent.clone()));
            }
        }
        let id = self.new_session_id();
        let summary = SessionSummary {
            id: id.clone(),
            parent_session,
            name,
            config_revision: self.config_revision.clone(),
            default_target: target,
        };
        self.sessions.insert(
            id,
            SessionRecord {
                summary: summary.clone(),
            },
        );
        Ok(summary)
    }

    pub fn fork_session(
        &mut self,
        source: &SessionId,
        name: Option<String>,
    ) -> Result<SessionSummary, ConductorError> {
        let source = self
            .sessions
            .get(source)
            .ok_or_else(|| ConductorError::UnknownSession(source.clone()))?
            .summary
            .clone();
        self.create_session(Some(source.id), name, source.default_target)
    }

    pub fn submit(
        &mut self,
        session_id: &SessionId,
        text: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let text = text.into();
        if text.trim().is_empty() {
            return Err(ConductorError::EmptyInput);
        }
        let target = self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?
            .summary
            .default_target
            .clone();
        let summary = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: session_id.clone(),
            parent_execution: None,
            kind: ExecutionKind::Root,
            callable: None,
            target,
            state: ExecutionState::Pending,
        };
        self.executions.insert(
            summary.id.clone(),
            ExecutionRecord {
                summary: summary.clone(),
                payload: ExecutionPayload::Invocation {
                    input: text.clone(),
                },
            },
        );
        self.push_event(&summary.id, ExecutionEventKind::UserInput { text })?;
        self.push_event(
            &summary.id,
            ExecutionEventKind::ExecutionStateChanged {
                state: ExecutionState::Pending,
            },
        )?;
        Ok(summary)
    }

    pub fn start_agent(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        objective: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let descriptor = self.callables.descriptor(callable)?.clone();
        if descriptor.kind != CallableKind::Agent {
            return Err(CallableRegistryError::WrongKind {
                callable: callable.clone(),
                expected: CallableKind::Agent,
                actual: descriptor.kind,
            }
            .into());
        }
        self.callables.execution_provider(callable)?;
        self.check_callable_policy(parent_id, &descriptor, CallableOperation::StartAgent)?;
        self.create_child(
            parent_id,
            ExecutionKind::Agent,
            callable.clone(),
            ExecutionPayload::Invocation {
                input: objective.into(),
            },
        )
    }

    pub fn start_workflow(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        objective: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let definition = self.callables.workflow(callable)?.clone();
        self.check_callable_policy(
            parent_id,
            &definition.descriptor,
            CallableOperation::StartWorkflow,
        )?;
        for step in &definition.steps {
            let descriptor = self.callables.descriptor(&step.callable)?.clone();
            self.callables.execution_provider(&step.callable)?;
            self.check_callable_policy(
                parent_id,
                &descriptor,
                CallableOperation::StartWorkflowStep,
            )?;
        }
        let summary = self.create_child(
            parent_id,
            ExecutionKind::Workflow,
            callable.clone(),
            ExecutionPayload::Workflow {
                objective: objective.into(),
                next_step: 0,
            },
        )?;
        self.set_state(&summary.id, ExecutionState::Running)?;
        self.advance_workflow(&summary.id)?;
        Ok(self
            .executions
            .get(&summary.id)
            .expect("workflow exists after creation")
            .summary
            .clone())
    }

    fn create_child(
        &mut self,
        parent_id: &ExecutionId,
        kind: ExecutionKind,
        callable: CallableId,
        payload: ExecutionPayload,
    ) -> Result<ExecutionSummary, ConductorError> {
        let parent = self
            .executions
            .get(parent_id)
            .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?
            .summary
            .clone();
        let child = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: parent.session_id,
            parent_execution: Some(parent.id.clone()),
            kind,
            callable: Some(callable),
            target: parent.target,
            state: ExecutionState::Pending,
        };
        self.executions.insert(
            child.id.clone(),
            ExecutionRecord {
                summary: child.clone(),
                payload,
            },
        );
        self.push_event(
            parent_id,
            ExecutionEventKind::ChildExecutionStarted {
                child: child.id.clone(),
            },
        )?;
        self.push_event(
            &child.id,
            ExecutionEventKind::ExecutionStateChanged {
                state: ExecutionState::Pending,
            },
        )?;
        Ok(child)
    }

    pub fn execution_provider_kind(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<ExecutionProviderKind, ConductorError> {
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        match execution.summary.callable.as_ref() {
            None if execution.summary.kind == ExecutionKind::Root => {
                Ok(ExecutionProviderKind::Model)
            }
            Some(callable) => Ok(self.callables.execution_provider(callable)?.kind()),
            None => Err(ConductorError::NonProviderExecution(execution_id.clone())),
        }
    }

    /// Resolve routing and callable visibility exactly once for a model step.
    /// Backend capabilities intentionally do not participate in model routing.
    pub fn resolve_invocation(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<ResolvedInvocation, ConductorError> {
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        if execution.summary.kind == ExecutionKind::Workflow {
            return Err(ConductorError::NonModelExecution(execution_id.clone()));
        }
        if self.execution_provider_kind(execution_id)? != ExecutionProviderKind::Model {
            return Err(ConductorError::NonModelExecution(execution_id.clone()));
        }
        let ExecutionPayload::Invocation { input } = &execution.payload else {
            return Err(ConductorError::NonModelExecution(execution_id.clone()));
        };
        let requested_target = execution.summary.target.clone();
        let model = match &requested_target {
            ExecutionTarget::Fixed(model) => model.clone(),
            ExecutionTarget::Routed(profile) => self
                .routing
                .resolve(profile, execution.summary.callable.as_ref())?,
        };
        let session = self
            .sessions
            .get(&execution.summary.session_id)
            .expect("execution session invariant");
        Ok(ResolvedInvocation {
            execution_id: execution_id.clone(),
            session_id: execution.summary.session_id.clone(),
            config_revision: session.summary.config_revision.clone(),
            callable: execution.summary.callable.clone(),
            requested_target,
            model,
            prompt: input.clone(),
            tools: ToolProvision {
                callables: self.callables.tool_descriptors(),
            },
        })
    }

    /// Validate that a previously resolved invocation is still runnable, bind
    /// its semantic tool provision to one concrete backend presentation, then
    /// run the canonical model-dispatch policy gate. No routing lookup occurs in
    /// this phase.
    pub fn prepare_invocation(
        &self,
        resolved: ResolvedInvocation,
        capabilities: &BackendCapabilities,
    ) -> Result<PreparedInvocation, ConductorError> {
        let execution = self
            .executions
            .get(&resolved.execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(resolved.execution_id.clone()))?;
        if execution.summary.state != ExecutionState::Pending {
            return Err(ConductorError::InvalidLifecycle(resolved.execution_id));
        }
        let tools = resolved.tools.clone().prepare(capabilities)?;
        let prepared = PreparedInvocation { resolved, tools };
        self.check_model_policy(&prepared)?;
        Ok(prepared)
    }

    pub fn drive_execution(
        &mut self,
        execution_id: &ExecutionId,
        backend: &mut dyn Backend,
    ) -> Result<(), ConductorError> {
        let resolved = self.resolve_invocation(execution_id)?;
        let capabilities = backend.capabilities();
        let prepared = self.prepare_invocation(resolved, &capabilities)?;
        let allowed_tools = prepared.allowed_tools();
        let backend_session = backend.open_session(prepared.backend_session_request())?;
        self.set_state(execution_id, ExecutionState::Running)?;
        let request = prepared.backend_execution_request();
        let result = {
            let mut host = RuntimeHost {
                runtime: self,
                execution_id: execution_id.clone(),
                allowed_tools,
            };
            backend_session.execute(request, &mut host)
        };
        if let Err(error) = result {
            self.set_state(execution_id, ExecutionState::Failed)?;
            return Err(ConductorError::Backend(error));
        }
        let state = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?
            .summary
            .state
            .clone();
        if state == ExecutionState::Running {
            self.set_state(execution_id, ExecutionState::Completed)?;
        }
        Ok(())
    }

    /// Drive a non-model execution provider through the same execution tree and
    /// lifecycle used by model-backed agents. The conductor allocates IDs and
    /// owns state; the provider receives immutable request context and can emit
    /// normalized output only through its host.
    pub fn drive_provider_execution(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<(), ConductorError> {
        let (summary, input) = {
            let execution = self
                .executions
                .get(execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
            if execution.summary.state != ExecutionState::Pending {
                return Err(ConductorError::InvalidLifecycle(execution_id.clone()));
            }
            let ExecutionPayload::Invocation { input } = &execution.payload else {
                return Err(ConductorError::NonProviderExecution(execution_id.clone()));
            };
            (execution.summary.clone(), input.clone())
        };
        let callable = summary
            .callable
            .clone()
            .ok_or_else(|| ConductorError::NonProviderExecution(execution_id.clone()))?;
        let descriptor = self.callables.descriptor(&callable)?.clone();
        let binding = self.callables.execution_provider(&callable)?.clone();
        let Some(provider) = binding.provider().cloned() else {
            return Err(ConductorError::NonProviderExecution(execution_id.clone()));
        };
        self.check_callable_policy(
            execution_id,
            &descriptor,
            CallableOperation::DispatchProvider,
        )?;
        let config_revision = self
            .sessions
            .get(&summary.session_id)
            .expect("execution session invariant")
            .summary
            .config_revision
            .clone();
        let request = ExecutionProviderRequest {
            execution_id: execution_id.clone(),
            session_id: summary.session_id,
            parent_execution: summary.parent_execution,
            callable,
            config_revision,
            objective: input,
        };

        self.set_state(execution_id, ExecutionState::Running)?;
        let result = {
            let mut host = ProviderRuntimeHost {
                runtime: self,
                execution_id: execution_id.clone(),
            };
            provider.execute(&request, &mut host)
        };
        if let Err(error) = result {
            self.set_state(execution_id, ExecutionState::Failed)?;
            return Err(ConductorError::ExecutionProvider(error));
        }
        if self
            .executions
            .get(execution_id)
            .is_some_and(|execution| execution.summary.state == ExecutionState::Running)
        {
            self.set_state(execution_id, ExecutionState::Completed)?;
        }
        Ok(())
    }

    pub fn cancel_execution(&mut self, root: &ExecutionId) -> Result<(), ConductorError> {
        if !self.executions.contains_key(root) {
            return Err(ConductorError::UnknownExecution(root.clone()));
        }
        let mut cancelled = BTreeSet::from([root.clone()]);
        loop {
            let before = cancelled.len();
            for (id, record) in &self.executions {
                if record
                    .summary
                    .parent_execution
                    .as_ref()
                    .is_some_and(|parent| cancelled.contains(parent))
                {
                    cancelled.insert(id.clone());
                }
            }
            if cancelled.len() == before {
                break;
            }
        }
        for id in cancelled {
            let state = self
                .executions
                .get(&id)
                .expect("collected execution")
                .summary
                .state
                .clone();
            if !is_terminal(&state) {
                self.set_state(&id, ExecutionState::Cancelled)?;
            }
        }
        Ok(())
    }

    pub fn push_event(
        &mut self,
        execution_id: &ExecutionId,
        kind: ExecutionEventKind,
    ) -> Result<ExecutionEvent, ConductorError> {
        let session_id = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?
            .summary
            .session_id
            .clone();
        self.next_event += 1;
        let event = ExecutionEvent {
            sequence: self.next_event,
            session_id,
            execution_id: execution_id.clone(),
            kind,
        };
        self.events.push(event.clone());
        if self
            .event_sink
            .as_ref()
            .is_some_and(|sink| sink.send(event.clone()).is_err())
        {
            self.event_sink = None;
        }
        Ok(event)
    }

    pub fn set_state(
        &mut self,
        execution_id: &ExecutionId,
        state: ExecutionState,
    ) -> Result<(), ConductorError> {
        let (current, parent) = {
            let execution = self
                .executions
                .get(execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
            (
                execution.summary.state.clone(),
                execution.summary.parent_execution.clone(),
            )
        };
        if is_terminal(&current) {
            return Err(ConductorError::InvalidLifecycle(execution_id.clone()));
        }
        self.executions
            .get_mut(execution_id)
            .expect("checked execution")
            .summary
            .state = state.clone();
        self.push_event(
            execution_id,
            ExecutionEventKind::ExecutionStateChanged {
                state: state.clone(),
            },
        )?;
        if is_terminal(&state) {
            if let Some(parent) = parent {
                self.push_event(
                    &parent,
                    ExecutionEventKind::ChildExecutionFinished {
                        child: execution_id.clone(),
                        state,
                    },
                )?;
                self.refresh_workflow(&parent)?;
            }
        }
        Ok(())
    }

    fn refresh_workflow(&mut self, execution_id: &ExecutionId) -> Result<(), ConductorError> {
        let Some(workflow) = self.executions.get(execution_id) else {
            return Err(ConductorError::UnknownExecution(execution_id.clone()));
        };
        if workflow.summary.kind != ExecutionKind::Workflow || is_terminal(&workflow.summary.state)
        {
            return Ok(());
        }
        let states: Vec<ExecutionState> = self
            .executions
            .values()
            .filter(|record| record.summary.parent_execution.as_ref() == Some(execution_id))
            .map(|record| record.summary.state.clone())
            .collect();
        if states.contains(&ExecutionState::Failed) {
            self.set_state(execution_id, ExecutionState::Failed)?;
            return Ok(());
        }
        if states.contains(&ExecutionState::Cancelled) {
            self.set_state(execution_id, ExecutionState::Cancelled)?;
            return Ok(());
        }
        if states.contains(&ExecutionState::Interrupted) {
            self.set_state(execution_id, ExecutionState::Interrupted)?;
            return Ok(());
        }
        if states.iter().any(|state| !is_terminal(state)) {
            return Ok(());
        }
        self.advance_workflow(execution_id)
    }

    fn advance_workflow(&mut self, execution_id: &ExecutionId) -> Result<(), ConductorError> {
        let (callable, objective, next_step, state) = {
            let execution = self
                .executions
                .get(execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
            let ExecutionPayload::Workflow {
                objective,
                next_step,
            } = &execution.payload
            else {
                return Err(ConductorError::NonModelExecution(execution_id.clone()));
            };
            (
                execution
                    .summary
                    .callable
                    .clone()
                    .expect("workflow execution has callable"),
                objective.clone(),
                *next_step,
                execution.summary.state.clone(),
            )
        };
        if state != ExecutionState::Running {
            return Ok(());
        }
        let definition = self.callables.workflow(&callable)?.clone();
        if next_step >= definition.steps.len() {
            self.set_state(execution_id, ExecutionState::Completed)?;
            return Ok(());
        }
        let step = definition.steps[next_step].clone();
        let ExecutionPayload::Workflow { next_step, .. } = &mut self
            .executions
            .get_mut(execution_id)
            .expect("workflow exists")
            .payload
        else {
            unreachable!("workflow execution payload")
        };
        *next_step += 1;
        self.start_agent(
            execution_id,
            &step.callable,
            step.objective.unwrap_or(objective),
        )?;
        Ok(())
    }

    pub fn subscribe_events(
        &mut self,
        capacity: usize,
    ) -> std::sync::mpsc::Receiver<ExecutionEvent> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(capacity.max(1));
        self.event_sink = Some(sender);
        receiver
    }

    pub fn unsubscribe_events(&mut self) {
        self.event_sink = None;
    }

    #[must_use]
    pub fn events_since(&self, sequence: u64) -> Vec<ExecutionEvent> {
        self.events
            .iter()
            .filter(|event| event.sequence > sequence)
            .cloned()
            .collect()
    }

    #[must_use]
    pub fn snapshot(&self) -> RuntimeSnapshot {
        RuntimeSnapshot {
            sessions: self
                .sessions
                .values()
                .map(|record| record.summary.clone())
                .collect(),
            executions: self
                .executions
                .values()
                .map(|record| record.summary.clone())
                .collect(),
            last_event_sequence: self.next_event,
        }
    }

    fn check_callable_policy(
        &self,
        execution_id: &ExecutionId,
        descriptor: &CallableDescriptor,
        operation: CallableOperation,
    ) -> Result<(), ConductorError> {
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        let session = self
            .sessions
            .get(&execution.summary.session_id)
            .expect("execution session invariant");
        let context = InvocationPolicyContext {
            session_id: &execution.summary.session_id,
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

    fn check_model_policy(&self, prepared: &PreparedInvocation) -> Result<(), ConductorError> {
        let context = InvocationPolicyContext {
            session_id: &prepared.resolved.session_id,
            execution_id: &prepared.resolved.execution_id,
            config_revision: &prepared.resolved.config_revision,
            subject: InvocationSubject::Model {
                invocation: prepared,
            },
        };
        self.policy
            .check(&context)
            .map_err(|denial| ConductorError::PolicyDenied {
                execution_id: prepared.resolved.execution_id.clone(),
                denial,
            })
    }

    fn invoke_tool(
        &mut self,
        execution_id: &ExecutionId,
        allowed_tools: &BTreeSet<CallableId>,
        invocation: ToolInvocation,
    ) -> Result<ToolResult, BackendError> {
        if !allowed_tools.contains(&invocation.callable)
            || !self.callables.contains(&invocation.callable)
        {
            return Err(BackendError::Protocol(format!(
                "backend invoked unprovisioned tool {}",
                invocation.callable
            )));
        }
        let tool_call_id = self.new_tool_call_id();
        self.push_event(
            execution_id,
            ExecutionEventKind::ToolCallStarted {
                tool_call_id: tool_call_id.clone(),
                callable: invocation.callable.clone(),
            },
        )
        .map_err(conductor_protocol_error)?;
        self.push_event(
            execution_id,
            ExecutionEventKind::ToolCallArguments {
                tool_call_id: tool_call_id.clone(),
                arguments: invocation.arguments_json.clone(),
            },
        )
        .map_err(conductor_protocol_error)?;

        let descriptor = self
            .callables
            .descriptor(&invocation.callable)
            .map_err(|error| BackendError::Protocol(error.to_string()))?
            .clone();
        let result = match self.check_callable_policy(
            execution_id,
            &descriptor,
            CallableOperation::InvokeTool,
        ) {
            Ok(()) => match serde_json::from_str::<Value>(&invocation.arguments_json) {
                Ok(_) => self
                    .callables
                    .invoke_tool(&invocation.callable, &invocation.arguments_json)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?,
                Err(error) => ToolResult {
                    output: format!("invalid JSON tool arguments: {error}"),
                    success: false,
                },
            },
            Err(ConductorError::PolicyDenied { denial, .. }) => ToolResult {
                output: denial.message,
                success: false,
            },
            Err(error) => return Err(conductor_protocol_error(error)),
        };
        self.push_event(
            execution_id,
            ExecutionEventKind::ToolCallFinished {
                tool_call_id,
                output: result.output.clone(),
                success: result.success,
            },
        )
        .map_err(conductor_protocol_error)?;
        Ok(result)
    }

    fn new_session_id(&mut self) -> SessionId {
        self.next_session += 1;
        SessionId::parse(format!("session-{}", self.next_session)).expect("generated id")
    }

    fn new_execution_id(&mut self) -> ExecutionId {
        self.next_execution += 1;
        ExecutionId::parse(format!("execution-{}", self.next_execution)).expect("generated id")
    }

    fn new_tool_call_id(&mut self) -> ToolCallId {
        self.next_tool_call += 1;
        ToolCallId::parse(format!("tool-call-{}", self.next_tool_call)).expect("generated id")
    }
}

fn conductor_protocol_error(error: ConductorError) -> BackendError {
    BackendError::Protocol(error.to_string())
}

fn is_terminal(state: &ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Completed
            | ExecutionState::Failed
            | ExecutionState::Cancelled
            | ExecutionState::Interrupted
    )
}

struct RuntimeHost<'a> {
    runtime: &'a mut ConductorRuntime,
    execution_id: ExecutionId,
    allowed_tools: BTreeSet<CallableId>,
}

impl BackendHost for RuntimeHost<'_> {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError> {
        let event = match event {
            BackendEvent::ContentDelta(text) => ExecutionEventKind::AssistantContentDelta { text },
            BackendEvent::ReasoningDelta(text) => ExecutionEventKind::ReasoningDelta { text },
        };
        self.runtime
            .push_event(&self.execution_id, event)
            .map(|_| ())
            .map_err(conductor_protocol_error)
    }

    fn invoke_tool(&mut self, invocation: ToolInvocation) -> Result<ToolResult, BackendError> {
        self.runtime
            .invoke_tool(&self.execution_id, &self.allowed_tools, invocation)
    }
}

struct ProviderRuntimeHost<'a> {
    runtime: &'a mut ConductorRuntime,
    execution_id: ExecutionId,
}

impl ExecutionProviderHost for ProviderRuntimeHost<'_> {
    fn emit(&mut self, event: ExecutionProviderEvent) -> Result<(), ExecutionProviderError> {
        let event = match event {
            ExecutionProviderEvent::ContentDelta(text) => {
                ExecutionEventKind::AssistantContentDelta { text }
            }
            ExecutionProviderEvent::ReasoningDelta(text) => {
                ExecutionEventKind::ReasoningDelta { text }
            }
        };
        self.runtime
            .push_event(&self.execution_id, event)
            .map(|_| ())
            .map_err(|error| ExecutionProviderError::Protocol(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{
        BackendId, CallablePolicy, CapabilitySet, InferenceOptions, ModelId, ProviderId,
        RoutingProfileId,
    };
    use serde_json::json;

    fn fixed(name: &str) -> ExecutionTarget {
        ExecutionTarget::Fixed(ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse(name).unwrap(),
            inference: InferenceOptions::default(),
        })
    }

    fn agent(id: &str) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind: CallableKind::Agent,
            description: "test agent".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    #[test]
    fn session_lineage_is_distinct_from_execution_parentage() {
        let mut runtime = ConductorRuntime::new();
        let root = runtime.create_session(None, None, fixed("a")).unwrap();
        let fork = runtime.fork_session(&root.id, None).unwrap();
        let execution = runtime.submit(&fork.id, "work").unwrap();
        assert_eq!(fork.parent_session, Some(root.id));
        assert_eq!(execution.parent_execution, None);
    }

    #[test]
    fn fixed_parent_forces_callable_child_target() {
        let mut runtime = ConductorRuntime::new();
        runtime.register_agent(agent("scout")).unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let root = runtime.submit(&session.id, "work").unwrap();
        let child = runtime
            .start_agent(&root.id, &CallableId::parse("scout").unwrap(), "child")
            .unwrap();
        assert_eq!(child.target, fixed("fixed"));
    }

    #[test]
    fn cancellation_cascades_to_descendants() {
        let mut runtime = ConductorRuntime::new();
        runtime.register_agent(agent("scout")).unwrap();
        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        let root = runtime.submit(&session.id, "work").unwrap();
        let child = runtime
            .start_agent(&root.id, &CallableId::parse("scout").unwrap(), "child")
            .unwrap();
        runtime.cancel_execution(&root.id).unwrap();
        let snapshot = runtime.snapshot();
        assert!(snapshot
            .executions
            .iter()
            .filter(|execution| execution.id == root.id || execution.id == child.id)
            .all(|execution| execution.state == ExecutionState::Cancelled));
    }

    #[test]
    fn resolved_invocation_records_routing_origin_and_concrete_target() {
        let mut runtime = ConductorRuntime::new();
        let profile = RoutingProfileId::parse("default").unwrap();
        let concrete = ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse("routed").unwrap(),
            inference: InferenceOptions::default(),
        };
        runtime
            .register_routing_profile(RoutingProfile {
                id: profile.clone(),
                default_target: concrete.clone(),
                callable_targets: BTreeMap::new(),
            })
            .unwrap();
        let session = runtime
            .create_session(None, None, ExecutionTarget::Routed(profile.clone()))
            .unwrap();
        let execution = runtime.submit(&session.id, "work").unwrap();
        let resolved = runtime.resolve_invocation(&execution.id).unwrap();

        assert_eq!(resolved.requested_target, ExecutionTarget::Routed(profile));
        assert_eq!(resolved.model, concrete);
        assert_eq!(resolved.session_id, session.id);
        assert_eq!(resolved.config_revision.as_str(), "config-1");
    }
}
