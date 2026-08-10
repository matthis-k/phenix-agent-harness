#![forbid(unsafe_code)]

mod backend;
mod id;
mod protocol;
mod serde_capabilities;

pub use backend::{
    AgentBackend, BackendClient, BackendError, BackendOutput, BackendOutputSender, BackendRequest,
    BackendRuntime, BackendWorker,
};
pub use id::{
    AuthFlowId, DialogId, InvalidId, ObjectiveId, RequestId, RunId, SessionEntryId, SessionId,
    ToolCallId,
};
pub use protocol::*;
