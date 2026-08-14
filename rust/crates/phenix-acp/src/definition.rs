use crate::{
    BackendId, DefinitionId, McpServerDefinition, RouterId, ToolConfigError, ToolConfiguration,
    WorkflowId,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "snake_case")]
enum AcpEndpointKind {
    Stdio {
        program: String,
        #[serde(default)]
        arguments: Vec<String>,
        #[serde(default)]
        environment: BTreeMap<String, String>,
    },
    Remote {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpEndpoint(AcpEndpointKind);

impl AcpEndpoint {
    pub fn stdio(
        program: impl Into<String>,
        arguments: Vec<String>,
        environment: BTreeMap<String, String>,
    ) -> Result<Self, DefinitionError> {
        let program = program.into();
        if program.is_empty() {
            return Err(DefinitionError::EmptyBackendProgram);
        }
        Ok(Self(AcpEndpointKind::Stdio {
            program,
            arguments,
            environment,
        }))
    }

    pub fn remote(
        url: impl Into<String>,
        headers: BTreeMap<String, String>,
    ) -> Result<Self, DefinitionError> {
        let url = url.into();
        if url.is_empty() {
            return Err(DefinitionError::EmptyBackendUrl);
        }
        Ok(Self(AcpEndpointKind::Remote { url, headers }))
    }
}

impl Serialize for AcpEndpoint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.0.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for AcpEndpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let endpoint = AcpEndpointKind::deserialize(deserializer)?;
        match endpoint {
            AcpEndpointKind::Stdio {
                program,
                arguments,
                environment,
            } => Self::stdio(program, arguments, environment),
            AcpEndpointKind::Remote { url, headers } => Self::remote(url, headers),
        }
        .map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendDefinition {
    id: BackendId,
    endpoint: AcpEndpoint,
}

impl BackendDefinition {
    pub fn new(id: BackendId, endpoint: AcpEndpoint) -> Self {
        Self { id, endpoint }
    }

    pub fn id(&self) -> &BackendId {
        &self.id
    }

    pub fn endpoint(&self) -> &AcpEndpoint {
        &self.endpoint
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SessionTreeDefinition {
    definition_id: DefinitionId,
    router: RouterId,
    workflows: BTreeSet<WorkflowId>,
    backends: Vec<BackendDefinition>,
    tools: ToolConfiguration,
}

impl SessionTreeDefinition {
    pub fn builder(definition_id: DefinitionId, router: RouterId) -> SessionTreeDefinitionBuilder {
        SessionTreeDefinitionBuilder {
            definition_id,
            router,
            workflows: BTreeSet::new(),
            backends: BTreeMap::new(),
            tools: ToolConfiguration::new(),
        }
    }

    pub fn definition_id(&self) -> &DefinitionId {
        &self.definition_id
    }

    pub fn router(&self) -> &RouterId {
        &self.router
    }

    pub fn workflows(&self) -> impl ExactSizeIterator<Item = &WorkflowId> {
        self.workflows.iter()
    }

    pub fn backends(&self) -> impl ExactSizeIterator<Item = &BackendDefinition> {
        self.backends.iter()
    }

    pub fn tools(&self) -> &ToolConfiguration {
        &self.tools
    }
}

#[derive(Deserialize)]
struct SessionTreeDefinitionWire {
    definition_id: DefinitionId,
    router: RouterId,
    #[serde(default)]
    workflows: Vec<WorkflowId>,
    backends: Vec<BackendDefinition>,
    #[serde(default)]
    tools: ToolConfiguration,
}

impl<'de> Deserialize<'de> for SessionTreeDefinition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = SessionTreeDefinitionWire::deserialize(deserializer)?;
        let mut builder = Self::builder(wire.definition_id, wire.router).tools(wire.tools);
        for workflow in wire.workflows {
            builder = builder
                .workflow(workflow)
                .map_err(serde::de::Error::custom)?;
        }
        for backend in wire.backends {
            builder = builder.backend(backend).map_err(serde::de::Error::custom)?;
        }
        builder.build().map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug)]
pub struct SessionTreeDefinitionBuilder {
    definition_id: DefinitionId,
    router: RouterId,
    workflows: BTreeSet<WorkflowId>,
    backends: BTreeMap<BackendId, BackendDefinition>,
    tools: ToolConfiguration,
}

impl SessionTreeDefinitionBuilder {
    pub fn workflow(mut self, workflow: WorkflowId) -> Result<Self, DefinitionError> {
        if !self.workflows.insert(workflow.clone()) {
            return Err(DefinitionError::DuplicateWorkflow(workflow));
        }
        Ok(self)
    }

    pub fn backend(mut self, backend: BackendDefinition) -> Result<Self, DefinitionError> {
        let id = backend.id().clone();
        if self.backends.contains_key(&id) {
            return Err(DefinitionError::DuplicateBackend(id));
        }
        self.backends.insert(id, backend);
        Ok(self)
    }

    pub fn tools(mut self, tools: ToolConfiguration) -> Self {
        self.tools = tools;
        self
    }

    pub fn mcp_server(mut self, server: McpServerDefinition) -> Result<Self, DefinitionError> {
        self.tools.insert_mcp_server(server)?;
        Ok(self)
    }

    pub fn build(self) -> Result<SessionTreeDefinition, DefinitionError> {
        if self.backends.is_empty() {
            return Err(DefinitionError::MissingBackend);
        }
        Ok(SessionTreeDefinition {
            definition_id: self.definition_id,
            router: self.router,
            workflows: self.workflows,
            backends: self.backends.into_values().collect(),
            tools: self.tools,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DefinitionError {
    MissingBackend,
    DuplicateBackend(BackendId),
    DuplicateWorkflow(WorkflowId),
    EmptyBackendProgram,
    EmptyBackendUrl,
    Tool(ToolConfigError),
}

impl From<ToolConfigError> for DefinitionError {
    fn from(error: ToolConfigError) -> Self {
        Self::Tool(error)
    }
}

impl Display for DefinitionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingBackend => {
                formatter.write_str("session tree requires at least one backend")
            }
            Self::DuplicateBackend(id) => write!(formatter, "duplicate backend {id}"),
            Self::DuplicateWorkflow(id) => write!(formatter, "duplicate workflow {id}"),
            Self::EmptyBackendProgram => {
                formatter.write_str("ACP stdio backend program must not be empty")
            }
            Self::EmptyBackendUrl => formatter.write_str("ACP backend URL must not be empty"),
            Self::Tool(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for DefinitionError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn builder() -> SessionTreeDefinitionBuilder {
        SessionTreeDefinition::builder(
            DefinitionId::parse("standard").expect("definition ID"),
            RouterId::parse("capability-budget").expect("router ID"),
        )
    }

    fn backend() -> BackendDefinition {
        BackendDefinition::new(
            BackendId::parse("backend").expect("backend ID"),
            AcpEndpoint::stdio("example-acp-agent", Vec::new(), BTreeMap::new()).expect("endpoint"),
        )
    }

    #[test]
    fn definition_requires_a_backend_before_it_can_be_frozen() {
        assert_eq!(builder().build(), Err(DefinitionError::MissingBackend));
    }

    #[test]
    fn duplicate_workflows_and_backends_are_rejected_during_construction() {
        let workflow = WorkflowId::parse("implement").expect("workflow ID");
        let workflow_builder = builder().workflow(workflow.clone()).expect("workflow");
        assert!(matches!(
            workflow_builder.workflow(workflow),
            Err(DefinitionError::DuplicateWorkflow(_))
        ));

        let backend_builder = builder().backend(backend()).expect("backend");
        assert!(matches!(
            backend_builder.backend(backend()),
            Err(DefinitionError::DuplicateBackend(_))
        ));
    }

    #[test]
    fn deserialization_cannot_bypass_definition_validation() {
        let error = serde_json::from_value::<SessionTreeDefinition>(json!({
            "definition_id": "standard",
            "router": "router",
            "backends": []
        }))
        .expect_err("wire definition without backend must fail");
        assert!(error.to_string().contains("at least one backend"));
    }

    #[test]
    fn wire_deserialization_cannot_create_an_empty_backend_program() {
        let error = serde_json::from_value::<AcpEndpoint>(json!({
            "transport": "stdio",
            "program": ""
        }))
        .expect_err("empty program must fail");
        assert!(error.to_string().contains("must not be empty"));
    }
}
