use crate::{CallableId, ExecutionId, SessionId, ToolCallId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelTarget {
    pub backend: String,
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutionTarget {
    Fixed { model: ModelTarget },
    Routed { profile: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallableKind {
    Tool,
    Agent,
    Workflow,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CallableDescriptor {
    pub id: CallableId,
    pub kind: CallableKind,
    pub description: String,
    /// JSON Schema encoded as JSON text. Schema interpretation belongs to the
    /// conductor, not a backend transport.
    pub input_schema: String,
    pub output_schema: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: SessionId,
    /// Session lineage is persistent/user-visible and deliberately distinct
    /// from execution parentage.
    pub parent_session: Option<SessionId>,
    pub name: Option<String>,
    pub default_target: ExecutionTarget,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionKind {
    Root,
    Agent,
    Workflow,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Pending,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExecutionSummary {
    pub id: ExecutionId,
    pub session_id: SessionId,
    /// Execution parentage is ephemeral computation structure, not session
    /// history/fork lineage.
    pub parent_execution: Option<ExecutionId>,
    pub kind: ExecutionKind,
    pub callable: Option<CallableId>,
    pub target: ExecutionTarget,
    pub state: ExecutionState,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExecutionEvent {
    /// Monotonic sequence within one conductor process/event store.
    pub sequence: u64,
    pub session_id: SessionId,
    pub execution_id: ExecutionId,
    pub kind: ExecutionEventKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionEventKind {
    UserInput {
        text: String,
    },
    AssistantContentDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCallStarted {
        tool_call_id: ToolCallId,
        callable: CallableId,
        arguments_json: String,
    },
    ToolCallUpdated {
        tool_call_id: ToolCallId,
        output: String,
    },
    ToolCallFinished {
        tool_call_id: ToolCallId,
        output: String,
        success: bool,
    },
    ChildExecutionStarted {
        child: ExecutionId,
    },
    StateChanged {
        state: ExecutionState,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RuntimeSnapshot {
    pub sessions: Vec<SessionSummary>,
    pub executions: Vec<ExecutionSummary>,
    pub callables: Vec<CallableDescriptor>,
    pub last_event_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientCommand {
    Initialize,
    Snapshot,
    SessionCreate {
        parent_session: Option<SessionId>,
        name: Option<String>,
        target: ExecutionTarget,
    },
    SessionFork {
        session_id: SessionId,
        name: Option<String>,
    },
    Submit {
        session_id: SessionId,
        /// `None` inherits the session target. Explicit fixed/routed targeting
        /// is represented as a sum type, so conflicting modes are impossible.
        target: Option<ExecutionTarget>,
        text: String,
    },
    Cancel {
        execution_id: ExecutionId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerReply {
    Initialized { snapshot: RuntimeSnapshot },
    Snapshot { snapshot: RuntimeSnapshot },
    SessionCreated { session: SessionSummary },
    ExecutionStarted { execution: ExecutionSummary },
    Accepted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Execution { event: ExecutionEvent },
    SnapshotChanged { snapshot: RuntimeSnapshot },
}

/// Line-delimited frontend request envelope. This is intentionally Phenix-owned
/// rather than JSON-RPC/ACP-shaped; transport details may change independently.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FrontendRequest {
    pub id: u64,
    pub command: ClientCommand,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FrontendError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FrontendResponse {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ServerReply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FrontendError>,
}
