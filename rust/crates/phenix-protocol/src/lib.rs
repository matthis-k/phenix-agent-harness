#![forbid(unsafe_code)]

use phenix_core::{
    AuthenticationInput, AuthenticationMethodId, BackendCatalog, BackendId, CallableDescriptor,
    CallableId, ConfigRevisionId, ExecutionEvent, ExecutionId, ExecutionSummary, ExecutionTarget,
    RoutingProfileDescriptor, SessionId, SessionSummary, SkillDescriptor,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    GetRoutingCatalog,
    GetSkillCatalog,
    ExportSessionDebug {
        session_id: SessionId,
    },
    RequestWorkspaceCheckpoint {
        execution_id: ExecutionId,
    },
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
    RebaseSession {
        session_id: SessionId,
        config_revision: ConfigRevisionId,
    },
    CloseSession {
        session_id: SessionId,
    },
    Submit {
        session_id: SessionId,
        text: String,
    },
    StartCallable {
        session_id: SessionId,
        callable: CallableId,
        input: Value,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<AuthenticationInput>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ClientMessage {
    pub id: u64,
    pub command: Command,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    RoutingCatalog {
        profiles: Vec<RoutingProfileDescriptor>,
    },
    SkillCatalog {
        skills: Vec<SkillDescriptor>,
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
    SessionDebug {
        bundle: Box<phenix_core::SessionDebugBundle>,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ResponsePayload {
    Ok { result: Reply },
    Error { error: ProtocolError },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    use phenix_core::{ProviderId, RoutingProfileId};

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
                callable: CallableId::parse("orchestration.implement").expect("valid callable id"),
                input: serde_json::json!({"objective": "implement change"}),
            },
        };
        let value = serde_json::to_value(message).expect("serialize callable start");
        assert_eq!(value["command"]["type"], "start_callable");
        assert_eq!(value["command"]["session_id"], "session-1");
        assert_eq!(value["command"]["callable"], "orchestration.implement");
        assert_eq!(
            value["command"]["input"],
            serde_json::json!({"objective": "implement change"})
        );
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
    fn skill_catalog_wire_shape_is_conductor_owned() {
        let request = ClientMessage {
            id: 12,
            command: Command::GetSkillCatalog,
        };
        let value = serde_json::to_value(request).expect("serialize skill catalog request");
        assert_eq!(value["command"]["type"], "get_skill_catalog");
        assert_eq!(value["command"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn routing_catalog_wire_shape_is_conductor_owned() {
        let request = ClientMessage {
            id: 11,
            command: Command::GetRoutingCatalog,
        };
        let value = serde_json::to_value(request).expect("serialize routing catalog request");
        assert_eq!(value["command"]["type"], "get_routing_catalog");
        assert_eq!(value["command"].as_object().unwrap().len(), 1);

        let reply = ServerMessage::Response {
            id: 11,
            response: ResponsePayload::Ok {
                result: Reply::RoutingCatalog {
                    profiles: vec![RoutingProfileDescriptor {
                        id: RoutingProfileId::parse("router.mixed").unwrap(),
                        providers: vec![
                            ProviderId::parse("openai-codex").unwrap(),
                            ProviderId::parse("opencode-go").unwrap(),
                        ],
                    }],
                },
            },
        };
        let value = serde_json::to_value(reply).expect("serialize routing catalog reply");
        assert_eq!(value["result"]["type"], "routing_catalog");
        assert_eq!(value["result"]["profiles"][0]["id"], "router.mixed");
        assert_eq!(
            value["result"]["profiles"][0]["providers"],
            serde_json::json!(["openai-codex", "opencode-go"])
        );
    }

    #[test]
    fn api_key_auth_input_is_typed_and_debug_redacted() {
        let message = ClientMessage {
            id: 11,
            command: Command::SelectAuthentication {
                backend_id: BackendId::parse("phenix").unwrap(),
                method_id: AuthenticationMethodId::parse("openai-api").unwrap(),
                input: Some(AuthenticationInput::ApiKey {
                    secret: "super-secret".to_owned(),
                }),
            },
        };
        let value = serde_json::to_value(&message).expect("serialize auth request");
        assert_eq!(value["command"]["input"]["type"], "api_key");
        assert_eq!(value["command"]["input"]["secret"], "super-secret");
        assert!(!format!("{message:?}").contains("super-secret"));
    }

    #[test]
    fn close_session_is_an_explicit_terminal_operation() {
        let message = ClientMessage {
            id: 11,
            command: Command::CloseSession {
                session_id: SessionId::parse("session-1").unwrap(),
            },
        };
        let value = serde_json::to_value(message).expect("serialize session close");
        assert_eq!(value["command"]["type"], "close_session");
        assert_eq!(value["command"]["session_id"], "session-1");
    }

    #[test]
    fn session_rebase_is_an_explicit_revision_operation() {
        let message = ClientMessage {
            id: 13,
            command: Command::RebaseSession {
                session_id: SessionId::parse("session-1").unwrap(),
                config_revision: ConfigRevisionId::parse("config-3").unwrap(),
            },
        };
        let value = serde_json::to_value(message).unwrap();
        assert_eq!(value["command"]["type"], "rebase_session");
        assert_eq!(value["command"]["session_id"], "session-1");
        assert_eq!(value["command"]["config_revision"], "config-3");
    }

    #[test]
    fn session_debug_export_is_an_explicit_operation() {
        let message = ClientMessage {
            id: 12,
            command: Command::ExportSessionDebug {
                session_id: SessionId::parse("session-1").unwrap(),
            },
        };
        let value = serde_json::to_value(message).unwrap();
        assert_eq!(value["command"]["type"], "export_session_debug");
        assert_eq!(value["command"]["session_id"], "session-1");
    }

    #[test]
    fn workspace_checkpoint_request_is_explicit() {
        let value = serde_json::to_value(ClientMessage {
            id: 13,
            command: Command::RequestWorkspaceCheckpoint {
                execution_id: ExecutionId::parse("execution-1").unwrap(),
            },
        })
        .unwrap();
        assert_eq!(value["command"]["type"], "request_workspace_checkpoint");
        assert_eq!(value["command"]["execution_id"], "execution-1");
    }

    #[test]
    fn execution_provider_failure_has_stable_wire_code() {
        let value = serde_json::to_value(ErrorCode::ExecutionProviderFailure)
            .expect("serialize error code");
        assert_eq!(value, "execution_provider_failure");
    }
}
