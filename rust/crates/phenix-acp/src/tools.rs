use crate::{Difficulty, McpServerName, RoleId, SessionNodeId, SessionTreeId, ToolId, WorkflowId};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
enum McpServerTransportKind {
    Stdio {
        command: String,
        #[serde(default)]
        arguments: Vec<String>,
        #[serde(default)]
        environment: BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    Sse {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpServerTransport(McpServerTransportKind);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpServerTransportRef<'a> {
    Stdio {
        command: &'a str,
        arguments: &'a [String],
        environment: &'a BTreeMap<String, String>,
    },
    Http {
        url: &'a str,
        headers: &'a BTreeMap<String, String>,
    },
    Sse {
        url: &'a str,
        headers: &'a BTreeMap<String, String>,
    },
}

impl McpServerTransport {
    pub fn stdio(
        command: impl Into<String>,
        arguments: Vec<String>,
        environment: BTreeMap<String, String>,
    ) -> Result<Self, ToolConfigError> {
        let command = command.into();
        if command.is_empty() {
            return Err(ToolConfigError::EmptyStdioCommand);
        }
        Ok(Self(McpServerTransportKind::Stdio {
            command,
            arguments,
            environment,
        }))
    }

    pub fn http(
        url: impl Into<String>,
        headers: BTreeMap<String, String>,
    ) -> Result<Self, ToolConfigError> {
        Self::remote(url.into(), headers, false)
    }

    pub fn sse(
        url: impl Into<String>,
        headers: BTreeMap<String, String>,
    ) -> Result<Self, ToolConfigError> {
        Self::remote(url.into(), headers, true)
    }

    fn remote(
        url: String,
        headers: BTreeMap<String, String>,
        sse: bool,
    ) -> Result<Self, ToolConfigError> {
        if url.is_empty() {
            return Err(ToolConfigError::EmptyRemoteUrl);
        }
        let kind = if sse {
            McpServerTransportKind::Sse { url, headers }
        } else {
            McpServerTransportKind::Http { url, headers }
        };
        Ok(Self(kind))
    }

    pub fn as_ref(&self) -> McpServerTransportRef<'_> {
        match &self.0 {
            McpServerTransportKind::Stdio {
                command,
                arguments,
                environment,
            } => McpServerTransportRef::Stdio {
                command,
                arguments,
                environment,
            },
            McpServerTransportKind::Http { url, headers } => {
                McpServerTransportRef::Http { url, headers }
            }
            McpServerTransportKind::Sse { url, headers } => {
                McpServerTransportRef::Sse { url, headers }
            }
        }
    }
}

impl Serialize for McpServerTransport {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for McpServerTransport {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let kind = McpServerTransportKind::deserialize(deserializer)?;
        match kind {
            McpServerTransportKind::Stdio {
                command,
                arguments,
                environment,
            } => Self::stdio(command, arguments, environment),
            McpServerTransportKind::Http { url, headers } => Self::http(url, headers),
            McpServerTransportKind::Sse { url, headers } => Self::sse(url, headers),
        }
        .map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct McpServerDefinition {
    name: McpServerName,
    #[serde(flatten)]
    transport: McpServerTransport,
}

impl McpServerDefinition {
    pub fn new(name: McpServerName, transport: McpServerTransport) -> Self {
        Self { name, transport }
    }

    pub fn name(&self) -> &McpServerName {
        &self.name
    }

    pub fn transport(&self) -> &McpServerTransport {
        &self.transport
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "policy", content = "tools", rename_all = "snake_case")]
pub enum BuiltinToolPolicy {
    #[default]
    BackendDefault,
    DisableAll,
    AllowOnly(BTreeSet<ToolId>),
    Deny(BTreeSet<ToolId>),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
struct ToolConfigurationWire {
    #[serde(default)]
    mcp_servers: Vec<McpServerDefinition>,
    #[serde(default)]
    builtin_tools: BuiltinToolPolicy,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ToolConfiguration {
    mcp_servers: BTreeMap<McpServerName, McpServerDefinition>,
    builtin_tools: BuiltinToolPolicy,
}

impl ToolConfiguration {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_builtin_policy(mut self, policy: BuiltinToolPolicy) -> Self {
        self.builtin_tools = policy;
        self
    }

    pub fn insert_mcp_server(
        &mut self,
        server: McpServerDefinition,
    ) -> Result<(), ToolConfigError> {
        let name = server.name().clone();
        if self.mcp_servers.contains_key(&name) {
            return Err(ToolConfigError::DuplicateMcpServer(name));
        }
        self.mcp_servers.insert(name, server);
        Ok(())
    }

    pub fn mcp_servers(&self) -> impl ExactSizeIterator<Item = &McpServerDefinition> {
        self.mcp_servers.values()
    }

    pub fn builtin_tools(&self) -> &BuiltinToolPolicy {
        &self.builtin_tools
    }
}

/// A model-visible operation. These descriptors are semantic conductor tools,
/// not serialized `_phenix/*` frontend requests.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDescriptor {
    pub id: ToolId,
    pub description: String,
    pub input_schema: Value,
}

/// Authority bound by the conductor to one downstream session. None of these
/// identifiers are accepted from model-authored tool arguments.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolBinding {
    pub revision: u64,
    pub tree_id: SessionTreeId,
    pub caller_node: SessionNodeId,
    pub caller_role: RoleId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum ToolInvocation {
    Delegate {
        role: RoleId,
        objective: String,
        prompt: String,
        #[serde(default)]
        difficulty: Option<Difficulty>,
    },
    WorkflowList,
    WorkflowStart {
        workflow: WorkflowId,
        objective: String,
        #[serde(default)]
        difficulty: Option<Difficulty>,
    },
}

pub trait ToolInvoker: Send + Sync + 'static {
    fn invoke(
        &self,
        binding: &ToolBinding,
        invocation: ToolInvocation,
    ) -> Result<Value, ToolInvocationError>;
}

#[derive(Clone)]
pub struct ToolProvision {
    configuration: ToolConfiguration,
    descriptors: Arc<[ToolDescriptor]>,
    binding: ToolBinding,
    invoker: Arc<dyn ToolInvoker>,
}

impl ToolProvision {
    pub fn new(
        configuration: ToolConfiguration,
        descriptors: Vec<ToolDescriptor>,
        binding: ToolBinding,
        invoker: Arc<dyn ToolInvoker>,
    ) -> Self {
        Self {
            configuration,
            descriptors: descriptors.into(),
            binding,
            invoker,
        }
    }

    pub fn without_model_tools(configuration: ToolConfiguration, binding: ToolBinding) -> Self {
        Self::new(
            configuration,
            Vec::new(),
            binding,
            Arc::new(UnavailableToolInvoker),
        )
    }

    pub fn configuration(&self) -> &ToolConfiguration {
        &self.configuration
    }

    pub fn descriptors(&self) -> &[ToolDescriptor] {
        &self.descriptors
    }

    pub fn binding(&self) -> &ToolBinding {
        &self.binding
    }

    pub fn invoke(&self, invocation: ToolInvocation) -> Result<Value, ToolInvocationError> {
        self.invoker.invoke(&self.binding, invocation)
    }

    pub fn requires_model_tool_host(&self) -> bool {
        !self.descriptors.is_empty()
    }
}

struct UnavailableToolInvoker;

impl ToolInvoker for UnavailableToolInvoker {
    fn invoke(
        &self,
        _binding: &ToolBinding,
        _invocation: ToolInvocation,
    ) -> Result<Value, ToolInvocationError> {
        Err(ToolInvocationError::new(
            "this session has no conductor model-tool service",
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolInvocationError {
    message: String,
}

impl ToolInvocationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl Display for ToolInvocationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ToolInvocationError {}

pub fn conductor_tool_catalog() -> Vec<ToolDescriptor> {
    vec![
        ToolDescriptor {
            id: ToolId::parse("phenix_delegate").expect("static tool identifier"),
            description: "Delegate a bounded objective to a child Phenix agent and return its completed result. Session-tree identity and caller authority are bound by the conductor.".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "role": { "type": "string" },
                    "objective": { "type": "string" },
                    "prompt": { "type": "string" },
                    "difficulty": {
                        "type": "string",
                        "enum": ["d0", "d1", "d2", "d3", "d4"]
                    }
                },
                "required": ["role", "objective", "prompt"],
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            id: ToolId::parse("phenix_workflow_list").expect("static tool identifier"),
            description: "List workflows allowed by this immutable Phenix session-tree revision."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolDescriptor {
            id: ToolId::parse("phenix_workflow_start").expect("static tool identifier"),
            description: "Start an allowed conductor-owned workflow in this Phenix session tree."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "workflow": { "type": "string" },
                    "objective": { "type": "string" },
                    "difficulty": {
                        "type": "string",
                        "enum": ["d0", "d1", "d2", "d3", "d4"]
                    }
                },
                "required": ["workflow", "objective"],
                "additionalProperties": false
            }),
        },
    ]
}

impl Serialize for ToolConfiguration {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        ToolConfigurationWire {
            mcp_servers: self.mcp_servers.values().cloned().collect(),
            builtin_tools: self.builtin_tools.clone(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ToolConfiguration {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = ToolConfigurationWire::deserialize(deserializer)?;
        let mut configuration = Self::new().with_builtin_policy(wire.builtin_tools);
        for server in wire.mcp_servers {
            configuration
                .insert_mcp_server(server)
                .map_err(serde::de::Error::custom)?;
        }
        Ok(configuration)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolConfigError {
    DuplicateMcpServer(McpServerName),
    EmptyStdioCommand,
    EmptyRemoteUrl,
}

impl Display for ToolConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateMcpServer(name) => write!(formatter, "duplicate MCP server {name}"),
            Self::EmptyStdioCommand => formatter.write_str("MCP stdio command must not be empty"),
            Self::EmptyRemoteUrl => formatter.write_str("MCP remote URL must not be empty"),
        }
    }
}

impl Error for ToolConfigError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server(name: &str) -> McpServerDefinition {
        McpServerDefinition::new(
            McpServerName::parse(name).expect("server name"),
            McpServerTransport::stdio("server", Vec::new(), BTreeMap::new()).expect("transport"),
        )
    }

    #[test]
    fn mcp_server_names_are_unique_within_one_tree_configuration() {
        let mut tools = ToolConfiguration::new();
        tools
            .insert_mcp_server(server("memory"))
            .expect("first server");
        assert!(matches!(
            tools.insert_mcp_server(server("memory")),
            Err(ToolConfigError::DuplicateMcpServer(_))
        ));
    }

    #[test]
    fn wire_deserialization_cannot_create_an_empty_stdio_command() {
        let error = serde_json::from_value::<McpServerTransport>(json!({
            "transport": "stdio",
            "command": ""
        }))
        .expect_err("empty command must fail");
        assert!(error.to_string().contains("must not be empty"));
    }
}
