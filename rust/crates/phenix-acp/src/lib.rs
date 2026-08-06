#![forbid(unsafe_code)]

pub use agent_client_protocol as acp;

mod authoring;
mod client;
mod conductor;
mod definition;
mod id;
mod protocol;
mod runtime;
mod source;
mod tools;

pub use authoring::{
    parse_definition, parse_definition_with_format, parse_routing_table,
    parse_routing_table_with_format, parse_workflow, parse_workflow_with_format, Definition,
    DefinitionFormat, DefinitionKind, DefinitionParseError, Definitions, FormatAttempt,
};
pub use client::{
    decode_extension_response, encode_extension_request, ExtensionCodecError, PhenixAcpCallError,
};
pub use conductor::{ConductorError, PhenixConductor};
pub use definition::{
    AcpEndpoint, BackendDefinition, DefinitionError, SessionTreeDefinition,
    SessionTreeDefinitionBuilder,
};
pub use id::{
    AcpSessionId, BackendId, DefinitionId, IdError, McpServerName, ModelId, ObjectiveId,
    ProviderId, RoleId, RouterId, RpcRequestId, SessionNodeId, SessionTreeId, ToolId, WorkflowId,
};
pub use protocol::{
    AcpMethod, AcpNotification, EmptyResult, ModelSelection, NodeAttachResult, NodeCancel,
    NodeCancelParams, NodeDelegate, NodeDelegateParams, NodeEventNotification, NodeEventParams,
    NodeExecute, NodeExecuteParams, NodeExecuteResult, NodeFork, NodeForkParams, NodeLoad,
    NodeLoadParams, NodeResume, NodeResumeParams, ObjectiveMark, ObjectiveMarkParams,
    ObjectiveSnapshot, ObjectiveState, RoutingExplain, RoutingExplainParams, RoutingExplainResult,
    SessionNodeSnapshot, SessionNodeState, SessionTreeClose, SessionTreeCloseParams,
    SessionTreeCreate, SessionTreeCreateParams, SessionTreeCreateResult, SessionTreeGet,
    SessionTreeGetParams, SessionTreeList, SessionTreeListParams, SessionTreeListResult,
    SessionTreeSnapshot, SessionTreeSummary, SessionTreeUpdatedNotification,
    SessionTreeUpdatedParams, WorkflowStart, WorkflowStartParams, WorkflowStartResult,
};
pub use runtime::{
    AcpSession, AcpSessionFactory, FirstAvailableRouter, FixedRouter, GatewayCommand,
    GatewayEnvelope, GatewayError, GatewayEvent, GatewayFailure, GatewayReply, InteractionResponse,
    PhenixAcpGateway, PhenixAcpGatewayBuilder, RoutingDecision, RoutingRequest, SessionCommand,
    SessionEvent, SessionImage, SessionOpenKind, SessionOpenRequest, SessionRouter, StaticWorkflow,
    TreeStartResult, Workflow, WorkflowPlan, WorkflowPlanBuilder, WorkflowRequest, WorkflowStep,
};
pub use source::{
    ModelTarget, RouteSelector, RoutingRule, RoutingTable, WorkflowDefinition,
    WorkflowStepDefinition,
};
pub use tools::{
    BuiltinToolPolicy, McpServerDefinition, McpServerTransport, ToolConfigError, ToolConfiguration,
};
