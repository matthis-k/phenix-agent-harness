#![forbid(unsafe_code)]

mod callables;
#[cfg(test)]
mod config_revision_tests;
mod context;
mod execution_provider;
mod failure_decisions;
mod journal;
mod persistence;
mod policy;
mod routing;
mod sandbox;
mod server;

pub use callables::{CallableRegistry, CallableRegistryError, ToolOutcome};
pub use context::{ContextError, ContextRegistry, SkillRegistry};
pub use execution_provider::{
    ExecutionProvider, ExecutionProviderBinding, ExecutionProviderError, ExecutionProviderEvent,
    ExecutionProviderHost, ExecutionProviderKind, ExecutionProviderRequest,
};
pub use failure_decisions::OrchestrationFailureDecisionRequest;
pub use journal::{
    DomainEvent, JournalEntry, JournalError, JournalExecutionPayload, ResolvedRoute, RuntimeJournal,
};
pub use persistence::{PersistenceError, SqliteStore};
pub use policy::{
    CallableOperation, CallablePermissionGuard, InvocationGuard, InvocationPolicy,
    InvocationPolicyContext, InvocationSubject, PolicyDenial,
};
pub use routing::{RoutingRegistry, RoutingRegistryError};
pub use server::{ConductorServer, ConductorService, ServerError};

use journal::{apply_domain_event, DurableProjection};
use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSessionRequest, PreparedToolSurface, ToolInvocation, ToolProvision, ToolResult,
};
use phenix_core::{
    AgentDefinition, AttemptGroup, AttemptGroupId, CallableDescriptor, CallableId, CallableKind,
    ConfigRevisionId, DebugConversationMessage, DebugConversationRole, DebugOrchestration,
    DebugResolvedRoute, DebugWorkspaceCheckpoint, DiagnosticWritePatch, ExecutionAuthority,
    ExecutionEvent, ExecutionEventKind, ExecutionId, ExecutionKind, ExecutionReadSet,
    ExecutionState, ExecutionSummary, ExecutionTarget, ExecutionTerminationCause,
    ExecutionWorkspaceValidity, FileObservation, FileVersion, ModelTarget, OrchestrationDefinition,
    OrchestrationFailureDecisionRecord, OrchestrationNodeId, RoutingProfile,
    RoutingProfileDescriptor, SessionDebugBundle, SessionId, SessionState, SessionSummary,
    SkillDescriptor, SkillId, ToolCallId, WorkspaceDescriptor, WorkspaceId, WorkspaceLeaseRequest,
};
use phenix_protocol::RuntimeSnapshot;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::PathBuf;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct ConfigRevisionFingerprint(String);

impl Display for ConfigRevisionFingerprint {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConductorError {
    UnknownSession(SessionId),
    UnknownConfigRevision(ConfigRevisionId),
    UnboundConfigRevision(ConfigRevisionId),
    ConfigRevisionAlreadyBound(ConfigRevisionId),
    ConfigRevisionFingerprintMismatch {
        revision: ConfigRevisionId,
        expected: ConfigRevisionFingerprint,
        actual: ConfigRevisionFingerprint,
    },
    IncompatibleSessionRebase {
        session_id: SessionId,
        revision: ConfigRevisionId,
        reason: String,
    },
    ClosedSession(SessionId),
    SessionHasActiveExecutions(SessionId),
    UnknownExecution(ExecutionId),
    WorkspaceMismatch {
        expected: WorkspaceId,
        actual: WorkspaceId,
    },
    EmptyInput,
    InvalidExecutionData {
        execution_id: ExecutionId,
        message: String,
    },
    InvalidLifecycle(ExecutionId),
    InvalidFailureDecision {
        parent_execution: ExecutionId,
        failed_child: ExecutionId,
    },
    FailureDecisionDenied {
        parent_execution: ExecutionId,
        decider_execution: ExecutionId,
    },
    DelegationDenied {
        parent_execution: ExecutionId,
        callable: CallableId,
    },
    NonModelExecution(ExecutionId),
    NonProviderExecution(ExecutionId),
    PolicyDenied {
        execution_id: ExecutionId,
        denial: PolicyDenial,
    },
    CallableRegistry(CallableRegistryError),
    ExecutionProvider(ExecutionProviderError),
    Journal(JournalError),
    Routing(RoutingRegistryError),
    Context(ContextError),
    Backend(BackendError),
}

impl Display for ConductorError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSession(id) => write!(f, "unknown session: {id}"),
            Self::UnknownConfigRevision(id) => write!(f, "unknown configuration revision: {id}"),
            Self::UnboundConfigRevision(id) => write!(f, "configuration revision is not bound in this process: {id}"),
            Self::ConfigRevisionAlreadyBound(id) => write!(f, "configuration revision is already bound: {id}"),
            Self::ConfigRevisionFingerprintMismatch {
                revision,
                expected,
                actual,
            } => write!(
                f,
                "configuration revision fingerprint mismatch for {revision}: expected {expected}, found {actual}"
            ),
            Self::IncompatibleSessionRebase {
                session_id,
                revision,
                reason,
            } => write!(
                f,
                "session {session_id} cannot rebase to configuration revision {revision}: {reason}"
            ),
            Self::ClosedSession(id) => write!(f, "session is closed: {id}"),
            Self::SessionHasActiveExecutions(id) => {
                write!(f, "session has active executions and cannot close: {id}")
            }
            Self::UnknownExecution(id) => write!(f, "unknown execution: {id}"),
            Self::WorkspaceMismatch { expected, actual } => write!(
                f,
                "workspace binding mismatch: persisted {expected}, discovered {actual}"
            ),
            Self::EmptyInput => f.write_str("input must not be empty"),
            Self::InvalidExecutionData {
                execution_id,
                message,
            } => write!(f, "execution {execution_id} has invalid typed data: {message}"),
            Self::InvalidLifecycle(id) => write!(f, "execution is not runnable: {id}"),
            Self::InvalidFailureDecision {
                parent_execution,
                failed_child,
            } => write!(
                f,
                "invalid failure decision for child {failed_child} of orchestration {parent_execution}"
            ),
            Self::FailureDecisionDenied {
                parent_execution,
                decider_execution,
            } => write!(
                f,
                "execution {decider_execution} may not decide failures for orchestration {parent_execution}"
            ),
            Self::DelegationDenied {
                parent_execution,
                callable,
            } => write!(
                f,
                "execution {parent_execution} may not delegate callable {callable}"
            ),
            Self::NonModelExecution(id) => {
                write!(f, "execution is not model-provider backed: {id}")
            }
            Self::NonProviderExecution(id) => {
                write!(f, "execution is not non-model-provider backed: {id}")
            }
            Self::PolicyDenied { denial, .. } => Display::fmt(denial, f),
            Self::CallableRegistry(error) => Display::fmt(error, f),
            Self::ExecutionProvider(error) => Display::fmt(error, f),
            Self::Journal(error) => Display::fmt(error, f),
            Self::Routing(error) => Display::fmt(error, f),
            Self::Context(error) => Display::fmt(error, f),
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

impl From<JournalError> for ConductorError {
    fn from(value: JournalError) -> Self {
        Self::Journal(value)
    }
}

impl From<RoutingRegistryError> for ConductorError {
    fn from(value: RoutingRegistryError) -> Self {
        Self::Routing(value)
    }
}

impl From<ContextError> for ConductorError {
    fn from(value: ContextError) -> Self {
        Self::Context(value)
    }
}

#[derive(Clone, Debug)]
struct SessionRecord {
    summary: SessionSummary,
}

#[derive(Clone, Debug)]
enum ExecutionPayload {
    Invocation { input: String },
    Orchestration { input: Value },
}

#[derive(Clone, Debug)]
struct ExecutionRecord {
    summary: ExecutionSummary,
    payload: ExecutionPayload,
    authority: ExecutionAuthority,
    config_revision: ConfigRevisionId,
}

#[derive(Clone, Debug, Default)]
pub struct CompiledConfiguration {
    callables: CallableRegistry,
    routing: RoutingRegistry,
    context: ContextRegistry,
    skills: SkillRegistry,
}

impl CompiledConfiguration {
    fn fingerprint(&self) -> ConfigRevisionFingerprint {
        let manifest = json!({
            "callables": self.callables.semantic_manifest(),
            "routing": self.routing.semantic_manifest(),
            "context": self.context.semantic_manifest(),
            "skills": self.skills.semantic_manifest(),
        });
        let encoded = serde_json::to_vec(&manifest)
            .expect("compiled configuration manifest is JSON serializable");
        let digest = Sha256::digest(encoded);
        let encoded = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        ConfigRevisionFingerprint(encoded)
    }

    pub fn register_tool<F, O>(
        &mut self,
        descriptor: CallableDescriptor,
        handler: F,
    ) -> Result<(), ConductorError>
    where
        F: Fn(&str) -> Result<O, String> + Send + Sync + 'static,
        O: Into<ToolOutcome> + 'static,
    {
        self.callables.register_tool(descriptor, handler)?;
        Ok(())
    }

    pub(crate) fn register_contextual_tool<F, O>(
        &mut self,
        descriptor: CallableDescriptor,
        handler: F,
    ) -> Result<(), ConductorError>
    where
        F: Fn(&callables::ToolExecutionContext, &str) -> Result<O, String> + Send + Sync + 'static,
        O: Into<ToolOutcome> + 'static,
    {
        self.callables
            .register_contextual_tool(descriptor, handler)?;
        Ok(())
    }

    pub fn register_agent(&mut self, definition: AgentDefinition) -> Result<(), ConductorError> {
        self.callables.register_agent(definition)?;
        Ok(())
    }

    pub fn register_provider_agent<P>(
        &mut self,
        definition: AgentDefinition,
        provider: P,
    ) -> Result<(), ConductorError>
    where
        P: ExecutionProvider + 'static,
    {
        self.callables
            .register_provider_agent(definition, provider)?;
        Ok(())
    }

    pub fn register_orchestration(
        &mut self,
        definition: OrchestrationDefinition,
    ) -> Result<(), ConductorError> {
        self.callables.register_orchestration(definition)?;
        Ok(())
    }

    pub fn register_routing_profile(
        &mut self,
        profile: RoutingProfile,
    ) -> Result<(), ConductorError> {
        self.routing.register(profile)?;
        Ok(())
    }

    pub fn install_context_registry(&mut self, context: ContextRegistry) {
        self.context = context;
    }

    pub fn install_skill_registry(&mut self, skills: SkillRegistry) {
        self.skills = skills;
    }

    #[must_use]
    pub fn callable_descriptors(&self) -> Vec<CallableDescriptor> {
        self.callables.descriptors()
    }

    #[must_use]
    pub fn tool_descriptors(&self) -> Vec<CallableDescriptor> {
        self.callables.tool_descriptors()
    }

    #[must_use]
    pub fn routing_profiles(&self) -> Vec<RoutingProfileDescriptor> {
        self.routing.descriptors()
    }

    #[must_use]
    pub fn skill_descriptors(&self) -> Vec<SkillDescriptor> {
        self.skills.skill_descriptors()
    }

    #[must_use]
    pub fn has_model_invocable_skills(&self) -> bool {
        self.skills.has_model_invocable_skills()
    }

    #[must_use]
    pub fn has_skills(&self) -> bool {
        self.skills.has_skills()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ConfigRevisionSlot {
    pub fingerprint: ConfigRevisionFingerprint,
    pub configuration: Option<CompiledConfiguration>,
}

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

#[derive(Debug)]
pub struct ConductorRuntime {
    config_revision: ConfigRevisionId,
    config_revisions: BTreeMap<ConfigRevisionId, ConfigRevisionSlot>,
    workspace_id: WorkspaceId,
    sessions: BTreeMap<SessionId, SessionRecord>,
    executions: BTreeMap<ExecutionId, ExecutionRecord>,
    root_ingress: BTreeMap<ExecutionId, u64>,
    next_root_ingress: BTreeMap<SessionId, u64>,
    attempt_groups: BTreeMap<AttemptGroupId, AttemptGroup>,
    orchestration_decisions: BTreeMap<ExecutionId, OrchestrationFailureDecisionRecord>,
    orchestration_interfaces: BTreeMap<ExecutionId, ExecutionId>,
    orchestration_nodes: BTreeMap<ExecutionId, OrchestrationNodeId>,
    orchestration_node_inputs: BTreeMap<(ExecutionId, OrchestrationNodeId), Value>,
    orchestration_synthesis: BTreeMap<ExecutionId, ExecutionId>,
    execution_outputs: BTreeMap<ExecutionId, Value>,
    diagnostic_write_patches: Vec<DiagnosticWritePatch>,
    resolved_routes: BTreeMap<ExecutionId, ResolvedRoute>,
    read_sets: BTreeMap<ExecutionId, ExecutionReadSet>,
    events: Vec<ExecutionEvent>,
    journal: RuntimeJournal,
    skill_activations: BTreeMap<ExecutionId, BTreeSet<SkillId>>,
    sandbox_states: BTreeMap<ExecutionId, std::sync::Arc<sandbox::ExecutionSandboxState>>,
    policy: InvocationPolicy,
    event_sinks: BTreeMap<u64, std::sync::mpsc::Sender<ExecutionEvent>>,
    next_event_subscription: u64,
    next_config_revision: u64,
    next_session: u64,
    next_execution: u64,
    next_attempt_group: u64,
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
        let config_revision = ConfigRevisionId::parse("config-1").expect("static config id");
        let workspace_id = WorkspaceId::parse("workspace:in-memory").expect("static workspace id");
        let configuration = CompiledConfiguration::default();
        let fingerprint = configuration.fingerprint();
        let config_revisions = BTreeMap::from([(
            config_revision.clone(),
            ConfigRevisionSlot {
                fingerprint: fingerprint.clone(),
                configuration: Some(configuration),
            },
        )]);
        Self {
            journal: RuntimeJournal::new(config_revision.clone(), fingerprint),
            config_revision,
            config_revisions,
            workspace_id,
            sessions: BTreeMap::new(),
            executions: BTreeMap::new(),
            root_ingress: BTreeMap::new(),
            next_root_ingress: BTreeMap::new(),
            attempt_groups: BTreeMap::new(),
            orchestration_decisions: BTreeMap::new(),
            orchestration_interfaces: BTreeMap::new(),
            orchestration_nodes: BTreeMap::new(),
            orchestration_node_inputs: BTreeMap::new(),
            orchestration_synthesis: BTreeMap::new(),
            execution_outputs: BTreeMap::new(),
            diagnostic_write_patches: Vec::new(),
            resolved_routes: BTreeMap::new(),
            read_sets: BTreeMap::new(),
            events: Vec::new(),
            skill_activations: BTreeMap::new(),
            sandbox_states: BTreeMap::new(),
            policy: InvocationPolicy::new(),
            event_sinks: BTreeMap::new(),
            next_event_subscription: 0,
            next_config_revision: 1,
            next_session: 0,
            next_execution: 0,
            next_attempt_group: 0,
            next_event: 0,
            next_tool_call: 0,
        }
    }

    pub fn bind_workspace(&mut self, workspace_id: WorkspaceId) -> Result<(), ConductorError> {
        if let Some(session) = self
            .sessions
            .values()
            .find(|session| session.summary.workspace_id != workspace_id)
        {
            return Err(ConductorError::WorkspaceMismatch {
                expected: session.summary.workspace_id.clone(),
                actual: workspace_id,
            });
        }
        self.workspace_id = workspace_id;
        Ok(())
    }

    fn record_domain_event(&mut self, event: DomainEvent) -> Result<(), ConductorError> {
        let frontend_event = match &event {
            DomainEvent::FrontendEvent { event } => Some(event.clone()),
            _ => None,
        };
        let sequence = u64::try_from(self.journal.entries.len())
            .map_err(|_| JournalError::InvalidFormat("journal is too large".to_owned()))?
            + 1;
        self.journal.entries.push(JournalEntry {
            sequence,
            event: event.clone(),
        });
        let result = {
            let mut projection = DurableProjection {
                config_revisions: &mut self.config_revisions,
                current_config_revision: &mut self.config_revision,
                sessions: &mut self.sessions,
                executions: &mut self.executions,
                root_ingress: &mut self.root_ingress,
                next_root_ingress: &mut self.next_root_ingress,
                attempt_groups: &mut self.attempt_groups,
                orchestration_decisions: &mut self.orchestration_decisions,
                orchestration_interfaces: &mut self.orchestration_interfaces,
                orchestration_nodes: &mut self.orchestration_nodes,
                orchestration_node_inputs: &mut self.orchestration_node_inputs,
                orchestration_synthesis: &mut self.orchestration_synthesis,
                execution_outputs: &mut self.execution_outputs,
                diagnostic_write_patches: &mut self.diagnostic_write_patches,
                resolved_routes: &mut self.resolved_routes,
                read_sets: &mut self.read_sets,
                events: &mut self.events,
                next_config_revision: &mut self.next_config_revision,
                next_session: &mut self.next_session,
                next_execution: &mut self.next_execution,
                next_attempt_group: &mut self.next_attempt_group,
                next_event: &mut self.next_event,
                next_tool_call: &mut self.next_tool_call,
            };
            apply_domain_event(&mut projection, &event)
        };
        if let Err(error) = result {
            self.journal.entries.pop();
            return Err(error.into());
        }
        if let Some(event) = frontend_event {
            self.event_sinks
                .retain(|_, sink| sink.send(event.clone()).is_ok());
        }
        Ok(())
    }

    fn record_execution_created(
        &mut self,
        execution: ExecutionSummary,
        mut payload: JournalExecutionPayload,
        restrictions: Option<&ExecutionAuthority>,
    ) -> Result<(), ConductorError> {
        let configured = self.effective_authority_for_execution(&execution)?;
        let effective = restrictions.map_or(configured.clone(), |requested| {
            configured.attenuate(requested)
        });
        payload.set_authority(effective);
        self.record_domain_event(DomainEvent::ExecutionCreated { execution, payload })
    }

    pub fn register_invocation_guard<G>(&mut self, guard: G)
    where
        G: InvocationGuard + 'static,
    {
        self.policy.register(guard);
    }

    fn current_configuration(&self) -> Result<&CompiledConfiguration, ConductorError> {
        self.configuration_revision(&self.config_revision)
    }

    pub fn current_compiled_configuration(&self) -> Result<CompiledConfiguration, ConductorError> {
        Ok(self.current_configuration()?.clone())
    }

    pub(crate) fn configuration_revision(
        &self,
        revision: &ConfigRevisionId,
    ) -> Result<&CompiledConfiguration, ConductorError> {
        self.config_revisions
            .get(revision)
            .ok_or_else(|| ConductorError::UnknownConfigRevision(revision.clone()))?
            .configuration
            .as_ref()
            .ok_or_else(|| ConductorError::UnboundConfigRevision(revision.clone()))
    }

    pub(crate) fn configuration_for_session(
        &self,
        session_id: &SessionId,
    ) -> Result<&CompiledConfiguration, ConductorError> {
        let revision = &self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?
            .summary
            .config_revision;
        self.configuration_revision(revision)
    }

    pub(crate) fn configuration_for_execution(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<&CompiledConfiguration, ConductorError> {
        let revision = &self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?
            .config_revision;
        self.configuration_revision(revision)
    }

    #[must_use]
    pub fn current_config_revision(&self) -> &ConfigRevisionId {
        &self.config_revision
    }

    pub fn execution_config_revision(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<ConfigRevisionId, ConductorError> {
        self.executions
            .get(execution_id)
            .map(|execution| execution.config_revision.clone())
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))
    }

    pub fn bind_configuration_revision(
        &mut self,
        revision: &ConfigRevisionId,
        configuration: CompiledConfiguration,
    ) -> Result<(), ConductorError> {
        let slot = self
            .config_revisions
            .get_mut(revision)
            .ok_or_else(|| ConductorError::UnknownConfigRevision(revision.clone()))?;
        if slot.configuration.is_some() {
            return Err(ConductorError::ConfigRevisionAlreadyBound(revision.clone()));
        }
        let actual = configuration.fingerprint();
        if actual != slot.fingerprint {
            return Err(ConductorError::ConfigRevisionFingerprintMismatch {
                revision: revision.clone(),
                expected: slot.fingerprint.clone(),
                actual,
            });
        }
        slot.configuration = Some(configuration);
        Ok(())
    }

    pub fn bind_available_configurations(
        &mut self,
        configurations: &[CompiledConfiguration],
    ) -> Result<Vec<ConfigRevisionId>, ConductorError> {
        let available = configurations
            .iter()
            .map(|configuration| (configuration.fingerprint(), configuration))
            .collect::<BTreeMap<_, _>>();
        let bindings = self
            .config_revisions
            .iter()
            .filter(|(_, slot)| slot.configuration.is_none())
            .filter_map(|(revision, slot)| {
                available
                    .get(&slot.fingerprint)
                    .map(|configuration| (revision.clone(), (*configuration).clone()))
            })
            .collect::<Vec<_>>();
        let mut bound = Vec::with_capacity(bindings.len());
        for (revision, configuration) in bindings {
            self.bind_configuration_revision(&revision, configuration)?;
            bound.push(revision);
        }
        Ok(bound)
    }

    pub fn activate_configuration(
        &mut self,
        configuration: CompiledConfiguration,
    ) -> Result<ConfigRevisionId, ConductorError> {
        let fingerprint = configuration.fingerprint();
        let current = self
            .config_revisions
            .get(&self.config_revision)
            .expect("current configuration revision exists");
        if current.fingerprint == fingerprint {
            let revision = self.config_revision.clone();
            if current.configuration.is_none() {
                self.bind_configuration_revision(&revision, configuration)?;
            }
            return Ok(revision);
        }
        self.reload_configuration(configuration)
    }

    #[must_use]
    pub fn required_config_revisions(&self) -> BTreeSet<ConfigRevisionId> {
        let mut revisions = BTreeSet::from([self.config_revision.clone()]);
        revisions.extend(
            self.sessions
                .values()
                .map(|session| session.summary.config_revision.clone()),
        );
        revisions.extend(
            self.executions
                .values()
                .map(|execution| execution.config_revision.clone()),
        );
        revisions
    }

    pub fn ensure_required_configurations_bound(&self) -> Result<(), ConductorError> {
        for revision in self.required_config_revisions() {
            self.configuration_revision(&revision)?;
        }
        Ok(())
    }

    pub fn reload_configuration(
        &mut self,
        configuration: CompiledConfiguration,
    ) -> Result<ConfigRevisionId, ConductorError> {
        let revision = self.new_config_revision_id();
        let fingerprint = configuration.fingerprint();
        self.record_domain_event(DomainEvent::ConfigurationRevisionActivated {
            revision: revision.clone(),
            fingerprint,
        })?;
        let slot = self
            .config_revisions
            .get_mut(&revision)
            .expect("configuration activation creates a revision slot");
        slot.configuration = Some(configuration);
        Ok(revision)
    }

    fn revise_configuration<F>(&mut self, update: F) -> Result<ConfigRevisionId, ConductorError>
    where
        F: FnOnce(&mut CompiledConfiguration) -> Result<(), ConductorError>,
    {
        let mut configuration = self.current_configuration()?.clone();
        update(&mut configuration)?;
        self.reload_configuration(configuration)
    }

    pub fn register_tool<F, O>(
        &mut self,
        descriptor: CallableDescriptor,
        handler: F,
    ) -> Result<(), ConductorError>
    where
        F: Fn(&str) -> Result<O, String> + Send + Sync + 'static,
        O: Into<ToolOutcome> + 'static,
    {
        self.revise_configuration(move |configuration| {
            configuration.register_tool(descriptor, handler)
        })?;
        Ok(())
    }

    pub fn register_agent(&mut self, definition: AgentDefinition) -> Result<(), ConductorError> {
        self.revise_configuration(move |configuration| configuration.register_agent(definition))?;
        Ok(())
    }

    pub fn register_provider_agent<P>(
        &mut self,
        definition: AgentDefinition,
        provider: P,
    ) -> Result<(), ConductorError>
    where
        P: ExecutionProvider + 'static,
    {
        self.revise_configuration(move |configuration| {
            configuration.register_provider_agent(definition, provider)
        })?;
        Ok(())
    }

    pub fn register_orchestration(
        &mut self,
        definition: OrchestrationDefinition,
    ) -> Result<(), ConductorError> {
        self.revise_configuration(move |configuration| {
            configuration.register_orchestration(definition)
        })?;
        Ok(())
    }

    pub fn register_routing_profile(
        &mut self,
        profile: RoutingProfile,
    ) -> Result<(), ConductorError> {
        self.revise_configuration(move |configuration| {
            configuration.register_routing_profile(profile)
        })?;
        Ok(())
    }

    pub fn install_context_registry(
        &mut self,
        context: ContextRegistry,
    ) -> Result<(), ConductorError> {
        self.revise_configuration(move |configuration| {
            configuration.install_context_registry(context);
            Ok(())
        })?;
        Ok(())
    }

    pub fn install_skill_registry(&mut self, skills: SkillRegistry) -> Result<(), ConductorError> {
        self.revise_configuration(move |configuration| {
            configuration.install_skill_registry(skills);
            Ok(())
        })?;
        Ok(())
    }

    pub fn skill_descriptors(&self) -> Result<Vec<SkillDescriptor>, ConductorError> {
        Ok(self.current_configuration()?.skill_descriptors())
    }

    pub fn has_model_invocable_skills(&self) -> Result<bool, ConductorError> {
        Ok(self.current_configuration()?.has_model_invocable_skills())
    }

    pub fn has_skills(&self) -> Result<bool, ConductorError> {
        Ok(self.current_configuration()?.has_skills())
    }

    pub(crate) fn has_model_invocable_skills_for_execution(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<bool, ConductorError> {
        Ok(self
            .configuration_for_execution(execution_id)?
            .has_model_invocable_skills())
    }

    pub(crate) fn has_skills_for_execution(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<bool, ConductorError> {
        Ok(self.configuration_for_execution(execution_id)?.has_skills())
    }

    pub fn load_skill(
        &mut self,
        execution_id: &ExecutionId,
        id: &SkillId,
    ) -> Result<String, ConductorError> {
        let payload = self
            .configuration_for_execution(execution_id)?
            .skills
            .model_skill_payload(id)?;
        self.skill_activations
            .entry(execution_id.clone())
            .or_default()
            .insert(id.clone());
        Ok(payload)
    }

    pub fn read_skill_resource(
        &self,
        execution_id: &ExecutionId,
        id: &SkillId,
        path: &str,
    ) -> Result<String, ConductorError> {
        if !self
            .skill_activations
            .get(execution_id)
            .is_some_and(|skills| skills.contains(id))
        {
            return Err(ContextError::InactiveSkill(id.clone()).into());
        }
        Ok(self
            .configuration_for_execution(execution_id)?
            .skills
            .skill_resource_payload(id, path)?)
    }

    pub fn callable_descriptors(&self) -> Result<Vec<CallableDescriptor>, ConductorError> {
        Ok(self.current_configuration()?.callable_descriptors())
    }

    pub fn tool_descriptors(&self) -> Result<Vec<CallableDescriptor>, ConductorError> {
        Ok(self.current_configuration()?.tool_descriptors())
    }

    pub fn routing_profiles(&self) -> Result<Vec<RoutingProfileDescriptor>, ConductorError> {
        Ok(self.current_configuration()?.routing_profiles())
    }

    pub(crate) fn callable_descriptors_for_execution(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<Vec<CallableDescriptor>, ConductorError> {
        Ok(self
            .configuration_for_execution(execution_id)?
            .callable_descriptors())
    }

    fn permitted_tool_descriptors(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<Vec<CallableDescriptor>, ConductorError> {
        let authority = self.execution_authority(execution_id)?;
        Ok(self
            .configuration_for_execution(execution_id)?
            .callables
            .tool_descriptors()
            .into_iter()
            .filter(|descriptor| {
                authority
                    .filesystem
                    .permits_capabilities(&descriptor.capabilities)
            })
            .collect())
    }

    #[must_use]
    pub fn attempt_groups(&self) -> Vec<AttemptGroup> {
        self.attempt_groups.values().cloned().collect()
    }

    #[must_use]
    pub fn attempt_group_for_execution(&self, execution_id: &ExecutionId) -> Option<AttemptGroup> {
        self.attempt_groups
            .values()
            .find(|group| group.contains_execution(execution_id))
            .cloned()
    }

    #[must_use]
    pub fn orchestration_failure_decisions(&self) -> Vec<OrchestrationFailureDecisionRecord> {
        self.orchestration_decisions.values().cloned().collect()
    }

    #[must_use]
    pub fn orchestration_failure_decision(
        &self,
        failed_child: &ExecutionId,
    ) -> Option<OrchestrationFailureDecisionRecord> {
        self.orchestration_decisions.get(failed_child).cloned()
    }

    pub(crate) fn failed_child_for_interface(
        &self,
        interface_execution: &ExecutionId,
    ) -> Option<ExecutionId> {
        self.orchestration_interfaces
            .iter()
            .find_map(|(failed_child, interface)| {
                (interface == interface_execution).then(|| failed_child.clone())
            })
    }

    pub fn execution_read_set(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<ExecutionReadSet, ConductorError> {
        if !self.executions.contains_key(execution_id) {
            return Err(ConductorError::UnknownExecution(execution_id.clone()));
        }
        Ok(self
            .read_sets
            .get(execution_id)
            .cloned()
            .unwrap_or_else(|| ExecutionReadSet::new(execution_id.clone())))
    }

    pub fn execution_workspace_validity(
        &self,
        execution_id: &ExecutionId,
        current: &BTreeMap<PathBuf, FileVersion>,
    ) -> Result<ExecutionWorkspaceValidity, ConductorError> {
        Ok(self
            .execution_read_set(execution_id)?
            .validity_against(current))
    }

    fn record_file_observation(
        &mut self,
        execution_id: &ExecutionId,
        observation: FileObservation,
    ) -> Result<(), ConductorError> {
        self.record_domain_event(DomainEvent::WorkspaceFileObserved {
            execution_id: execution_id.clone(),
            observation,
        })
    }

    pub fn execution_authority(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<ExecutionAuthority, ConductorError> {
        self.executions
            .get(execution_id)
            .map(|execution| execution.authority.clone())
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))
    }

    pub(crate) fn workspace_lease_request(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<WorkspaceLeaseRequest, ConductorError> {
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        let session = self
            .sessions
            .get(&execution.summary.session_id)
            .expect("execution session invariant");
        Ok(WorkspaceLeaseRequest {
            workspace_id: session.summary.workspace_id.clone(),
            execution_id: execution_id.clone(),
            mode: execution.authority.filesystem.into(),
        })
    }

    fn effective_authority_for_execution(
        &self,
        execution: &ExecutionSummary,
    ) -> Result<ExecutionAuthority, ConductorError> {
        let configured = self.configured_authority_for_execution(execution)?;
        let Some(parent_id) = execution.parent_execution.as_ref() else {
            return Ok(configured);
        };
        let parent = self
            .executions
            .get(parent_id)
            .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?;
        Ok(parent.authority.attenuate(&configured))
    }

    fn configured_authority_for_execution(
        &self,
        execution: &ExecutionSummary,
    ) -> Result<ExecutionAuthority, ConductorError> {
        let revision = if let Some(parent_id) = execution.parent_execution.as_ref() {
            self.executions
                .get(parent_id)
                .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?
                .config_revision
                .clone()
        } else {
            self.sessions
                .get(&execution.session_id)
                .ok_or_else(|| ConductorError::UnknownSession(execution.session_id.clone()))?
                .summary
                .config_revision
                .clone()
        };
        let callables = &self.configuration_revision(&revision)?.callables;
        match execution.kind {
            ExecutionKind::Root => {
                let mut authority = authority_envelope(
                    callables
                        .agent_definitions()
                        .map(|definition| &definition.authority),
                );
                authority.callables.extend(
                    callables
                        .descriptors()
                        .into_iter()
                        .filter(|descriptor| {
                            matches!(
                                descriptor.kind,
                                CallableKind::Agent | CallableKind::Orchestration
                            )
                        })
                        .map(|descriptor| descriptor.id),
                );
                Ok(authority)
            }
            ExecutionKind::Agent => {
                let Some(callable) = execution.callable.as_ref() else {
                    return Ok(ExecutionAuthority::read_only());
                };
                Ok(callables.agent_definition(callable)?.authority.clone())
            }
            ExecutionKind::Orchestration => {
                let Some(callable) = execution.callable.as_ref() else {
                    return Ok(ExecutionAuthority::read_only());
                };
                let definition = callables.orchestration(callable)?;
                let mut authorities = definition
                    .nodes
                    .iter()
                    .map(|node| {
                        callables
                            .agent_definition(&node.callable)
                            .map(|definition| &definition.authority)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if let Some(interface_agent) = definition.interface_agent.as_ref() {
                    authorities.push(&callables.agent_definition(interface_agent)?.authority);
                }
                let mut authority = authority_envelope(authorities);
                authority
                    .callables
                    .extend(definition.nodes.iter().map(|node| node.callable.clone()));
                if let Some(interface_agent) = definition.interface_agent.as_ref() {
                    authority.callables.insert(interface_agent.clone());
                }
                Ok(authority)
            }
        }
    }

    pub fn create_session(
        &mut self,
        parent_session: Option<SessionId>,
        name: Option<String>,
        target: ExecutionTarget,
    ) -> Result<SessionSummary, ConductorError> {
        let revision = self.config_revision.clone();
        self.create_session_at_revision(parent_session, name, target, revision)
    }

    fn create_session_at_revision(
        &mut self,
        parent_session: Option<SessionId>,
        name: Option<String>,
        target: ExecutionTarget,
        revision: ConfigRevisionId,
    ) -> Result<SessionSummary, ConductorError> {
        self.configuration_revision(&revision)?;
        let workspace_id = if let Some(parent) = parent_session.as_ref() {
            self.sessions
                .get(parent)
                .ok_or_else(|| ConductorError::UnknownSession(parent.clone()))?
                .summary
                .workspace_id
                .clone()
        } else {
            self.workspace_id.clone()
        };
        let summary = SessionSummary {
            id: self.new_session_id(),
            parent_session,
            name,
            workspace_id,
            config_revision: revision,
            default_target: target,
            state: SessionState::Active,
        };
        self.record_domain_event(DomainEvent::SessionCreated {
            session: summary.clone(),
        })?;
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
        self.create_session_at_revision(
            Some(source.id),
            name,
            source.default_target,
            source.config_revision,
        )
    }

    pub fn rebase_session(
        &mut self,
        session_id: &SessionId,
        revision: &ConfigRevisionId,
    ) -> Result<SessionSummary, ConductorError> {
        self.ensure_session_active(session_id)?;
        let session = self
            .sessions
            .get(session_id)
            .expect("active session exists")
            .summary
            .clone();
        if session.config_revision == *revision {
            return Ok(session);
        }
        let configuration = self.configuration_revision(revision)?;
        if let ExecutionTarget::Routed(profile) = &session.default_target {
            if !configuration.routing.contains(profile) {
                return Err(ConductorError::IncompatibleSessionRebase {
                    session_id: session_id.clone(),
                    revision: revision.clone(),
                    reason: format!("routing profile {profile} is unavailable"),
                });
            }
        }
        self.record_domain_event(DomainEvent::SessionConfigRebased {
            session_id: session_id.clone(),
            config_revision: revision.clone(),
        })?;
        Ok(self
            .sessions
            .get(session_id)
            .expect("rebased session remains present")
            .summary
            .clone())
    }

    pub fn validate_session_close(
        &self,
        session_id: &SessionId,
    ) -> Result<SessionSummary, ConductorError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?
            .summary
            .clone();
        if session.state == SessionState::Closed {
            return Ok(session);
        }
        if self.executions.values().any(|execution| {
            execution.summary.session_id == *session_id && !is_terminal(&execution.summary.state)
        }) {
            return Err(ConductorError::SessionHasActiveExecutions(
                session_id.clone(),
            ));
        }
        Ok(session)
    }

    pub fn close_session(
        &mut self,
        session_id: &SessionId,
    ) -> Result<SessionSummary, ConductorError> {
        let session = self.validate_session_close(session_id)?;
        if session.state == SessionState::Closed {
            return Ok(session);
        }
        self.record_domain_event(DomainEvent::SessionClosed {
            session_id: session_id.clone(),
        })?;
        Ok(self
            .sessions
            .get(session_id)
            .expect("closed session remains present")
            .summary
            .clone())
    }

    pub fn submit(
        &mut self,
        session_id: &SessionId,
        text: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        self.submit_with_restrictions(session_id, text, None)
    }

    pub fn submit_with_restrictions(
        &mut self,
        session_id: &SessionId,
        text: impl Into<String>,
        restrictions: Option<&ExecutionAuthority>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let text = text.into();
        if text.trim().is_empty() {
            return Err(ConductorError::EmptyInput);
        }
        self.ensure_session_active(session_id)?;
        let target = self
            .sessions
            .get(session_id)
            .expect("active session exists")
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
        self.record_execution_created(
            summary.clone(),
            JournalExecutionPayload::Invocation {
                input: text.clone(),
                authority: ExecutionAuthority::read_only(),
            },
            restrictions,
        )?;
        self.accept_root_submission(&summary)?;
        self.push_event(&summary.id, ExecutionEventKind::UserInput { text })?;
        self.push_event(
            &summary.id,
            ExecutionEventKind::ExecutionStateChanged {
                state: ExecutionState::Pending,
            },
        )?;
        Ok(summary)
    }

    pub(crate) fn accept_root_submission(
        &mut self,
        execution: &ExecutionSummary,
    ) -> Result<(), ConductorError> {
        let ingress_order = self
            .next_root_ingress
            .get(&execution.session_id)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        self.record_domain_event(DomainEvent::RootSubmissionAccepted {
            session_id: execution.session_id.clone(),
            execution_id: execution.id.clone(),
            ingress_order,
        })
    }

    #[must_use]
    pub fn root_ingress_order(&self, execution_id: &ExecutionId) -> Option<u64> {
        self.root_ingress.get(execution_id).copied()
    }

    #[must_use]
    pub fn pending_roots_in_ingress_order(&self) -> Vec<ExecutionSummary> {
        let mut roots = self
            .executions
            .values()
            .filter(|execution| {
                execution.summary.parent_execution.is_none()
                    && execution.summary.state == ExecutionState::Pending
            })
            .map(|execution| execution.summary.clone())
            .collect::<Vec<_>>();
        roots.sort_by(|left, right| {
            left.session_id.cmp(&right.session_id).then_with(|| {
                self.root_ingress_order(&left.id)
                    .cmp(&self.root_ingress_order(&right.id))
            })
        });
        roots
    }

    pub fn start_agent(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        objective: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        self.start_agent_with_node(parent_id, callable, objective, None, None)
    }

    pub fn start_agent_with_restrictions(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        objective: impl Into<String>,
        restrictions: &ExecutionAuthority,
    ) -> Result<ExecutionSummary, ConductorError> {
        self.start_agent_with_node(parent_id, callable, objective, None, Some(restrictions))
    }

    fn start_agent_with_node(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        objective: impl Into<String>,
        orchestration_node: Option<OrchestrationNodeId>,
        restrictions: Option<&ExecutionAuthority>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let callables = self
            .configuration_for_execution(parent_id)?
            .callables
            .clone();
        let descriptor = callables.descriptor(callable)?.clone();
        if descriptor.kind != CallableKind::Agent {
            return Err(CallableRegistryError::WrongKind {
                callable: callable.clone(),
                expected: CallableKind::Agent,
                actual: descriptor.kind,
            }
            .into());
        }
        callables.execution_provider(callable)?;
        let operation = if orchestration_node.is_some() {
            CallableOperation::StartAgentNode
        } else {
            CallableOperation::StartAgent
        };
        self.check_callable_policy(parent_id, &descriptor, operation)?;
        let child = self.create_child(
            parent_id,
            ExecutionKind::Agent,
            callable.clone(),
            ExecutionPayload::Invocation {
                input: objective.into(),
            },
            restrictions,
        )?;
        if let Some(node_id) = orchestration_node {
            self.record_domain_event(DomainEvent::OrchestrationNodeStarted {
                execution_id: parent_id.clone(),
                node_id,
                child_execution_id: child.id.clone(),
            })?;
        }
        Ok(child)
    }

    pub fn start_orchestration(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        input: impl Into<Value>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let input = input.into();
        let callables = self
            .configuration_for_execution(parent_id)?
            .callables
            .clone();
        let definition = callables.orchestration(callable)?.clone();
        validate_json_schema(&definition.descriptor.input_schema, &input).map_err(|message| {
            ConductorError::InvalidExecutionData {
                execution_id: parent_id.clone(),
                message: format!("orchestration input: {message}"),
            }
        })?;
        self.check_callable_policy(
            parent_id,
            &definition.descriptor,
            CallableOperation::StartOrchestration,
        )?;
        for step in &definition.nodes {
            let descriptor = callables.descriptor(&step.callable)?.clone();
            callables.execution_provider(&step.callable)?;
            self.check_callable_policy(parent_id, &descriptor, CallableOperation::StartAgentNode)?;
        }
        if let Some(interface_agent) = definition.interface_agent.as_ref() {
            let descriptor = callables.descriptor(interface_agent)?.clone();
            callables.execution_provider(interface_agent)?;
            self.check_callable_policy(parent_id, &descriptor, CallableOperation::StartAgentNode)?;
        }
        let summary = self.create_child(
            parent_id,
            ExecutionKind::Orchestration,
            callable.clone(),
            ExecutionPayload::Orchestration { input },
            None,
        )?;
        self.set_state(&summary.id, ExecutionState::Running)?;
        self.advance_orchestration(&summary.id)?;
        Ok(self
            .executions
            .get(&summary.id)
            .expect("orchestration exists after creation")
            .summary
            .clone())
    }

    fn create_child(
        &mut self,
        parent_id: &ExecutionId,
        kind: ExecutionKind,
        callable: CallableId,
        payload: ExecutionPayload,
        restrictions: Option<&ExecutionAuthority>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let parent = self
            .executions
            .get(parent_id)
            .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?;
        if !parent.authority.callables.contains(&callable) {
            return Err(ConductorError::DelegationDenied {
                parent_execution: parent_id.clone(),
                callable,
            });
        }
        let parent = parent.summary.clone();
        self.ensure_session_active(&parent.session_id)?;
        let child = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: parent.session_id,
            parent_execution: Some(parent.id.clone()),
            kind,
            callable: Some(callable),
            target: parent.target,
            state: ExecutionState::Pending,
        };
        self.record_execution_created(
            child.clone(),
            JournalExecutionPayload::from(&payload),
            restrictions,
        )?;
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
        let configuration = self.configuration_revision(&execution.config_revision)?;
        match execution.summary.callable.as_ref() {
            None if execution.summary.kind == ExecutionKind::Root => {
                Ok(ExecutionProviderKind::Model)
            }
            Some(callable) => Ok(configuration.callables.execution_provider(callable)?.kind()),
            None => Err(ConductorError::NonProviderExecution(execution_id.clone())),
        }
    }

    pub fn resolve_invocation(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<ResolvedInvocation, ConductorError> {
        let (summary, input) = {
            let execution = self
                .executions
                .get(execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
            if execution.summary.kind == ExecutionKind::Orchestration {
                return Err(ConductorError::NonModelExecution(execution_id.clone()));
            }
            let ExecutionPayload::Invocation { input } = &execution.payload else {
                return Err(ConductorError::NonModelExecution(execution_id.clone()));
            };
            (execution.summary.clone(), input.clone())
        };
        if self.execution_provider_kind(execution_id)? != ExecutionProviderKind::Model {
            return Err(ConductorError::NonModelExecution(execution_id.clone()));
        }

        let configuration = self.configuration_for_execution(execution_id)?.clone();
        let execution_revision = self.execution_config_revision(execution_id)?;
        let route = if let Some(route) = self.resolved_routes.get(execution_id) {
            route.clone()
        } else {
            let requested_target = summary.target.clone();
            let model = match &requested_target {
                ExecutionTarget::Fixed(model) => model.clone(),
                ExecutionTarget::Routed(profile) => configuration
                    .routing
                    .resolve(profile, summary.callable.as_ref())?,
            };
            let route = ResolvedRoute {
                requested_target,
                model,
                config_revision: execution_revision,
            };
            self.record_domain_event(DomainEvent::InvocationResolved {
                execution_id: execution_id.clone(),
                route: route.clone(),
            })?;
            route
        };

        let (prompt, explicit_skills) = configuration
            .context
            .compose_prompt_with_activations(&configuration.skills, &input)?;
        if !explicit_skills.is_empty() {
            self.skill_activations
                .entry(execution_id.clone())
                .or_default()
                .extend(explicit_skills);
        }

        Ok(ResolvedInvocation {
            execution_id: execution_id.clone(),
            session_id: summary.session_id,
            config_revision: route.config_revision.clone(),
            callable: summary.callable,
            requested_target: route.requested_target,
            model: route.model,
            prompt,
            tools: ToolProvision {
                callables: self.permitted_tool_descriptors(execution_id)?,
            },
        })
    }

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
        if self
            .executions
            .get(execution_id)
            .is_some_and(|execution| execution.summary.state == ExecutionState::Running)
        {
            self.set_state(execution_id, ExecutionState::Completed)?;
        }
        Ok(())
    }

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
        let configuration = self.configuration_for_execution(execution_id)?.clone();
        let descriptor = configuration.callables.descriptor(&callable)?.clone();
        let binding = configuration
            .callables
            .execution_provider(&callable)?
            .clone();
        let Some(provider) = binding.provider().cloned() else {
            return Err(ConductorError::NonProviderExecution(execution_id.clone()));
        };
        self.check_callable_policy(
            execution_id,
            &descriptor,
            CallableOperation::DispatchProvider,
        )?;
        let config_revision = self.execution_config_revision(execution_id)?;
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

    fn execution_subtree(
        &self,
        root: &ExecutionId,
    ) -> Result<BTreeSet<ExecutionId>, ConductorError> {
        if !self.executions.contains_key(root) {
            return Err(ConductorError::UnknownExecution(root.clone()));
        }
        let mut subtree = BTreeSet::from([root.clone()]);
        loop {
            let before = subtree.len();
            for (id, record) in &self.executions {
                if record
                    .summary
                    .parent_execution
                    .as_ref()
                    .is_some_and(|parent| subtree.contains(parent))
                {
                    subtree.insert(id.clone());
                }
            }
            if subtree.len() == before {
                break;
            }
        }
        Ok(subtree)
    }

    fn cancel_execution_set(
        &mut self,
        executions: BTreeSet<ExecutionId>,
        cause: ExecutionTerminationCause,
    ) -> Result<(), ConductorError> {
        for id in executions {
            let state = self
                .executions
                .get(&id)
                .expect("collected execution")
                .summary
                .state
                .clone();
            if !is_terminal(&state) {
                self.push_event(
                    &id,
                    ExecutionEventKind::ExecutionTerminated {
                        cause: cause.clone(),
                    },
                )?;
                self.set_state(&id, ExecutionState::Cancelled)?;
            }
        }
        Ok(())
    }

    fn cancel_descendants(&mut self, root: &ExecutionId) -> Result<(), ConductorError> {
        let mut descendants = self.execution_subtree(root)?;
        descendants.remove(root);
        self.cancel_execution_set(
            descendants,
            ExecutionTerminationCause::AncestorFailure {
                failed_ancestor: root.clone(),
            },
        )
    }

    pub fn cancel_execution(&mut self, root: &ExecutionId) -> Result<(), ConductorError> {
        let executions = self.execution_subtree(root)?;
        self.cancel_execution_set(
            executions,
            ExecutionTerminationCause::ExplicitCancellation {
                requested_execution: root.clone(),
            },
        )
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
        let event = ExecutionEvent {
            sequence: self.next_event + 1,
            session_id,
            execution_id: execution_id.clone(),
            kind,
        };
        self.record_domain_event(DomainEvent::FrontendEvent {
            event: event.clone(),
        })?;
        Ok(event)
    }

    pub fn set_state(
        &mut self,
        execution_id: &ExecutionId,
        state: ExecutionState,
    ) -> Result<(), ConductorError> {
        if state == ExecutionState::Completed {
            self.ensure_orchestration_child_output(execution_id)?;
        }
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
        self.record_domain_event(DomainEvent::ExecutionStateChanged {
            execution_id: execution_id.clone(),
            state: state.clone(),
        })?;
        self.push_event(
            execution_id,
            ExecutionEventKind::ExecutionStateChanged {
                state: state.clone(),
            },
        )?;
        if state == ExecutionState::Failed {
            self.cancel_descendants(execution_id)?;
        }
        if is_terminal(&state) {
            self.skill_activations.remove(execution_id);
            self.sandbox_states.remove(execution_id);
            if let Some(parent) = parent {
                self.push_event(
                    &parent,
                    ExecutionEventKind::ChildExecutionFinished {
                        child: execution_id.clone(),
                        state,
                    },
                )?;
                self.refresh_orchestration(&parent)?;
            }
        }
        Ok(())
    }

    pub fn record_execution_output(
        &mut self,
        execution_id: &ExecutionId,
        output: Value,
    ) -> Result<(), ConductorError> {
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        if self.execution_outputs.contains_key(execution_id) {
            return Err(ConductorError::InvalidExecutionData {
                execution_id: execution_id.clone(),
                message: "output was already recorded".to_owned(),
            });
        }
        if let Some(callable) = execution.summary.callable.as_ref() {
            let descriptor = self
                .configuration_for_execution(execution_id)?
                .callables
                .descriptor(callable)?;
            validate_json_schema(&descriptor.output_schema, &output).map_err(|message| {
                ConductorError::InvalidExecutionData {
                    execution_id: execution_id.clone(),
                    message: format!("output: {message}"),
                }
            })?;
        }
        self.record_domain_event(DomainEvent::ExecutionOutputRecorded {
            execution_id: execution_id.clone(),
            output,
        })
    }

    #[must_use]
    pub fn execution_output(&self, execution_id: &ExecutionId) -> Option<&Value> {
        self.execution_outputs.get(execution_id)
    }

    fn ensure_orchestration_child_output(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<(), ConductorError> {
        if self.execution_outputs.contains_key(execution_id) {
            return Ok(());
        }
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        let Some(parent_id) = execution.summary.parent_execution.as_ref() else {
            return Ok(());
        };
        if self
            .executions
            .get(parent_id)
            .is_none_or(|parent| parent.summary.kind != ExecutionKind::Orchestration)
        {
            return Ok(());
        }
        let content = self
            .events
            .iter()
            .filter(|event| event.execution_id == *execution_id)
            .filter_map(|event| match &event.kind {
                ExecutionEventKind::AssistantContentDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let output = if content.trim().is_empty() {
            Value::Object(serde_json::Map::new())
        } else {
            serde_json::from_str(&content).map_err(|error| {
                ConductorError::InvalidExecutionData {
                    execution_id: execution_id.clone(),
                    message: format!("output is not valid JSON: {error}"),
                }
            })?
        };
        self.record_execution_output(execution_id, output)
    }

    pub fn subscribe_events(
        &mut self,
        capacity: usize,
    ) -> std::sync::mpsc::Receiver<ExecutionEvent> {
        self.subscribe_events_with_id(capacity).1
    }

    pub fn subscribe_events_with_id(
        &mut self,
        _capacity: usize,
    ) -> (u64, std::sync::mpsc::Receiver<ExecutionEvent>) {
        let (sender, receiver) = std::sync::mpsc::channel();
        self.next_event_subscription = self.next_event_subscription.saturating_add(1);
        let subscription = self.next_event_subscription;
        self.event_sinks.insert(subscription, sender);
        (subscription, receiver)
    }

    pub fn unsubscribe_event_subscription(&mut self, subscription: u64) {
        self.event_sinks.remove(&subscription);
    }

    pub fn unsubscribe_events(&mut self) {
        self.event_sinks.clear();
    }

    #[must_use]
    pub fn event_subscription_count(&self) -> usize {
        self.event_sinks.len()
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

    pub fn session(&self, session_id: &SessionId) -> Result<SessionSummary, ConductorError> {
        self.sessions
            .get(session_id)
            .map(|record| record.summary.clone())
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))
    }

    pub fn build_session_debug_bundle(
        &self,
        session_id: &SessionId,
        workspace: WorkspaceDescriptor,
        current_versions: &BTreeMap<PathBuf, FileVersion>,
    ) -> Result<SessionDebugBundle, ConductorError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?
            .summary
            .clone();
        if workspace.id != session.workspace_id {
            return Err(ConductorError::WorkspaceMismatch {
                expected: session.workspace_id,
                actual: workspace.id,
            });
        }
        let execution_ids = self
            .executions
            .values()
            .filter(|record| record.summary.session_id == *session_id)
            .map(|record| record.summary.id.clone())
            .collect::<BTreeSet<_>>();
        let secret_names = self
            .executions
            .values()
            .filter(|record| execution_ids.contains(&record.summary.id))
            .flat_map(|record| record.authority.secrets.iter())
            .cloned()
            .collect::<BTreeSet<_>>();
        let secret_values = secret_names
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .filter(|value| !value.is_empty())
            .collect::<BTreeSet<_>>();
        let mut events = self
            .events
            .iter()
            .filter(|event| event.session_id == *session_id)
            .cloned()
            .collect::<Vec<_>>();
        for event in &mut events {
            redact_event(event, &secret_names, &secret_values);
        }

        let mut bundle = SessionDebugBundle::new(session, workspace);
        bundle.executions = self
            .executions
            .values()
            .filter(|record| execution_ids.contains(&record.summary.id))
            .map(|record| record.summary.clone())
            .collect();
        bundle.events = events.clone();
        bundle.attempt_groups = self
            .attempt_groups
            .values()
            .filter(|group| execution_ids.contains(&group.parent_execution))
            .cloned()
            .collect();
        for event in &events {
            match &event.kind {
                ExecutionEventKind::UserInput { text } => {
                    bundle.conversation.push(DebugConversationMessage {
                        execution_id: event.execution_id.clone(),
                        role: DebugConversationRole::User,
                        content: text.clone(),
                    })
                }
                ExecutionEventKind::AssistantContentDelta { text } => {
                    if let Some(last) = bundle.conversation.last_mut().filter(|message| {
                        message.execution_id == event.execution_id
                            && message.role == DebugConversationRole::Assistant
                    }) {
                        last.content.push_str(text);
                    } else {
                        bundle.conversation.push(DebugConversationMessage {
                            execution_id: event.execution_id.clone(),
                            role: DebugConversationRole::Assistant,
                            content: text.clone(),
                        });
                    }
                }
                ExecutionEventKind::ToolCallStarted { .. }
                | ExecutionEventKind::ToolCallArguments { .. }
                | ExecutionEventKind::ToolCallFinished { .. } => {
                    bundle.tool_activity.push(event.clone());
                }
                ExecutionEventKind::ExecutionTerminated { cause } => {
                    bundle
                        .termination_causes
                        .insert(event.execution_id.clone(), cause.clone());
                }
                _ => {}
            }
        }
        for execution_id in &execution_ids {
            let record = &self.executions[execution_id];
            let mut authority = record.authority.clone();
            authority.secrets.clear();
            bundle
                .workspace_authority
                .insert(execution_id.clone(), authority);
            let read_set = self
                .read_sets
                .get(execution_id)
                .cloned()
                .unwrap_or_else(|| ExecutionReadSet::new(execution_id.clone()));
            bundle.workspace_validity.insert(
                execution_id.clone(),
                read_set.validity_against(current_versions),
            );
            bundle.read_sets.push(read_set);
            if record.summary.kind == ExecutionKind::Orchestration {
                let callable = record
                    .summary
                    .callable
                    .as_ref()
                    .expect("orchestration callable invariant");
                let definition = self
                    .configuration_revision(&record.config_revision)?
                    .callables
                    .orchestration(callable)?
                    .clone();
                let node_bindings = self
                    .orchestration_nodes
                    .iter()
                    .filter(|(child_id, _)| {
                        self.executions.get(*child_id).is_some_and(|child| {
                            child.summary.parent_execution.as_ref() == Some(execution_id)
                        })
                    })
                    .map(|(child_id, node_id)| (node_id.clone(), child_id.clone()))
                    .collect();
                let mut node_inputs = self
                    .orchestration_node_inputs
                    .iter()
                    .filter(|((parent_id, _), _)| parent_id == execution_id)
                    .map(|((_, node_id), input)| (node_id.clone(), input.clone()))
                    .collect::<BTreeMap<_, _>>();
                for value in node_inputs.values_mut() {
                    redact_value(value, &secret_names, &secret_values);
                }
                bundle.orchestrations.push(DebugOrchestration {
                    execution_id: execution_id.clone(),
                    definition,
                    node_bindings,
                    node_inputs,
                    synthesis_execution: self.orchestration_synthesis.get(execution_id).cloned(),
                });
            }
        }
        bundle.resolved_routing = self
            .resolved_routes
            .iter()
            .filter(|(execution_id, _)| execution_ids.contains(*execution_id))
            .map(|(execution_id, route)| DebugResolvedRoute {
                execution_id: execution_id.clone(),
                requested_target: route.requested_target.clone(),
                model: route.model.clone(),
                config_revision: route.config_revision.clone(),
            })
            .collect();
        bundle.failure_decisions = self
            .orchestration_decisions
            .values()
            .filter(|decision| execution_ids.contains(&decision.parent_execution))
            .cloned()
            .collect();
        bundle.execution_outputs = self
            .execution_outputs
            .iter()
            .filter(|(execution_id, _)| execution_ids.contains(*execution_id))
            .map(|(execution_id, output)| {
                let mut output = output.clone();
                redact_value(&mut output, &secret_names, &secret_values);
                (execution_id.clone(), output)
            })
            .collect();
        bundle.checkpoints = self
            .journal
            .entries
            .iter()
            .filter_map(|entry| match &entry.event {
                DomainEvent::WorkspaceCheckpointCaptured {
                    execution_id,
                    workspace_id,
                    files,
                } if execution_ids.contains(execution_id) => Some(DebugWorkspaceCheckpoint {
                    sequence: entry.sequence,
                    execution_id: execution_id.clone(),
                    workspace_id: workspace_id.clone(),
                    files: files.clone(),
                }),
                _ => None,
            })
            .collect();
        bundle.diagnostic_write_patches = self
            .diagnostic_write_patches
            .iter()
            .filter(|patch| execution_ids.contains(&patch.execution_id))
            .cloned()
            .map(|mut patch| {
                redact_text(&mut patch.patch, &secret_values);
                patch
            })
            .collect();
        Ok(bundle)
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
        let context = InvocationPolicyContext {
            session_id: &execution.summary.session_id,
            execution_id,
            config_revision: &execution.config_revision,
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
        let callables = self
            .configuration_for_execution(execution_id)
            .map_err(conductor_protocol_error)?
            .callables
            .clone();
        if !allowed_tools.contains(&invocation.callable)
            || !callables.contains(&invocation.callable)
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

        let descriptor = callables
            .descriptor(&invocation.callable)
            .map_err(|error| BackendError::Protocol(error.to_string()))?
            .clone();
        let result = match self.check_callable_policy(
            execution_id,
            &descriptor,
            CallableOperation::InvokeTool,
        ) {
            Ok(()) => match serde_json::from_str::<Value>(&invocation.arguments_json) {
                Ok(_) => {
                    let authority = self
                        .execution_authority(execution_id)
                        .map_err(conductor_protocol_error)?;
                    let sandbox_state = self
                        .execution_sandbox_state(execution_id)
                        .map_err(|error| BackendError::Protocol(error.to_string()))?;
                    let context = callables::ToolExecutionContext {
                        execution_id: execution_id.clone(),
                        authority,
                        sandbox_state,
                    };
                    let outcome = callables
                        .invoke_tool(&context, &invocation.callable, &invocation.arguments_json)
                        .map_err(|error| BackendError::Protocol(error.to_string()))?;
                    if outcome.success {
                        for observation in outcome.file_observations.iter().cloned() {
                            self.record_file_observation(execution_id, observation)
                                .map_err(conductor_protocol_error)?;
                        }
                    }
                    for patch in outcome.diagnostic_write_patches.iter().cloned() {
                        self.record_domain_event(DomainEvent::DiagnosticWritePatchCaptured {
                            patch,
                        })
                        .map_err(conductor_protocol_error)?;
                    }
                    outcome.into_backend_result()
                }
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

    fn ensure_session_active(&self, session_id: &SessionId) -> Result<(), ConductorError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?;
        if session.summary.state == SessionState::Closed {
            Err(ConductorError::ClosedSession(session_id.clone()))
        } else {
            Ok(())
        }
    }

    fn execution_sandbox_state(
        &mut self,
        execution_id: &ExecutionId,
    ) -> Result<std::sync::Arc<sandbox::ExecutionSandboxState>, std::io::Error> {
        if let Some(state) = self.sandbox_states.get(execution_id) {
            return Ok(std::sync::Arc::clone(state));
        }
        let state = sandbox::ExecutionSandboxState::create()?;
        self.sandbox_states
            .insert(execution_id.clone(), std::sync::Arc::clone(&state));
        Ok(state)
    }

    fn new_config_revision_id(&self) -> ConfigRevisionId {
        ConfigRevisionId::parse(format!("config-{}", self.next_config_revision + 1))
            .expect("generated config revision id")
    }

    fn new_session_id(&self) -> SessionId {
        SessionId::parse(format!("session-{}", self.next_session + 1)).expect("generated id")
    }

    fn new_execution_id(&self) -> ExecutionId {
        ExecutionId::parse(format!("execution-{}", self.next_execution + 1)).expect("generated id")
    }

    fn new_attempt_group_id(&self) -> AttemptGroupId {
        AttemptGroupId::parse(format!("attempt-group-{}", self.next_attempt_group + 1))
            .expect("generated id")
    }

    fn new_tool_call_id(&self) -> ToolCallId {
        ToolCallId::parse(format!("tool-call-{}", self.next_tool_call + 1)).expect("generated id")
    }
}

fn conductor_protocol_error(error: ConductorError) -> BackendError {
    BackendError::Protocol(error.to_string())
}

fn validate_json_schema(schema: &Value, value: &Value) -> Result<(), String> {
    let validator = jsonschema::validator_for(schema)
        .map_err(|error| format!("invalid configured JSON schema: {error}"))?;
    if let Err(error) = validator.validate(value) {
        return Err(error.to_string());
    }
    Ok(())
}

fn redact_event(
    event: &mut ExecutionEvent,
    secret_names: &BTreeSet<String>,
    secret_values: &BTreeSet<String>,
) {
    match &mut event.kind {
        ExecutionEventKind::UserInput { text }
        | ExecutionEventKind::AssistantContentDelta { text }
        | ExecutionEventKind::ReasoningDelta { text }
        | ExecutionEventKind::ToolCallArguments {
            arguments: text, ..
        }
        | ExecutionEventKind::ToolCallFinished { output: text, .. }
        | ExecutionEventKind::Error { message: text, .. } => {
            if let Ok(mut value) = serde_json::from_str::<Value>(text) {
                redact_value(&mut value, secret_names, secret_values);
                *text = value.to_string();
            } else {
                redact_text(text, secret_values);
            }
        }
        _ => {}
    }
}

fn redact_value(
    value: &mut Value,
    secret_names: &BTreeSet<String>,
    secret_values: &BTreeSet<String>,
) {
    match value {
        Value::String(text) => redact_text(text, secret_values),
        Value::Array(values) => {
            for value in values {
                redact_value(value, secret_names, secret_values);
            }
        }
        Value::Object(values) => {
            for (name, value) in values {
                if secret_names.contains(name) {
                    *value = Value::String("[REDACTED]".to_owned());
                } else {
                    redact_value(value, secret_names, secret_values);
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn redact_text(text: &mut String, secrets: &BTreeSet<String>) {
    for secret in secrets {
        if text.contains(secret) {
            *text = text.replace(secret, "[REDACTED]");
        }
    }
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

fn authority_envelope<'a>(
    authorities: impl IntoIterator<Item = &'a ExecutionAuthority>,
) -> ExecutionAuthority {
    let mut envelope = ExecutionAuthority::read_only();
    for authority in authorities {
        envelope.filesystem = envelope.filesystem.max(authority.filesystem);
        envelope.network = envelope.network.max(authority.network);
        envelope.repository = envelope.repository.max(authority.repository);
        envelope.ipc.extend(authority.ipc.iter().cloned());
        envelope.secrets.extend(authority.secrets.iter().cloned());
        envelope
            .callables
            .extend(authority.callables.iter().cloned());
    }
    envelope
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
        BackendId, CallablePolicy, CapabilitySet, FilesystemAuthority, InferenceOptions, ModelId,
        NetworkAuthority, ProviderId, RepositoryAuthority, RoutingProfileId, WorkspaceId,
        CAPABILITY_FILESYSTEM_READ, CAPABILITY_FILESYSTEM_WRITE,
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

    fn tool(id: &str, capabilities: &[&str]) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind: CallableKind::Tool,
            description: "test tool".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet(
                capabilities
                    .iter()
                    .map(|capability| (*capability).to_owned())
                    .collect(),
            ),
            policy: CallablePolicy::default(),
        }
    }

    fn authority(
        filesystem: FilesystemAuthority,
        network: NetworkAuthority,
        repository: RepositoryAuthority,
        ipc: &[&str],
        secrets: &[&str],
        callables: &[&str],
    ) -> ExecutionAuthority {
        ExecutionAuthority {
            filesystem,
            network,
            repository,
            ipc: ipc.iter().map(|value| (*value).to_owned()).collect(),
            secrets: secrets.iter().map(|value| (*value).to_owned()).collect(),
            callables: callables
                .iter()
                .map(|value| CallableId::parse(*value).unwrap())
                .collect(),
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
    fn sessions_bind_to_runtime_workspace_and_forks_inherit_it() {
        let mut runtime = ConductorRuntime::new();
        let workspace = WorkspaceId::parse("workspace:/repo").unwrap();
        runtime.bind_workspace(workspace.clone()).unwrap();
        let root = runtime.create_session(None, None, fixed("a")).unwrap();
        let fork = runtime.fork_session(&root.id, None).unwrap();

        assert_eq!(root.workspace_id, workspace);
        assert_eq!(fork.workspace_id, root.workspace_id);
        assert!(matches!(
            runtime.bind_workspace(WorkspaceId::parse("workspace:/other").unwrap()),
            Err(ConductorError::WorkspaceMismatch { .. })
        ));
    }

    #[test]
    fn closed_session_is_durable_terminal_but_can_be_forked() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        let closed = runtime.close_session(&session.id).unwrap();
        assert_eq!(closed.state, SessionState::Closed);
        assert_eq!(runtime.close_session(&session.id).unwrap(), closed);
        assert!(matches!(
            runtime.submit(&session.id, "more"),
            Err(ConductorError::ClosedSession(id)) if id == session.id
        ));
        let fork = runtime
            .fork_session(&session.id, Some("continuation".to_owned()))
            .unwrap();
        assert_eq!(fork.parent_session, Some(session.id));
        assert_eq!(fork.state, SessionState::Active);
    }

    #[test]
    fn close_rejects_nonterminal_execution() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        runtime.submit(&session.id, "work").unwrap();
        assert!(matches!(
            runtime.close_session(&session.id),
            Err(ConductorError::SessionHasActiveExecutions(id)) if id == session.id
        ));
    }

    #[test]
    fn fixed_parent_forces_callable_child_target() {
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(AgentDefinition::new(
                agent("scout"),
                ExecutionAuthority::read_only(),
            ))
            .unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let root = runtime.submit(&session.id, "work").unwrap();
        let child = runtime
            .start_agent(&root.id, &CallableId::parse("scout").unwrap(), "child")
            .unwrap();
        assert_eq!(child.target, fixed("fixed"));
    }

    #[test]
    fn child_authority_is_attenuated_by_parent() {
        let mut runtime = ConductorRuntime::new();
        let parent_authority = authority(
            FilesystemAuthority::ReadOnly,
            NetworkAuthority::Outbound,
            RepositoryAuthority::Read,
            &["dbus"],
            &["github"],
            &["agent.child", "tool.read"],
        );
        let child_maximum = authority(
            FilesystemAuthority::Write,
            NetworkAuthority::Outbound,
            RepositoryAuthority::Write,
            &["dbus", "docker"],
            &["github", "other"],
            &["tool.read", "tool.write"],
        );
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.parent"),
                parent_authority.clone(),
            ))
            .unwrap();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.child"),
                child_maximum.clone(),
            ))
            .unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let parent = runtime
            .start_session_callable(
                &session.id,
                &CallableId::parse("agent.parent").unwrap(),
                "parent",
            )
            .unwrap();
        let child = runtime
            .start_agent(
                &parent.id,
                &CallableId::parse("agent.child").unwrap(),
                "child",
            )
            .unwrap();

        assert_eq!(
            runtime.execution_authority(&parent.id).unwrap(),
            parent_authority
        );
        assert_eq!(
            runtime.execution_authority(&child.id).unwrap(),
            parent_authority.attenuate(&child_maximum)
        );
    }

    #[test]
    fn invocation_restrictions_are_attenuated_and_replayed() {
        let mut runtime = ConductorRuntime::new();
        let parent_authority = authority(
            FilesystemAuthority::Write,
            NetworkAuthority::Outbound,
            RepositoryAuthority::Write,
            &["/run/parent.sock"],
            &["TOKEN", "OTHER"],
            &["agent.child", "tool.write"],
        );
        let child_maximum = authority(
            FilesystemAuthority::Write,
            NetworkAuthority::Outbound,
            RepositoryAuthority::Write,
            &["/run/parent.sock", "/run/other.sock"],
            &["TOKEN"],
            &["tool.write"],
        );
        let restrictions = authority(
            FilesystemAuthority::ReadOnly,
            NetworkAuthority::None,
            RepositoryAuthority::Read,
            &["/run/parent.sock"],
            &["TOKEN"],
            &[],
        );
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.parent"),
                parent_authority,
            ))
            .unwrap();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.child"),
                child_maximum.clone(),
            ))
            .unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let parent = runtime
            .start_session_callable(
                &session.id,
                &CallableId::parse("agent.parent").unwrap(),
                "parent",
            )
            .unwrap();
        let child = runtime
            .start_agent_with_restrictions(
                &parent.id,
                &CallableId::parse("agent.child").unwrap(),
                "child",
                &restrictions,
            )
            .unwrap();
        let expected = child_maximum.attenuate(&restrictions);
        assert_eq!(runtime.execution_authority(&child.id).unwrap(), expected);

        let restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();
        assert_eq!(restored.execution_authority(&child.id).unwrap(), expected);
    }

    #[test]
    fn debug_bundle_is_complete_and_redacts_granted_secret_fields() {
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.debug"),
                authority(
                    FilesystemAuthority::Write,
                    NetworkAuthority::None,
                    RepositoryAuthority::Read,
                    &[],
                    &["TOKEN"],
                    &[],
                ),
            ))
            .unwrap();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.audit"),
                ExecutionAuthority::read_only(),
            ))
            .unwrap();
        let workspace_id = WorkspaceId::parse("workspace:debug").unwrap();
        runtime.bind_workspace(workspace_id.clone()).unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let root = runtime.submit(&session.id, "inspect").unwrap();
        let audit = runtime
            .start_agent(
                &root.id,
                &CallableId::parse("agent.audit").unwrap(),
                "attempt a diagnostic edit",
            )
            .unwrap();
        runtime
            .record_domain_event(DomainEvent::DiagnosticWritePatchCaptured {
                patch: DiagnosticWritePatch {
                    execution_id: audit.id,
                    path: PathBuf::from("src/lib.rs"),
                    patch: "+diagnostic only\n".to_owned(),
                },
            })
            .unwrap();
        runtime.resolve_invocation(&root.id).unwrap();
        let tool_call_id = runtime.new_tool_call_id();
        runtime
            .push_event(
                &root.id,
                ExecutionEventKind::ToolCallStarted {
                    tool_call_id: tool_call_id.clone(),
                    callable: CallableId::parse("debug.tool").unwrap(),
                },
            )
            .unwrap();
        runtime
            .push_event(
                &root.id,
                ExecutionEventKind::ToolCallArguments {
                    tool_call_id: tool_call_id.clone(),
                    arguments: json!({"TOKEN": "credential-value", "safe": true}).to_string(),
                },
            )
            .unwrap();
        runtime
            .push_event(
                &root.id,
                ExecutionEventKind::ToolCallFinished {
                    tool_call_id,
                    output: "done".to_owned(),
                    success: true,
                },
            )
            .unwrap();
        runtime
            .push_event(
                &root.id,
                ExecutionEventKind::AssistantContentDelta {
                    text: "result".to_owned(),
                },
            )
            .unwrap();
        runtime
            .record_domain_event(DomainEvent::WorkspaceCheckpointCaptured {
                execution_id: root.id.clone(),
                workspace_id: workspace_id.clone(),
                files: BTreeMap::new(),
            })
            .unwrap();
        let bundle = runtime
            .build_session_debug_bundle(
                &session.id,
                WorkspaceDescriptor {
                    id: workspace_id,
                    root: PathBuf::from("/debug-workspace"),
                    scratch_paths: BTreeSet::new(),
                },
                &BTreeMap::new(),
            )
            .unwrap();
        let serialized = serde_json::to_string(&bundle).unwrap();

        assert_eq!(bundle.executions.len(), 2);
        assert_eq!(bundle.resolved_routing.len(), 1);
        assert_eq!(bundle.tool_activity.len(), 3);
        assert_eq!(bundle.checkpoints.len(), 1);
        assert_eq!(bundle.diagnostic_write_patches.len(), 1);
        assert_eq!(bundle.conversation.len(), 2);
        assert!(bundle.workspace_authority[&root.id].secrets.is_empty());
        assert!(!serialized.contains("credential-value"));
        assert!(serialized.contains("[REDACTED]"));
    }

    #[test]
    fn child_creation_requires_parent_callable_delegation() {
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.parent"),
                authority(
                    FilesystemAuthority::ReadOnly,
                    NetworkAuthority::None,
                    RepositoryAuthority::Read,
                    &[],
                    &[],
                    &["agent.allowed"],
                ),
            ))
            .unwrap();
        for callable in ["agent.allowed", "agent.denied"] {
            runtime
                .register_agent(AgentDefinition::new(
                    agent(callable),
                    ExecutionAuthority::read_only(),
                ))
                .unwrap();
        }
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let parent = runtime
            .start_session_callable(
                &session.id,
                &CallableId::parse("agent.parent").unwrap(),
                "parent",
            )
            .unwrap();
        let before = runtime.snapshot().executions.len();
        let denied = CallableId::parse("agent.denied").unwrap();

        assert_eq!(
            runtime
                .start_agent(&parent.id, &denied, "denied child")
                .unwrap_err(),
            ConductorError::DelegationDenied {
                parent_execution: parent.id,
                callable: denied,
            }
        );
        assert_eq!(runtime.snapshot().executions.len(), before);
    }

    #[test]
    fn root_authority_is_the_configured_agent_envelope() {
        let mut runtime = ConductorRuntime::new();
        let scout = authority(
            FilesystemAuthority::ReadOnly,
            NetworkAuthority::Outbound,
            RepositoryAuthority::Read,
            &["dbus"],
            &[],
            &["agent.worker"],
        );
        let worker = authority(
            FilesystemAuthority::Write,
            NetworkAuthority::None,
            RepositoryAuthority::Write,
            &[],
            &["github"],
            &["tool.write"],
        );
        runtime
            .register_agent(AgentDefinition::new(agent("agent.scout"), scout.clone()))
            .unwrap();
        runtime
            .register_agent(AgentDefinition::new(agent("agent.worker"), worker.clone()))
            .unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let root = runtime.submit(&session.id, "work").unwrap();

        let mut expected = authority_envelope([&scout, &worker]);
        expected.callables.extend([
            CallableId::parse("agent.scout").unwrap(),
            CallableId::parse("agent.worker").unwrap(),
        ]);
        assert_eq!(runtime.execution_authority(&root.id).unwrap(), expected);
    }

    #[test]
    fn execution_authority_roundtrips_and_rejects_parent_expansion() {
        let mut runtime = ConductorRuntime::new();
        let parent_authority = authority(
            FilesystemAuthority::ReadOnly,
            NetworkAuthority::None,
            RepositoryAuthority::Read,
            &[],
            &[],
            &["agent.child"],
        );
        let child_maximum = authority(
            FilesystemAuthority::Write,
            NetworkAuthority::Outbound,
            RepositoryAuthority::Write,
            &[],
            &[],
            &[],
        );
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.parent"),
                parent_authority.clone(),
            ))
            .unwrap();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.child"),
                child_maximum.clone(),
            ))
            .unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let parent = runtime
            .start_session_callable(
                &session.id,
                &CallableId::parse("agent.parent").unwrap(),
                "parent",
            )
            .unwrap();
        let child = runtime
            .start_agent(
                &parent.id,
                &CallableId::parse("agent.child").unwrap(),
                "child",
            )
            .unwrap();
        let journal = runtime.journal().clone();
        let restored = ConductorRuntime::restore(journal.clone()).unwrap();
        assert_eq!(
            restored.execution_authority(&child.id).unwrap(),
            parent_authority.attenuate(&child_maximum)
        );

        let mut corrupted = journal.clone();
        let child_payload = corrupted
            .entries
            .iter_mut()
            .find_map(|entry| match &mut entry.event {
                DomainEvent::ExecutionCreated { execution, payload }
                    if execution.id == child.id =>
                {
                    Some(payload)
                }
                _ => None,
            })
            .expect("child creation is durable");
        child_payload.set_authority(authority(
            FilesystemAuthority::Write,
            NetworkAuthority::None,
            RepositoryAuthority::Read,
            &[],
            &[],
            &[],
        ));
        assert!(matches!(
            ConductorRuntime::restore(corrupted),
            Err(PersistenceError::InvalidJournal(message)) if message.contains("authority exceeds parent")
        ));

        let mut corrupted = journal;
        let child_execution = corrupted
            .entries
            .iter_mut()
            .find_map(|entry| match &mut entry.event {
                DomainEvent::ExecutionCreated { execution, .. } if execution.id == child.id => {
                    Some(execution)
                }
                _ => None,
            })
            .expect("child creation is durable");
        child_execution.callable = Some(CallableId::parse("agent.other").unwrap());
        assert!(matches!(
            ConductorRuntime::restore(corrupted),
            Err(PersistenceError::InvalidJournal(message)) if message.contains("not delegated by parent")
        ));
    }

    #[test]
    fn resolved_invocation_filters_tools_by_execution_authority() {
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.reader"),
                ExecutionAuthority::read_only(),
            ))
            .unwrap();
        runtime
            .register_tool(tool("tool.read", &[CAPABILITY_FILESYSTEM_READ]), |_| {
                Ok("read".to_owned())
            })
            .unwrap();
        runtime
            .register_tool(tool("tool.write", &[CAPABILITY_FILESYSTEM_WRITE]), |_| {
                Ok("write".to_owned())
            })
            .unwrap();

        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let execution = runtime
            .start_session_callable(
                &session.id,
                &CallableId::parse("agent.reader").unwrap(),
                "inspect",
            )
            .unwrap();
        let resolved = runtime.resolve_invocation(&execution.id).unwrap();
        let tools = resolved
            .tools
            .callables
            .iter()
            .map(|descriptor| descriptor.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(tools, vec!["tool.read"]);
    }

    #[test]
    fn cancellation_cascades_to_descendants() {
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(AgentDefinition::new(
                agent("scout"),
                ExecutionAuthority::read_only(),
            ))
            .unwrap();
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
    fn failed_orchestration_cancels_active_siblings_and_preserves_terminal_children() {
        let mut runtime = ConductorRuntime::new();
        for callable in ["agent.fail", "agent.active", "agent.done"] {
            runtime
                .register_agent(AgentDefinition::new(
                    agent(callable),
                    ExecutionAuthority::read_only(),
                ))
                .unwrap();
        }
        runtime
            .register_orchestration(OrchestrationDefinition {
                output_bindings: Default::default(),
                interface_agent: None,
                descriptor: CallableDescriptor {
                    id: CallableId::parse("orchestration.parallel").unwrap(),
                    kind: CallableKind::Orchestration,
                    description: "parallel failure fixture".to_owned(),
                    input_schema: json!({"type": "object"}),
                    output_schema: json!({"type": "object"}),
                    capabilities: CapabilitySet::default(),
                    policy: CallablePolicy::default(),
                },
                nodes: vec![
                    phenix_core::OrchestrationNode {
                        input_bindings: Default::default(),
                        id: OrchestrationNodeId::parse("fail").unwrap(),
                        callable: CallableId::parse("agent.fail").unwrap(),
                        depends_on: Vec::new(),
                        objective: None,
                    },
                    phenix_core::OrchestrationNode {
                        input_bindings: Default::default(),
                        id: OrchestrationNodeId::parse("active").unwrap(),
                        callable: CallableId::parse("agent.active").unwrap(),
                        depends_on: Vec::new(),
                        objective: None,
                    },
                    phenix_core::OrchestrationNode {
                        input_bindings: Default::default(),
                        id: OrchestrationNodeId::parse("done").unwrap(),
                        callable: CallableId::parse("agent.done").unwrap(),
                        depends_on: Vec::new(),
                        objective: None,
                    },
                ],
            })
            .unwrap();

        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        let root = runtime.submit(&session.id, "root").unwrap();
        let orchestration = runtime
            .start_orchestration(
                &root.id,
                &CallableId::parse("orchestration.parallel").unwrap(),
                json!({"objective": "parallel work"}),
            )
            .unwrap();
        let children = runtime
            .snapshot()
            .executions
            .into_iter()
            .filter(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
            .collect::<Vec<_>>();
        let child = |callable: &str| {
            children
                .iter()
                .find(|execution| {
                    execution
                        .callable
                        .as_ref()
                        .is_some_and(|id| id.as_str() == callable)
                })
                .unwrap()
                .id
                .clone()
        };
        let failing = child("agent.fail");
        let active = child("agent.active");
        let done = child("agent.done");

        runtime.set_state(&done, ExecutionState::Completed).unwrap();
        runtime.set_state(&active, ExecutionState::Running).unwrap();
        runtime
            .set_state(&failing, ExecutionState::Running)
            .unwrap();
        runtime.set_state(&failing, ExecutionState::Failed).unwrap();

        let snapshot = runtime.snapshot();
        let state = |id: &ExecutionId| {
            snapshot
                .executions
                .iter()
                .find(|execution| &execution.id == id)
                .unwrap()
                .state
                .clone()
        };
        assert_eq!(state(&failing), ExecutionState::Failed);
        assert_eq!(state(&active), ExecutionState::Cancelled);
        assert_eq!(state(&done), ExecutionState::Completed);
        assert_eq!(state(&orchestration.id), ExecutionState::Failed);
        assert!(runtime.events_since(0).iter().any(|event| {
            event.execution_id == root.id
                && matches!(
                    &event.kind,
                    ExecutionEventKind::ChildExecutionFinished { child, state }
                        if child == &orchestration.id && *state == ExecutionState::Failed
                )
        }));
    }

    #[test]
    fn failed_parent_cancels_deep_active_subtree() {
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.parent"),
                authority(
                    FilesystemAuthority::ReadOnly,
                    NetworkAuthority::None,
                    RepositoryAuthority::Read,
                    &[],
                    &[],
                    &["agent.child"],
                ),
            ))
            .unwrap();
        runtime
            .register_agent(AgentDefinition::new(
                agent("agent.child"),
                ExecutionAuthority::read_only(),
            ))
            .unwrap();
        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        let root = runtime.submit(&session.id, "root").unwrap();
        let parent = runtime
            .start_agent(
                &root.id,
                &CallableId::parse("agent.parent").unwrap(),
                "parent",
            )
            .unwrap();
        let child = runtime
            .start_agent(
                &parent.id,
                &CallableId::parse("agent.child").unwrap(),
                "child",
            )
            .unwrap();
        runtime
            .set_state(&parent.id, ExecutionState::Running)
            .unwrap();
        runtime
            .set_state(&child.id, ExecutionState::Running)
            .unwrap();

        runtime.set_state(&root.id, ExecutionState::Failed).unwrap();

        let snapshot = runtime.snapshot();
        let state = |id: &ExecutionId| {
            snapshot
                .executions
                .iter()
                .find(|execution| &execution.id == id)
                .unwrap()
                .state
                .clone()
        };
        assert_eq!(state(&root.id), ExecutionState::Failed);
        assert_eq!(state(&parent.id), ExecutionState::Cancelled);
        assert_eq!(state(&child.id), ExecutionState::Cancelled);
    }

    #[test]
    fn resolved_invocation_is_journaled_once_and_reused() {
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
        let first = runtime.resolve_invocation(&execution.id).unwrap();
        let journal_len = runtime.journal.entries.len();
        let second = runtime.resolve_invocation(&execution.id).unwrap();

        assert_eq!(first.model, concrete);
        assert_eq!(first, second);
        assert_eq!(runtime.journal.entries.len(), journal_len);
        assert!(runtime.journal.entries.iter().any(|entry| {
            matches!(
                &entry.event,
                DomainEvent::InvocationResolved { execution_id, .. }
                    if execution_id == &execution.id
            )
        }));
    }
}
