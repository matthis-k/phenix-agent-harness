use crate::{McpServerName, ToolId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
pub enum McpServerTransport {
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct McpServerDefinition {
    name: McpServerName,
    #[serde(flatten)]
    transport: McpServerTransport,
}

impl McpServerDefinition {
    pub fn new(name: McpServerName, transport: McpServerTransport) -> Result<Self, ToolConfigError> {
        validate_transport(&transport)?;
        Ok(Self { name, transport })
    }

    pub fn name(&self) -> &McpServerName {
        &self.name
    }

    pub fn transport(&self) -> &McpServerTransport {
        &self.transport
    }
}

fn validate_transport(transport: &McpServerTransport) -> Result<(), ToolConfigError> {
    match transport {
        McpServerTransport::Stdio { command, .. } if command.is_empty() => {
            Err(ToolConfigError::EmptyStdioCommand)
        }
        McpServerTransport::Http { url, .. } | McpServerTransport::Sse { url, .. }
            if url.is_empty() =>
        {
            Err(ToolConfigError::EmptyRemoteUrl)
        }
        _ => Ok(()),
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

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
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

    fn server(name: &str) -> McpServerDefinition {
        McpServerDefinition::new(
            McpServerName::parse(name).expect("server name"),
            McpServerTransport::Stdio {
                command: "server".to_owned(),
                arguments: Vec::new(),
                environment: BTreeMap::new(),
            },
        )
        .expect("server definition")
    }

    #[test]
    fn MCP_server_names_are_unique_within_one_tree_configuration() {
        let mut tools = ToolConfiguration::new();
        tools.insert_mcp_server(server("memory")).expect("first server");
        assert!(matches!(
            tools.insert_mcp_server(server("memory")),
            Err(ToolConfigError::DuplicateMcpServer(_))
        ));
    }
}
