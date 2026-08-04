#![forbid(unsafe_code)]

pub use agent_client_protocol as acp;

mod client;
mod definition;
mod id;
mod protocol;
mod tools;

pub use client::{
    decode_extension_response, encode_extension_request, ExtensionCodecError, PhenixAcpCallError,
};
pub use definition::{
    AcpEndpoint, BackendDefinition, DefinitionError, SessionTreeDefinition,
    SessionTreeDefinitionBuilder,
};
pub use id::{
    AcpSessionId, BackendId, DefinitionId, IdError, McpServerName, ModelId, ObjectiveId,
    ProviderId, RoleId, RouterId, RpcRequestId, SessionNodeId, SessionTreeId, ToolId, WorkflowId,
};
pub use protocol::{
    AcpMethod, ModelSelection, ObjectiveSnapshot, ObjectiveState, RoutingExplain,
    RoutingExplainParams, RoutingExplainResult, SessionNodeSnapshot, SessionNodeState,
    SessionTreeCreate, SessionTreeCreateParams, SessionTreeCreateResult, SessionTreeGet,
    SessionTreeGetParams, SessionTreeList, SessionTreeListParams, SessionTreeListResult,
    SessionTreeSnapshot, SessionTreeSummary, WorkflowStart, WorkflowStartParams,
    WorkflowStartResult,
};
pub use tools::{
    BuiltinToolPolicy, McpServerDefinition, McpServerTransport, ToolConfigError, ToolConfiguration,
};
