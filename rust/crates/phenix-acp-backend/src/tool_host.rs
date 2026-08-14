use crate::process_transport::BlockingAcpAgent;
use agent_client_protocol_conductor::{ConductorImpl, ProxiesAndAgent};
use agent_client_protocol_rmcp::McpServerExt as _;
use phenix_acp::acp::mcp_server::{McpConnectionTo, McpServer, McpTool};
use phenix_acp::acp::schema::v1::McpCapabilities;
use phenix_acp::acp::{Client, Conductor, ConnectTo, DynConnectTo, Proxy};
use phenix_acp::{
    BuiltinToolPolicy, Difficulty, McpServerTransportRef, RoleId, ToolInvocation, ToolProvision,
    WorkflowId,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{json, Value};
use std::future::Future;

pub(crate) fn provisioned_agent(
    agent: BlockingAcpAgent,
    provision: Option<ToolProvision>,
) -> DynConnectTo<Client> {
    match provision.filter(ToolProvision::requires_model_tool_host) {
        Some(provision) => DynConnectTo::new(ConductorImpl::new_agent(
            "phenix-tool-provision",
            ProxiesAndAgent::new(agent).proxy(ProvisionedToolsProxy { provision }),
        )),
        None => DynConnectTo::new(agent),
    }
}

pub(crate) fn external_mcp_servers(
    provision: &ToolProvision,
) -> Result<Vec<phenix_acp::acp::schema::v1::McpServer>, phenix_acp::acp::Error> {
    provision
        .configuration()
        .mcp_servers()
        .map(|server| {
            let name = server.name().to_string();
            let value = match server.transport().as_ref() {
                McpServerTransportRef::Stdio {
                    command,
                    arguments,
                    environment,
                } => json!({
                    "type": "stdio",
                    "name": name,
                    "command": command,
                    "args": arguments,
                    "env": environment
                        .iter()
                        .map(|(name, value)| json!({ "name": name, "value": value }))
                        .collect::<Vec<_>>(),
                }),
                McpServerTransportRef::Http { url, headers } => json!({
                    "type": "http",
                    "name": name,
                    "url": url,
                    "headers": headers
                        .iter()
                        .map(|(name, value)| json!({ "name": name, "value": value }))
                        .collect::<Vec<_>>(),
                }),
                McpServerTransportRef::Sse { url, headers } => json!({
                    "type": "sse",
                    "name": name,
                    "url": url,
                    "headers": headers
                        .iter()
                        .map(|(name, value)| json!({ "name": name, "value": value }))
                        .collect::<Vec<_>>(),
                }),
            };
            serde_json::from_value(value).map_err(|error| {
                phenix_acp::acp::util::internal_error(format!(
                    "failed to materialize configured MCP server: {error}"
                ))
            })
        })
        .collect()
}

pub(crate) fn validate_agent_capabilities(
    provision: &ToolProvision,
    capabilities: &McpCapabilities,
) -> Result<(), phenix_acp::acp::Error> {
    if !matches!(
        provision.configuration().builtin_tools(),
        BuiltinToolPolicy::BackendDefault
    ) {
        return Err(tool_error(
            "the routed ACP agent cannot enforce the configured built-in tool policy: ACP exposes no standard built-in tool policy capability",
        ));
    }
    if provision.requires_model_tool_host() && !capabilities.acp {
        return Err(tool_error(
            "the routed ACP agent cannot host conductor-provisioned tools: native MCP-over-ACP capability is required",
        ));
    }
    for server in provision.configuration().mcp_servers() {
        let supported = match server.transport().as_ref() {
            McpServerTransportRef::Stdio { .. } => true,
            McpServerTransportRef::Http { .. } => capabilities.http,
            McpServerTransportRef::Sse { .. } => capabilities.sse,
        };
        if !supported {
            return Err(tool_error(format!(
                "the routed ACP agent does not support the configured MCP transport for {}",
                server.name()
            )));
        }
    }
    Ok(())
}

struct ProvisionedToolsProxy {
    provision: ToolProvision,
}

impl ConnectTo<Conductor> for ProvisionedToolsProxy {
    async fn connect_to(
        self,
        conductor: impl ConnectTo<Proxy>,
    ) -> Result<(), phenix_acp::acp::Error> {
        let server = McpServer::<Conductor>::builder("phenix-conductor")
            .instructions(
                "Typed Phenix orchestration tools. Tree identity and caller authority are bound to this session by the conductor.",
            )
            .tool(DelegateTool(self.provision.clone()))
            .tool(WorkflowListTool(self.provision.clone()))
            .tool(WorkflowStartTool(self.provision))
            .build();
        Proxy
            .builder()
            .with_mcp_server(server)
            .connect_to(conductor)
            .await
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct DelegateInput {
    role: String,
    objective: String,
    prompt: String,
    #[serde(default)]
    difficulty: Option<String>,
}

struct DelegateTool(ToolProvision);

impl McpTool<Conductor> for DelegateTool {
    type Input = DelegateInput;
    type Output = Value;

    fn name(&self) -> String {
        "phenix_delegate".to_owned()
    }

    fn description(&self) -> String {
        "Delegate a bounded objective to a child Phenix agent and return its completed result. Session-tree identity and caller authority are bound by the conductor.".to_owned()
    }

    fn call_tool(
        &self,
        input: Self::Input,
        _context: McpConnectionTo<Conductor>,
    ) -> impl Future<Output = Result<Self::Output, phenix_acp::acp::Error>> + Send {
        let provision = self.0.clone();
        async move {
            let role = RoleId::parse(input.role).map_err(tool_error)?;
            let difficulty = input
                .difficulty
                .map(|difficulty| parse_difficulty(&difficulty))
                .transpose()?;
            provision
                .invoke(ToolInvocation::Delegate {
                    role,
                    objective: input.objective,
                    prompt: input.prompt,
                    difficulty,
                })
                .map_err(tool_error)
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct WorkflowListInput {}

struct WorkflowListTool(ToolProvision);

impl McpTool<Conductor> for WorkflowListTool {
    type Input = WorkflowListInput;
    type Output = Value;

    fn name(&self) -> String {
        "phenix_workflow_list".to_owned()
    }

    fn description(&self) -> String {
        "List workflows allowed by this immutable Phenix session-tree revision.".to_owned()
    }

    fn call_tool(
        &self,
        _input: Self::Input,
        _context: McpConnectionTo<Conductor>,
    ) -> impl Future<Output = Result<Self::Output, phenix_acp::acp::Error>> + Send {
        let provision = self.0.clone();
        async move {
            provision
                .invoke(ToolInvocation::WorkflowList)
                .map_err(tool_error)
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct WorkflowStartInput {
    workflow: String,
    objective: String,
    #[serde(default)]
    difficulty: Option<String>,
}

struct WorkflowStartTool(ToolProvision);

impl McpTool<Conductor> for WorkflowStartTool {
    type Input = WorkflowStartInput;
    type Output = Value;

    fn name(&self) -> String {
        "phenix_workflow_start".to_owned()
    }

    fn description(&self) -> String {
        "Start an allowed conductor-owned workflow in this Phenix session tree.".to_owned()
    }

    fn call_tool(
        &self,
        input: Self::Input,
        _context: McpConnectionTo<Conductor>,
    ) -> impl Future<Output = Result<Self::Output, phenix_acp::acp::Error>> + Send {
        let provision = self.0.clone();
        async move {
            let workflow = WorkflowId::parse(input.workflow).map_err(tool_error)?;
            let difficulty = input
                .difficulty
                .map(|difficulty| parse_difficulty(&difficulty))
                .transpose()?;
            provision
                .invoke(ToolInvocation::WorkflowStart {
                    workflow,
                    objective: input.objective,
                    difficulty,
                })
                .map_err(tool_error)
        }
    }
}

fn parse_difficulty(value: &str) -> Result<Difficulty, phenix_acp::acp::Error> {
    match value {
        "d0" => Ok(Difficulty::D0),
        "d1" => Ok(Difficulty::D1),
        "d2" => Ok(Difficulty::D2),
        "d3" => Ok(Difficulty::D3),
        "d4" => Ok(Difficulty::D4),
        _ => Err(tool_error(format!("unknown difficulty {value}"))),
    }
}

fn tool_error(error: impl std::fmt::Display) -> phenix_acp::acp::Error {
    phenix_acp::acp::util::internal_error(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_acp::{
        McpServerDefinition, McpServerName, McpServerTransport, ToolBinding, ToolConfiguration,
        ToolInvocationError, ToolInvoker,
    };
    use std::collections::BTreeMap;
    use std::sync::Arc;

    struct RejectInvoker;

    impl ToolInvoker for RejectInvoker {
        fn invoke(
            &self,
            _binding: &ToolBinding,
            _invocation: ToolInvocation,
        ) -> Result<Value, ToolInvocationError> {
            Err(ToolInvocationError::new("not called"))
        }
    }

    #[test]
    fn configured_stdio_mcp_servers_are_materialized_for_acp_session_setup() {
        let mut configuration = ToolConfiguration::new();
        configuration
            .insert_mcp_server(McpServerDefinition::new(
                McpServerName::parse("memory").expect("name"),
                McpServerTransport::stdio(
                    "memory-server",
                    vec!["--stdio".to_owned()],
                    BTreeMap::from([("MODE".to_owned(), "test".to_owned())]),
                )
                .expect("transport"),
            ))
            .expect("server");
        let provision = ToolProvision::new(
            configuration,
            Vec::new(),
            ToolBinding {
                revision: 7,
                tree_id: phenix_acp::SessionTreeId::parse("tree-1").expect("tree"),
                caller_node: phenix_acp::SessionNodeId::parse("node-1").expect("node"),
                caller_role: RoleId::parse("coordinator").expect("role"),
            },
            Arc::new(RejectInvoker),
        );

        let servers = external_mcp_servers(&provision).expect("materialize server");
        let value = serde_json::to_value(&servers[0]).expect("encode server");
        // ACP v1 keeps stdio as the backwards-compatible untagged variant.
        assert!(value.get("type").is_none());
        assert_eq!(value["name"], "memory");
        assert_eq!(value["command"], "memory-server");
        assert_eq!(value["args"], json!(["--stdio"]));
    }

    #[test]
    fn conductor_tools_require_native_mcp_over_acp_capability() {
        let provision = ToolProvision::new(
            ToolConfiguration::new(),
            phenix_acp::conductor_tool_catalog(),
            ToolBinding {
                revision: 7,
                tree_id: phenix_acp::SessionTreeId::parse("tree-1").expect("tree"),
                caller_node: phenix_acp::SessionNodeId::parse("node-1").expect("node"),
                caller_role: RoleId::parse("coordinator").expect("role"),
            },
            Arc::new(RejectInvoker),
        );

        let error = validate_agent_capabilities(&provision, &McpCapabilities::new())
            .expect_err("missing MCP-over-ACP capability must fail");
        assert!(error.to_string().contains("MCP-over-ACP"));
        validate_agent_capabilities(&provision, &McpCapabilities::new().acp(true))
            .expect("MCP-over-ACP capability");
    }
}
