#![forbid(unsafe_code)]

use phenix_core::{
    ExecutionEvent, ExecutionId, ExecutionSummary, ExecutionTarget, SessionId, SessionSummary,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RuntimeSnapshot {
    pub sessions: Vec<SessionSummary>,
    pub executions: Vec<ExecutionSummary>,
    pub last_event_sequence: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Initialize {
        after_sequence: Option<u64>,
    },
    GetSnapshot,
    CreateSession {
        parent_session: Option<SessionId>,
        name: Option<String>,
        target: ExecutionTarget,
    },
    ForkSession {
        session_id: SessionId,
        name: Option<String>,
    },
    RenameSession {
        session_id: SessionId,
        name: String,
    },
    SetSessionTarget {
        session_id: SessionId,
        target: ExecutionTarget,
    },
    Submit {
        session_id: SessionId,
        text: String,
    },
    CancelExecution {
        execution_id: ExecutionId,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ClientMessage {
    pub id: u64,
    pub command: Command,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    Initialized {
        snapshot: RuntimeSnapshot,
        events: Vec<ExecutionEvent>,
    },
    Snapshot {
        snapshot: RuntimeSnapshot,
    },
    Session {
        session: SessionSummary,
    },
    Execution {
        execution: ExecutionSummary,
    },
    Accepted,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    UnknownId,
    PolicyDenied,
    UnsupportedCapability,
    RoutingFailure,
    BackendTransport,
    BackendProtocol,
    ToolFailure,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    pub session_id: Option<SessionId>,
    pub execution_id: Option<ExecutionId>,
}

/// Explicit wire-level response sum type. This avoids exposing Serde's native
/// `Result<T, E>` representation as part of the Phenix protocol contract.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResponsePayload {
    Ok { result: Reply },
    Error { error: ProtocolError },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Response {
        id: u64,
        #[serde(flatten)]
        response: ResponsePayload,
    },
    Event {
        event: ExecutionEvent,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_has_explicit_request_ids() {
        let message = ClientMessage {
            id: 7,
            command: Command::GetSnapshot,
        };
        assert_eq!(message.id, 7);
    }

    #[test]
    fn response_wire_shape_is_protocol_owned() {
        let message = ServerMessage::Response {
            id: 7,
            response: ResponsePayload::Ok {
                result: Reply::Accepted,
            },
        };
        let value = serde_json::to_value(message).expect("serialize response");
        assert_eq!(value["type"], "response");
        assert_eq!(value["status"], "ok");
        assert_eq!(value["id"], 7);
        assert_eq!(value["result"]["type"], "accepted");
        assert!(value.get("Ok").is_none());
    }
}
