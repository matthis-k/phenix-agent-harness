use super::WorkerMessage;
use agent_client_protocol::schema::v1::{
    ConnectMcpRequest, ConnectMcpResponse, DisconnectMcpRequest, DisconnectMcpResponse,
    McpConnectionId, McpServer, McpServerAcp, MessageMcpNotification, MessageMcpRequest,
    MessageMcpResponse,
};
use phenix_backend::{
    BackendError, PreparedToolSurface, ToolInvocation, ToolPresentation, ToolResult,
};
use phenix_core::CallableDescriptor;
use serde_json::{json, value::RawValue, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{mpsc, Arc, Mutex};

const SERVER_ID: &str = "phenix-tools";
const SERVER_NAME: &str = "Phenix tools";
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Clone, Default)]
pub(super) struct ToolBridge {
    state: Arc<Mutex<ToolBridgeState>>,
}

#[derive(Default)]
struct ToolBridgeState {
    callables: BTreeMap<String, CallableDescriptor>,
    worker: Option<mpsc::Sender<WorkerMessage>>,
    connections: BTreeSet<String>,
    next_connection: u64,
}

impl ToolBridge {
    pub(super) fn server(&self) -> McpServer {
        McpServer::Acp(McpServerAcp::new(SERVER_NAME, SERVER_ID))
    }

    pub(super) fn bind(
        &self,
        tools: &PreparedToolSurface,
        worker: mpsc::Sender<WorkerMessage>,
    ) -> Result<(), BackendError> {
        if !tools.is_empty() && tools.presentation() != Some(ToolPresentation::AcpExtension) {
            return Err(BackendError::Unsupported(
                "ACP tool bridge requires the negotiated ACP extension presentation".to_owned(),
            ));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| BackendError::Protocol("ACP tool bridge lock poisoned".to_owned()))?;
        state.callables = tools
            .callables()
            .iter()
            .cloned()
            .map(|callable| (callable.id.as_str().to_owned(), callable))
            .collect();
        state.worker = Some(worker);
        Ok(())
    }

    pub(super) fn unbind(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.callables.clear();
            state.worker = None;
        }
    }

    pub(super) fn connect(
        &self,
        request: ConnectMcpRequest,
    ) -> Result<ConnectMcpResponse, agent_client_protocol::Error> {
        if request.server_id.0.as_ref() != SERVER_ID {
            return Err(agent_client_protocol::Error::invalid_params()
                .data(format!("unknown Phenix MCP server {}", request.server_id)));
        }
        let mut state = self.state.lock().map_err(|_| {
            agent_client_protocol::Error::internal_error().data("ACP tool bridge lock poisoned")
        })?;
        state.next_connection += 1;
        let connection_id = format!("phenix-tools-{}", state.next_connection);
        state.connections.insert(connection_id.clone());
        Ok(ConnectMcpResponse::new(connection_id))
    }

    pub(super) fn disconnect(
        &self,
        request: DisconnectMcpRequest,
    ) -> Result<DisconnectMcpResponse, agent_client_protocol::Error> {
        let mut state = self.state.lock().map_err(|_| {
            agent_client_protocol::Error::internal_error().data("ACP tool bridge lock poisoned")
        })?;
        state.connections.remove(request.connection_id.0.as_ref());
        Ok(DisconnectMcpResponse::new())
    }

    pub(super) fn message(
        &self,
        request: MessageMcpRequest,
    ) -> Result<MessageMcpResponse, agent_client_protocol::Error> {
        self.require_connection(&request.connection_id)?;
        let result = match request.method.as_str() {
            "initialize" => json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "phenix-conductor", "version": "0.1.0" }
            }),
            "ping" => json!({}),
            "tools/list" => self.list_tools()?,
            "tools/call" => self.call_tool(request.params.as_ref())?,
            method => {
                return Err(agent_client_protocol::Error::method_not_found()
                    .data(format!("unsupported Phenix MCP method {method}")));
            }
        };
        Ok(MessageMcpResponse::new(raw_value(result)?))
    }

    pub(super) fn notification(
        &self,
        notification: MessageMcpNotification,
    ) -> Result<(), agent_client_protocol::Error> {
        self.require_connection(&notification.connection_id)?;
        match notification.method.as_str() {
            "notifications/initialized" | "notifications/cancelled" => Ok(()),
            method => Err(agent_client_protocol::Error::method_not_found()
                .data(format!("unsupported Phenix MCP notification {method}"))),
        }
    }

    fn require_connection(
        &self,
        connection_id: &McpConnectionId,
    ) -> Result<(), agent_client_protocol::Error> {
        let state = self.state.lock().map_err(|_| {
            agent_client_protocol::Error::internal_error().data("ACP tool bridge lock poisoned")
        })?;
        if state.connections.contains(connection_id.0.as_ref()) {
            Ok(())
        } else {
            Err(agent_client_protocol::Error::invalid_params()
                .data(format!("unknown Phenix MCP connection {connection_id}")))
        }
    }

    fn list_tools(&self) -> Result<Value, agent_client_protocol::Error> {
        let state = self.state.lock().map_err(|_| {
            agent_client_protocol::Error::internal_error().data("ACP tool bridge lock poisoned")
        })?;
        let tools = state
            .callables
            .values()
            .map(|callable| {
                json!({
                    "name": callable.id.as_str(),
                    "description": callable.description,
                    "inputSchema": callable.input_schema,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "tools": tools }))
    }

    fn call_tool(
        &self,
        params: Option<&Map<String, Value>>,
    ) -> Result<Value, agent_client_protocol::Error> {
        let params = params.cloned().unwrap_or_default();
        let name = params.get("name").and_then(Value::as_str).ok_or_else(|| {
            agent_client_protocol::Error::invalid_params().data("tools/call is missing name")
        })?;
        let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));

        let (callable, worker) = {
            let state = self.state.lock().map_err(|_| {
                agent_client_protocol::Error::internal_error().data("ACP tool bridge lock poisoned")
            })?;
            let callable = state.callables.get(name).ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("tool is not provisioned for this execution: {name}"))
            })?;
            let worker = state.worker.clone().ok_or_else(|| {
                agent_client_protocol::Error::internal_error()
                    .data("ACP tool call arrived outside an active execution")
            })?;
            (callable.id.clone(), worker)
        };

        let (response_tx, response_rx) = mpsc::sync_channel(1);
        worker
            .send(WorkerMessage::ToolCall(BridgeToolRequest {
                invocation: ToolInvocation {
                    callable,
                    arguments_json: serde_json::to_string(&arguments)
                        .map_err(agent_client_protocol::Error::into_internal_error)?,
                },
                response: response_tx,
            }))
            .map_err(|error| {
                agent_client_protocol::Error::internal_error()
                    .data(format!("conductor tool host is unavailable: {error}"))
            })?;
        let result = response_rx.recv().map_err(|error| {
            agent_client_protocol::Error::internal_error()
                .data(format!("conductor tool result channel closed: {error}"))
        })?;
        Ok(tool_result(result))
    }
}

pub(super) struct BridgeToolRequest {
    pub(super) invocation: ToolInvocation,
    pub(super) response: mpsc::SyncSender<Result<ToolResult, BackendError>>,
}

fn tool_result(result: Result<ToolResult, BackendError>) -> Value {
    match result {
        Ok(result) => json!({
            "content": [{ "type": "text", "text": result.output }],
            "isError": !result.success,
        }),
        Err(error) => json!({
            "content": [{ "type": "text", "text": error.to_string() }],
            "isError": true,
        }),
    }
}

fn raw_value(value: Value) -> Result<Arc<RawValue>, agent_client_protocol::Error> {
    RawValue::from_string(value.to_string())
        .map(Arc::from)
        .map_err(agent_client_protocol::Error::into_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::{BackendCapabilities, ToolProvision};
    use phenix_core::{CallableId, CallableKind, CallablePolicy, CapabilitySet};

    fn callable() -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse("phenix.echo").unwrap(),
            kind: CallableKind::Agent,
            description: "Echo a value".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": { "value": { "type": "string" } },
                "required": ["value"]
            }),
            output_schema: json!({ "type": "string" }),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    fn surface() -> PreparedToolSurface {
        ToolProvision {
            callables: vec![callable()],
        }
        .prepare(&BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::AcpExtension]),
            images: false,
            persistent_sessions: false,
        })
        .unwrap()
    }

    #[test]
    fn server_declaration_uses_native_acp_transport() {
        assert!(matches!(ToolBridge::default().server(), McpServer::Acp(_)));
    }

    #[test]
    fn list_tools_preserves_callable_schema() {
        let bridge = ToolBridge::default();
        let (worker, _rx) = mpsc::channel();
        bridge.bind(&surface(), worker).unwrap();
        let listed = bridge.list_tools().unwrap();
        assert_eq!(listed["tools"][0]["name"], "phenix.echo");
        assert_eq!(listed["tools"][0]["inputSchema"]["type"], "object");
    }
}
