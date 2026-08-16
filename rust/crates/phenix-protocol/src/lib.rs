#![forbid(unsafe_code)]

use phenix_core::{
    AuthenticationMethodId, BackendCatalog, BackendId, CallableDescriptor, CallableId,
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
    GetCallableCatalog,
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
    StartCallable {
        session_id: SessionId,
        callable: CallableId,
        objective: String,
    },
    CancelExecution {
        execution_id: ExecutionId,
    },
    RefreshBackendCatalog {
        backend_id: BackendId,
    },
    SelectAuthentication {
        backend_id: BackendId,
        method_id: AuthenticationMethodId,
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
        backends: Vec<BackendCatalog>,
    },
    Snapshot {
        snapshot: RuntimeSnapshot,
        backends: Vec<BackendCatalog>,
    },
    CallableCatalog {
        callables: Vec<CallableDescriptor>,
    },
    Session {
        session: SessionSummary,
    },
    Execution {
        execution: ExecutionSummary,
    },
    BackendCatalog {
        catalog: BackendCatalog,
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
    AuthenticationRequired,
    BackendTransport,
    BackendProtocol,
    ExecutionProviderFailure,
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

    #[test]
    fn callable_start_wire_shape_is_typed_and_backend_neutral() {
        let message = ClientMessage {
            id: 9,
            command: Command::StartCallable {
                session_id: SessionId::parse("session-1").expect("valid session id"),
                callable: CallableId::parse("workflow.implement").expect("valid callable id"),
                objective: "implement change".to_owned(),
            },
        };
        let value = serde_json::to_value(message).expect("serialize callable start");
        assert_eq!(value["command"]["type"], "start_callable");
        assert_eq!(value["command"]["session_id"], "session-1");
        assert_eq!(value["command"]["callable"], "workflow.implement");
        assert_eq!(value["command"]["objective"], "implement change");
        assert!(value["command"].get("backend").is_none());
        assert!(value["command"].get("provider").is_none());
    }

    #[test]
    fn callable_catalog_wire_shape_is_conductor_owned() {
        let message = ClientMessage {
            id: 10,
            command: Command::GetCallableCatalog,
        };
        let value = serde_json::to_value(message).expect("serialize callable catalog request");
        assert_eq!(value["command"]["type"], "get_callable_catalog");
        assert_eq!(value["command"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn execution_provider_failure_has_stable_wire_code() {
        let value = serde_json::to_value(ErrorCode::ExecutionProviderFailure)
            .expect("serialize error code");
        assert_eq!(value, "execution_provider_failure");
    }
}
