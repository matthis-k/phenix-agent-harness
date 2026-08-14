#![forbid(unsafe_code)]

pub use agent_client_protocol as acp;

mod authoring;
mod backend;
mod callable;
mod client;
mod conductor;
mod configuration;
mod definition;
mod id;
mod protocol;
mod run_coordinator;
mod runtime;
mod source;
mod subscription;
mod tools;
mod workflow_ir;
mod workflow_runtime;

pub use authoring::{
    parse_routing_table, parse_routing_table_with_format, parse_workflow,
    parse_workflow_with_format, DefinitionFormat, DefinitionKind, DefinitionParseError,
    Definitions, FormatAttempt,
};
pub use backend::{
    AuthenticationCapabilities, BackendAuthCancel, BackendAuthCancelParams, BackendAuthLink,
    BackendAuthLogout, BackendAuthLogoutParams, BackendAuthMethod, BackendAuthNotice,
    BackendAuthPrompt, BackendAuthPromptOption, BackendAuthProviderList,
    BackendAuthProviderListResult, BackendAuthProviderSummary, BackendAuthRespond,
    BackendAuthRespondParams, BackendAuthResponse, BackendAuthStart, BackendAuthStartParams,
    BackendAuthTerminalFinished, BackendAuthTerminalFinishedParams, BackendCapabilities,
    BackendCapabilitiesGet, BackendCapabilitiesResult, BackendCommandList,
    BackendCommandListResult, BackendCommandSource, BackendCommandSummary, BackendControlEvent,
    BackendEventBatch, BackendEventPoll, BackendExternalCommand, BackendHealth, BackendModelList,
    BackendModelListResult, BackendModelSummary, BackendTargetParams, ExtensionUiCapabilities,
    ModelCapabilities, PromptCapabilities, ResourceCapabilities, SessionCapabilities,
};
pub use callable::{
    ArtifactRef, CallableCatalog, CallableCatalogError, CallableDefinition, CallableExecutor,
    CallableInput, CallableInvocation, DispatchDecision, ExecutionPolicy, IntentDecomposition,
    InvocationPolicy, OutcomeRequest, RetryPolicy, RunFailure, RunOutcome, SelectionMetadata,
};
pub use client::{
    decode_extension_response, encode_extension_request, ExtensionCodecError, PhenixAcpCallError,
};
pub use conductor::{ConductorError, PhenixConductor};
pub use configuration::{
    ConfigurationBackendInput, ConfigurationChangedNotification, ConfigurationChangedParams,
    ConfigurationDefinitionInput, ConfigurationGet, ConfigurationGetParams, ConfigurationGetResult,
    ConfigurationInput, ConfigurationLoad, ConfigurationLoadParams, ConfigurationLoadResult,
    ConfigurationSnapshot, ConfigurationSource, ConfigurationSourceError,
    ConfigurationSourceOrigin, ConfigurationStandardSessionInput, LoadedConfigurationSource,
};
pub use definition::{
    AcpEndpoint, BackendDefinition, DefinitionError, SessionTreeDefinition,
    SessionTreeDefinitionBuilder,
};
pub use id::{
    AcpSessionId, ArtifactId, BackendId, CallableId, DefinitionId, IdError, McpServerName, ModelId,
    ObjectiveId, OutcomeId, ProviderId, RoleId, RouterId, RunId, SchemaId, SessionNodeId,
    SessionTreeId, ToolId, WorkflowId,
};
pub use protocol::{
    AcpMethod, AcpNotification, Difficulty, EmptyResult, ModelConfig, ModelSelection,
    NodeAttachResult, NodeCancel, NodeCancelParams, NodeDelegate, NodeDelegateParams,
    NodeEventNotification, NodeEventParams, NodeExecute, NodeExecuteParams, NodeExecuteResult,
    NodeFork, NodeForkParams, NodeLoad, NodeLoadParams, NodeResume, NodeResumeParams,
    NodeTranscript, NodeTranscriptGet, NodeTranscriptGetParams, ObjectiveMark, ObjectiveMarkParams,
    ObjectiveSnapshot, ObjectiveState, RoutingExplain, RoutingExplainParams, RoutingExplainResult,
    SessionNodeSnapshot, SessionNodeState, SessionTreeClose, SessionTreeCloseParams,
    SessionTreeCreate, SessionTreeCreateParams, SessionTreeCreateResult, SessionTreeGet,
    SessionTreeGetParams, SessionTreeList, SessionTreeListParams, SessionTreeListResult,
    SessionTreeSnapshot, SessionTreeSummary, SessionTreeUpdatedNotification,
    SessionTreeUpdatedParams, ThinkingLevel, WorkflowStart, WorkflowStartParams,
    WorkflowStartResult,
};
pub use run_coordinator::{StartedRun, WorkflowRunCoordinator};
pub use runtime::{
    AcpSession, AcpSessionFactory, FixedRouter, GatewayError, GatewayEvent, InteractionResponse,
    PhenixAcpGateway, PhenixAcpGatewayBuilder, RoutingDecision, RoutingRequest, SessionCommand,
    SessionEvent, SessionImage, SessionOpenKind, SessionOpenRequest, SessionRouter, StaticWorkflow,
    TreeStartResult, Workflow, WorkflowPlan, WorkflowPlanBuilder, WorkflowRequest, WorkflowStep,
};
pub use source::{
    DifficultyModelConfigs, RouteSelector, RoutingRule, RoutingTable, WorkflowDefinition,
    WorkflowStepDefinition,
};
pub use subscription::{NodeSubscribe, NodeSubscriptionParams, NodeUnsubscribe};
pub use tools::{
    BuiltinToolPolicy, McpServerDefinition, McpServerTransport, ToolConfigError, ToolConfiguration,
};
pub use workflow_ir::{
    CallableWorkflowDefinition, DependencyFailurePolicy, WorkflowDefinitionError,
    WorkflowInputBinding, WorkflowNodeDefinition, WorkflowPort, WorkflowValueSource,
};
pub use workflow_runtime::{
    ArtifactStore, ReadyInvocation, StoredArtifact, WorkflowNodeRunState, WorkflowOutput,
    WorkflowRuntime, WorkflowRuntimeError,
};
