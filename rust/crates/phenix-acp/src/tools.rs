use crate::{McpServerName, ToolId};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

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
