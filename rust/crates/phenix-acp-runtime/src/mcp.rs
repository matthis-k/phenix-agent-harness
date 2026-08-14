use agent_client_protocol::schema::v1::{
    ConnectMcpRequest, McpConnectionId, McpServerAcpId, MessageMcpNotification, MessageMcpRequest,
};
use agent_client_protocol::{Client, ConnectionTo};
use genai::chat::Tool;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

#[derive(Clone, Debug)]
pub struct AcpTool {
    pub definition: Tool,
    pub connection_id: McpConnectionId,
    pub remote_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListToolsResult {
    tools: Vec<McpToolDefinition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpToolDefinition {
    name: String,
    #[serde(default)]
    description: String,
    input_schema: Value,
}

pub async fn connect_tools(
    connection: &ConnectionTo<Client>,
    server_ids: &[McpServerAcpId],
) -> Result<Vec<AcpTool>, String> {
    let mut tools = Vec::new();
    let mut names = BTreeSet::new();
    for server_id in server_ids {
        let connected = connection
            .send_request(ConnectMcpRequest::new(server_id.clone()))
            .block_task()
            .await
            .map_err(|error| format!("cannot connect to ACP MCP server {server_id}: {error}"))?;
        let connection_id = connected.connection_id;
        let initialize = json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "phenix-acp-runtime", "version": env!("CARGO_PKG_VERSION") }
        });
        request(connection, &connection_id, "initialize", initialize).await?;
        connection
            .send_notification(MessageMcpNotification::new(
                connection_id.clone(),
                "notifications/initialized",
            ))
            .map_err(|error| format!("cannot initialize ACP MCP server {server_id}: {error}"))?;
        let listed: ListToolsResult = serde_json::from_value(
            request(connection, &connection_id, "tools/list", json!({})).await?,
        )
        .map_err(|error| format!("invalid tools/list response from {server_id}: {error}"))?;
        for tool in listed.tools {
            if !names.insert(tool.name.clone()) {
                return Err(format!(
                    "MCP tool name {:?} is provided by more than one attached server",
                    tool.name
                ));
            }
            tools.push(AcpTool {
                definition: Tool::new(tool.name.clone())
                    .with_description(tool.description)
                    .with_schema(tool.input_schema),
                connection_id: connection_id.clone(),
                remote_name: tool.name,
            });
        }
    }
    Ok(tools)
}

pub async fn call_tool(
    connection: &ConnectionTo<Client>,
    tool: &AcpTool,
    arguments: Value,
) -> Result<Value, String> {
    request(
        connection,
        &tool.connection_id,
        "tools/call",
        json!({ "name": tool.remote_name, "arguments": arguments }),
    )
    .await
}

async fn request(
    connection: &ConnectionTo<Client>,
    connection_id: &McpConnectionId,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let params = match params {
        Value::Object(params) => params,
        Value::Null => Map::new(),
        _ => return Err(format!("MCP {method} parameters must be an object")),
    };
    let response = connection
        .send_request(MessageMcpRequest::new(connection_id.clone(), method).params(params))
        .block_task()
        .await
        .map_err(|error| format!("MCP {method} failed: {error}"))?;
    serde_json::from_str(response.0.get())
        .map_err(|error| format!("MCP {method} returned invalid JSON: {error}"))
}
