#![forbid(unsafe_code)]

mod client;
mod definition;
mod id;
mod protocol;
mod tools;

pub use client::{AcpClient, AcpTransport, CallError, EnvelopeError, RemoteError};
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
