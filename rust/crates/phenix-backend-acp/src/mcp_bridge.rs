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
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorCode, ErrorData,
    Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer, RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::Transport;
use rmcp::{ServerHandler, ServiceExt};
use serde_json::{json, value::RawValue, Map, Value};
use std::collections::BTreeMap;
use std::future::{ready, Future};
use std::io;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use tokio::sync::mpsc as tokio_mpsc;

const SERVER_ID: &str = "phenix-tools";
const SERVER_NAME: &str = "Phenix tools";

#[derive(Clone, Default)]
pub(super) struct ToolBridge {
    host: Arc<Mutex<ToolHostState>>,
    connections: Arc<Mutex<ConnectionRegistry>>,
}

#[derive(Default)]
struct ToolHostState {
    callables: BTreeMap<String, CallableDescriptor>,
    worker: Option<mpsc::Sender<WorkerMessage>>,
}

#[derive(Default)]
struct ConnectionRegistry {
    connections: BTreeMap<String, Arc<Mutex<McpConnection>>>,
    next_connection: u64,
}

struct McpConnection {
    incoming: tokio_mpsc::UnboundedSender<RxJsonRpcMessage<RoleServer>>,
    outgoing: mpsc::Receiver<TxJsonRpcMessage<RoleServer>>,
    thread: thread::JoinHandle<()>,
    next_request: u64,
}

impl ToolBridge {
    pub(super) fn server(&self) -> McpServer {
        McpServer::Acp(McpServerAcp::new(SERVER_NAME, SERVER_ID))
    }

    pub(super) fn provision(&self, tools: &PreparedToolSurface) -> Result<(), BackendError> {
        if !tools.is_empty() && tools.presentation() != Some(ToolPresentation::AcpExtension) {
            return Err(BackendError::Unsupported(
                "ACP tool bridge requires the negotiated ACP extension presentation".to_owned(),
            ));
        }
        let mut host = self
            .host
            .lock()
            .map_err(|_| BackendError::Protocol("ACP tool bridge lock poisoned".to_owned()))?;
        host.callables = tools
            .callables()
            .iter()
            .cloned()
            .map(|callable| (callable.id.as_str().to_owned(), callable))
            .collect();
        Ok(())
    }

    pub(super) fn bind_execution(
        &self,
        tools: &PreparedToolSurface,
        worker: mpsc::Sender<WorkerMessage>,
    ) -> Result<(), BackendError> {
        self.provision(tools)?;
        let mut host = self
            .host
            .lock()
            .map_err(|_| BackendError::Protocol("ACP tool bridge lock poisoned".to_owned()))?;
        host.worker = Some(worker);
        Ok(())
    }

    pub(super) fn unbind_execution(&self) {
        if let Ok(mut host) = self.host.lock() {
            host.worker = None;
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

        let mut registry = self.connections.lock().map_err(|_| {
            agent_client_protocol::Error::internal_error()
                .data("ACP MCP connection registry lock poisoned")
        })?;
        registry.next_connection += 1;
        let connection_id = format!("phenix-tools-{}", registry.next_connection);
        let connection = McpConnection::start(self.host.clone(), &connection_id)?;
        registry
            .connections
            .insert(connection_id.clone(), Arc::new(Mutex::new(connection)));
        Ok(ConnectMcpResponse::new(connection_id))
    }

    pub(super) fn disconnect(
        &self,
        request: DisconnectMcpRequest,
    ) -> Result<DisconnectMcpResponse, agent_client_protocol::Error> {
        let connection = self
            .connections
            .lock()
            .map_err(|_| {
                agent_client_protocol::Error::internal_error()
                    .data("ACP MCP connection registry lock poisoned")
            })?
            .connections
            .remove(request.connection_id.0.as_ref());
        if let Some(connection) = connection {
            let connection = Arc::try_unwrap(connection).map_err(|_| {
                agent_client_protocol::Error::internal_error()
                    .data("ACP MCP connection is still in use while disconnecting")
            })?;
            connection
                .into_inner()
                .map_err(|_| {
                    agent_client_protocol::Error::internal_error()
                        .data("ACP MCP connection lock poisoned")
                })?
                .shutdown()?;
        }
        Ok(DisconnectMcpResponse::new())
    }

    pub(super) fn message(
        &self,
        request: MessageMcpRequest,
    ) -> Result<MessageMcpResponse, agent_client_protocol::Error> {
        let connection = self.connection(&request.connection_id)?;
        let mut connection = connection.lock().map_err(|_| {
            agent_client_protocol::Error::internal_error().data("ACP MCP connection lock poisoned")
        })?;
        let result = connection.request(&request.method, request.params)?;
        Ok(MessageMcpResponse::new(raw_value(result)?))
    }

    pub(super) fn notification(
        &self,
        notification: MessageMcpNotification,
    ) -> Result<(), agent_client_protocol::Error> {
        let connection = self.connection(&notification.connection_id)?;
        connection
            .lock()
            .map_err(|_| {
                agent_client_protocol::Error::internal_error()
                    .data("ACP MCP connection lock poisoned")
            })?
            .notify(&notification.method, notification.params)
    }

    fn connection(
        &self,
        connection_id: &McpConnectionId,
    ) -> Result<Arc<Mutex<McpConnection>>, agent_client_protocol::Error> {
        self.connections
            .lock()
            .map_err(|_| {
                agent_client_protocol::Error::internal_error()
                    .data("ACP MCP connection registry lock poisoned")
            })?
            .connections
            .get(connection_id.0.as_ref())
            .cloned()
            .ok_or_else(|| {
                agent_client_protocol::Error::invalid_params()
                    .data(format!("unknown Phenix MCP connection {connection_id}"))
            })
    }
}

impl McpConnection {
    fn start(
        host: Arc<Mutex<ToolHostState>>,
        connection_id: &str,
    ) -> Result<Self, agent_client_protocol::Error> {
        let runtime = tokio::runtime::Runtime::new().map_err(|error| {
            agent_client_protocol::Error::internal_error()
                .data(format!("cannot start MCP runtime: {error}"))
        })?;
        let (incoming, incoming_rx) = tokio_mpsc::unbounded_channel();
        let (outgoing_tx, outgoing) = mpsc::channel();
        let transport = AcpMcpTransport {
            incoming: incoming_rx,
            outgoing: outgoing_tx,
        };
        let thread_name = format!("phenix-mcp-{connection_id}");
        let thread = thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                runtime.block_on(async move {
                    match McpToolServer { host }.serve(transport).await {
                        Ok(service) => {
                            let _ = service.waiting().await;
                        }
                        Err(error) => {
                            eprintln!("Phenix MCP server stopped during initialization: {error}");
                        }
                    }
                });
            })
            .map_err(|error| {
                agent_client_protocol::Error::internal_error()
                    .data(format!("cannot start MCP server thread: {error}"))
            })?;
        Ok(Self {
            incoming,
            outgoing,
            thread,
            next_request: 0,
        })
    }

    fn request(
        &mut self,
        method: &str,
        params: Option<Map<String, Value>>,
    ) -> Result<Value, agent_client_protocol::Error> {
        self.next_request += 1;
        let request_id = format!("phenix-{}", self.next_request);
        self.incoming
            .send(mcp_message(method, params, Some(&request_id))?)
            .map_err(|_| {
                agent_client_protocol::Error::internal_error()
                    .data("Phenix MCP server connection closed")
            })?;

        loop {
            let message = self.outgoing.recv().map_err(|_| {
                agent_client_protocol::Error::internal_error()
                    .data("Phenix MCP server stopped before responding")
            })?;
            let value = serde_json::to_value(message)
                .map_err(agent_client_protocol::Error::into_internal_error)?;
            if value.get("method").is_some() {
                continue;
            }
            if value.get("id") != Some(&Value::String(request_id.clone())) {
                return Err(agent_client_protocol::Error::internal_error()
                    .data("Phenix MCP server returned a response for a different request"));
            }
            if let Some(result) = value.get("result") {
                return Ok(result.clone());
            }
            if let Some(error) = value.get("error") {
                return Err(acp_error_from_mcp(error));
            }
            return Err(agent_client_protocol::Error::internal_error()
                .data("Phenix MCP server returned neither a result nor an error"));
        }
    }

    fn notify(
        &mut self,
        method: &str,
        params: Option<Map<String, Value>>,
    ) -> Result<(), agent_client_protocol::Error> {
        self.incoming
            .send(mcp_message(method, params, None)?)
            .map_err(|_| {
                agent_client_protocol::Error::internal_error()
                    .data("Phenix MCP server connection closed")
            })
    }

    fn shutdown(self) -> Result<(), agent_client_protocol::Error> {
        let Self {
            incoming,
            outgoing,
            thread,
            ..
        } = self;
        drop(incoming);
        drop(outgoing);
        thread.join().map_err(|_| {
            agent_client_protocol::Error::internal_error().data("Phenix MCP server thread panicked")
        })
    }
}

struct AcpMcpTransport {
    incoming: tokio_mpsc::UnboundedReceiver<RxJsonRpcMessage<RoleServer>>,
    outgoing: mpsc::Sender<TxJsonRpcMessage<RoleServer>>,
}

impl Transport<RoleServer> for AcpMcpTransport {
    type Error = io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let outgoing = self.outgoing.clone();
        async move {
            outgoing.send(item).map_err(|_| {
                io::Error::new(io::ErrorKind::BrokenPipe, "ACP MCP connection closed")
            })
        }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        self.incoming.recv().await
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.incoming.close();
        ready(Ok(()))
    }
}

#[derive(Clone)]
struct McpToolServer {
    host: Arc<Mutex<ToolHostState>>,
}

impl McpToolServer {
    fn tools(&self) -> Result<Vec<Tool>, ErrorData> {
        let host = self
            .host
            .lock()
            .map_err(|_| ErrorData::internal_error("Phenix tool host lock poisoned", None))?;
        host.callables.values().map(mcp_tool).collect()
    }
}

impl ServerHandler for McpToolServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("phenix-conductor", env!("CARGO_PKG_VERSION")),
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.tools()?))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let (callable, worker) = {
            let host = self
                .host
                .lock()
                .map_err(|_| ErrorData::internal_error("Phenix tool host lock poisoned", None))?;
            let callable = host.callables.get(request.name.as_ref()).ok_or_else(|| {
                ErrorData::new(
                    ErrorCode::METHOD_NOT_FOUND,
                    format!("tool is not provisioned for this execution: {}", request.name),
                    None,
                )
            })?;
            let worker = host.worker.clone().ok_or_else(|| {
                ErrorData::internal_error("MCP tool call arrived outside an active execution", None)
            })?;
            (callable.id.clone(), worker)
        };
        let arguments = request.arguments.unwrap_or_default();
        let arguments_json = serde_json::to_string(&arguments).map_err(|error| {
            ErrorData::internal_error(
                "cannot serialize MCP tool arguments",
                Some(json!({"reason": error.to_string()})),
            )
        })?;
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        worker
            .send(WorkerMessage::ToolCall(BridgeToolRequest {
                invocation: ToolInvocation {
                    callable,
                    arguments_json,
                },
                response: response_tx,
            }))
            .map_err(|error| {
                ErrorData::internal_error(
                    "conductor tool host is unavailable",
                    Some(json!({"reason": error.to_string()})),
                )
            })?;
        let result = response_rx.recv().map_err(|error| {
            ErrorData::internal_error(
                "conductor tool result channel closed",
                Some(json!({"reason": error.to_string()})),
            )
        })?;
        Ok(tool_result(result).into())
    }
}

#[derive(Debug)]
pub(super) struct BridgeToolRequest {
    pub(super) invocation: ToolInvocation,
    pub(super) response: mpsc::SyncSender<Result<ToolResult, BackendError>>,
}

fn mcp_tool(callable: &CallableDescriptor) -> Result<Tool, ErrorData> {
    let input_schema = callable.input_schema.as_object().cloned().ok_or_else(|| {
        ErrorData::internal_error(
            format!("MCP tool {} has a non-object input schema", callable.id),
            None,
        )
    })?;
    Ok(Tool::new(
        callable.id.as_str().to_owned(),
        callable.description.clone(),
        Arc::new(input_schema),
    ))
}

fn tool_result(result: Result<ToolResult, BackendError>) -> CallToolResult {
    match result {
        Ok(result) if result.success => {
            CallToolResult::success(vec![ContentBlock::text(result.output)])
        }
        Ok(result) => CallToolResult::error(vec![ContentBlock::text(result.output)]),
        Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
    }
}

fn mcp_message(
    method: &str,
    params: Option<Map<String, Value>>,
    request_id: Option<&str>,
) -> Result<RxJsonRpcMessage<RoleServer>, agent_client_protocol::Error> {
    let mut message = Map::from_iter([
        ("jsonrpc".to_owned(), Value::String("2.0".to_owned())),
        ("method".to_owned(), Value::String(method.to_owned())),
    ]);
    if let Some(params) = params {
        message.insert("params".to_owned(), Value::Object(params));
    }
    if let Some(request_id) = request_id {
        message.insert("id".to_owned(), Value::String(request_id.to_owned()));
    }
    serde_json::from_value(Value::Object(message)).map_err(|error| {
        agent_client_protocol::Error::invalid_params()
            .data(format!("invalid MCP request {method}: {error}"))
    })
}

fn acp_error_from_mcp(error: &Value) -> agent_client_protocol::Error {
    let code = error.get("code").and_then(Value::as_i64);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("MCP request failed");
    let detail = match error.get("data") {
        Some(data) => format!("{message}: {data}"),
        None => message.to_owned(),
    };
    match code {
        Some(-32601) => agent_client_protocol::Error::method_not_found().data(detail),
        Some(-32602) => agent_client_protocol::Error::invalid_params().data(detail),
        _ => agent_client_protocol::Error::internal_error().data(detail),
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
    use std::collections::BTreeSet;

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

    fn params(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn response_value(response: MessageMcpResponse) -> Value {
        serde_json::from_str(response.0.get()).unwrap()
    }

    #[test]
    fn server_declaration_uses_native_acp_transport() {
        assert!(matches!(ToolBridge::default().server(), McpServer::Acp(_)));
    }

    #[test]
    fn rmcp_owns_negotiation_and_tool_listing() {
        let bridge = ToolBridge::default();
        bridge.provision(&surface()).unwrap();
        let connected = bridge.connect(ConnectMcpRequest::new(SERVER_ID)).unwrap();
        let connection_id = connected.connection_id;

        let initialized = bridge
            .message(
                MessageMcpRequest::new(connection_id.clone(), "initialize").params(params(json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "phenix-test", "version": "0.1.0"}
                }))),
            )
            .unwrap();
        let initialized = response_value(initialized);
        assert_eq!(initialized["protocolVersion"], "2025-06-18");
        assert_eq!(initialized["serverInfo"]["name"], "phenix-conductor");

        bridge
            .notification(MessageMcpNotification::new(
                connection_id.clone(),
                "notifications/initialized",
            ))
            .unwrap();
        let listed = bridge
            .message(MessageMcpRequest::new(connection_id.clone(), "tools/list"))
            .unwrap();
        let listed = response_value(listed);
        assert_eq!(listed["tools"][0]["name"], "phenix.echo");
        assert_eq!(listed["tools"][0]["inputSchema"]["type"], "object");

        bridge
            .disconnect(DisconnectMcpRequest::new(connection_id))
            .unwrap();
    }
}
