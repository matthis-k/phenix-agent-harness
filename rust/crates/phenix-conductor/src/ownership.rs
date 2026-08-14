use agent_client_protocol::schema::v1::{ExtRequest, ExtResponse};
use phenix_acp::{
    decode_extension_response, encode_extension_request, AcpMethod, ConfigurationDefinitionInput,
    ConfigurationGet, ConfigurationGetResult, ConfigurationLoad, ConfigurationLoadParams,
    ConfigurationLoadResult, ConfigurationSnapshot, ConfigurationSourceError, Difficulty,
    GatewayEvent, RoleId, SessionCommand, SessionNodeId, SessionTreeClose, SessionTreeCreate,
    SessionTreeCreateParams, SessionTreeId, SessionTreeList, SessionTreeListResult,
    SessionTreeSnapshot, ToolBinding, ToolInvoker, WorkflowId, WorkflowStartResult,
};
use phenix_conductor::{
    BootstrapBackend, BootstrapDefinition, BootstrapStandardSession, ConductorBootstrap,
    ConductorRuntime, StandardSession,
};
use serde::Serialize;
use serde_json::value::to_raw_value;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// ACP-process owner for user-supplied immutable configuration revisions.
///
/// Loading configuration creates a new revision and makes it active for future
/// trees. Existing trees remain bound to the revision under which they were
/// created; neither their routing nor workflow registry mutates in place.
pub struct ConductorOwner {
    cwd: PathBuf,
    channel_capacity: usize,
    revisions: BTreeMap<u64, RuntimeRevision>,
    active_revision: Option<u64>,
    tree_revisions: BTreeMap<SessionTreeId, u64>,
    next_revision: u64,
    next_tree: u64,
    tool_invoker: Option<Arc<dyn ToolInvoker>>,
}

struct RuntimeRevision {
    runtime: ConductorRuntime,
    configuration: ConfigurationSnapshot,
}

impl ConductorOwner {
    pub fn new(cwd: PathBuf, channel_capacity: usize) -> Result<Self, ConductorOwnerError> {
        if channel_capacity == 0 {
            return Err(ConductorOwnerError::InvalidChannelCapacity);
        }
        Ok(Self {
            cwd,
            channel_capacity,
            revisions: BTreeMap::new(),
            active_revision: None,
            tree_revisions: BTreeMap::new(),
            next_revision: 1,
            next_tree: 1,
            tool_invoker: None,
        })
    }

    pub fn with_tool_invoker(mut self, invoker: Arc<dyn ToolInvoker>) -> Self {
        self.tool_invoker = Some(invoker);
        self
    }

    pub fn handle_configuration_extension(
        &mut self,
        request: &ExtRequest,
    ) -> Result<Option<ExtResponse>, ConductorOwnerError> {
        match request.method.as_ref() {
            ConfigurationLoad::METHOD => self.load(request).map(Some),
            ConfigurationGet::METHOD => self.get().map(Some),
            _ => Ok(None),
        }
    }

    pub fn handle_auth_extension(
        &mut self,
        request: &ExtRequest,
    ) -> Result<Option<ExtResponse>, ConductorOwnerError> {
        let Some(tree_id) = request_tree_id(request)? else {
            return Ok(None);
        };
        self.runtime_for_tree_mut(&tree_id)?
            .handle_auth_extension(request)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn handle_extension(
        &mut self,
        request: ExtRequest,
    ) -> Result<ExtResponse, ConductorOwnerError> {
        match request.method.as_ref() {
            SessionTreeCreate::METHOD => self.create_tree_extension(request),
            SessionTreeList::METHOD => {
                let _: phenix_acp::SessionTreeListParams =
                    serde_json::from_str(request.params.get())
                        .map_err(ConductorOwnerError::DecodeRequest)?;
                encode_response(&self.list_trees())
            }
            _ => {
                let tree_id = request_tree_id(&request)?.ok_or_else(|| {
                    ConductorOwnerError::MissingTreeTarget(request.method.to_string())
                })?;
                let close = request.method.as_ref() == SessionTreeClose::METHOD;
                let response = self
                    .runtime_for_tree_mut(&tree_id)?
                    .handle_extension(request)
                    .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))?;
                if close {
                    self.tree_revisions.remove(&tree_id);
                }
                Ok(response)
            }
        }
    }

    pub fn create_standard_session(&mut self) -> Result<StandardSession, ConductorOwnerError> {
        let tree_id = self.allocate_tree_id()?;
        let revision = self.active_revision()?;
        let session = self
            .revision_mut(revision)?
            .runtime
            .create_standard_session_with_id(tree_id.clone())
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))?;
        self.tree_revisions.insert(tree_id, revision);
        Ok(session)
    }

    pub fn standard_session_config_options(
        &self,
        session_id: &str,
    ) -> Result<serde_json::Value, ConductorOwnerError> {
        let tree_id = parse_tree_id(session_id)?;
        self.runtime_for_tree(&tree_id)?
            .standard_session_config_options(session_id)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn set_standard_session_config_option(
        &mut self,
        session_id: &str,
        config_id: &str,
        value: &serde_json::Value,
    ) -> Result<serde_json::Value, ConductorOwnerError> {
        let tree_id = parse_tree_id(session_id)?;
        self.runtime_for_tree_mut(&tree_id)?
            .set_standard_session_config_option(session_id, config_id, value)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn execute_standard_session(
        &mut self,
        session_id: &str,
        command: SessionCommand,
    ) -> Result<Vec<GatewayEvent>, ConductorOwnerError> {
        let tree_id = parse_tree_id(session_id)?;
        self.runtime_for_tree_mut(&tree_id)?
            .execute_standard_session(session_id, command)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn cancel_standard_session(
        &mut self,
        session_id: &str,
    ) -> Result<Vec<GatewayEvent>, ConductorOwnerError> {
        let tree_id = parse_tree_id(session_id)?;
        self.runtime_for_tree_mut(&tree_id)?
            .cancel_standard_session(session_id)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn take_standard_session_cancelled(
        &mut self,
        session_id: &str,
    ) -> Result<bool, ConductorOwnerError> {
        let tree_id = parse_tree_id(session_id)?;
        Ok(self
            .runtime_for_tree_mut(&tree_id)?
            .take_standard_session_cancelled(session_id))
    }

    pub fn close_standard_session(&mut self, session_id: &str) -> Result<(), ConductorOwnerError> {
        let tree_id = parse_tree_id(session_id)?;
        self.runtime_for_tree_mut(&tree_id)?
            .close_standard_session(session_id)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))?;
        self.tree_revisions.remove(&tree_id);
        Ok(())
    }

    pub fn snapshot_tree(
        &self,
        tree_id: &SessionTreeId,
    ) -> Result<SessionTreeSnapshot, ConductorOwnerError> {
        self.runtime_for_tree(tree_id)?
            .conductor()
            .gateway()
            .snapshot(tree_id)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn poll_node(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
    ) -> Result<Vec<GatewayEvent>, ConductorOwnerError> {
        self.runtime_for_tree_mut(tree_id)?
            .conductor_mut()
            .gateway_mut()
            .execute(tree_id, node_id, SessionCommand::Poll)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn delegate_from_tool(
        &mut self,
        binding: &ToolBinding,
        role: RoleId,
        difficulty: Option<Difficulty>,
        objective: String,
    ) -> Result<SessionNodeId, ConductorOwnerError> {
        self.validate_tool_binding(binding)?;
        self.runtime_for_tree_mut(&binding.tree_id)?
            .conductor_mut()
            .gateway_mut()
            .delegate(
                &binding.tree_id,
                &binding.caller_node,
                role,
                difficulty,
                objective,
            )
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn execute_node(
        &mut self,
        tree_id: &SessionTreeId,
        node_id: &SessionNodeId,
        command: SessionCommand,
    ) -> Result<Vec<GatewayEvent>, ConductorOwnerError> {
        self.runtime_for_tree_mut(tree_id)?
            .conductor_mut()
            .gateway_mut()
            .execute(tree_id, node_id, command)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn workflows_from_tool(
        &self,
        binding: &ToolBinding,
    ) -> Result<Vec<phenix_acp::WorkflowSummary>, ConductorOwnerError> {
        self.validate_tool_binding(binding)?;
        Ok(self
            .runtime_for_tree(&binding.tree_id)?
            .workflows()
            .to_vec())
    }

    pub fn start_workflow_from_tool(
        &mut self,
        binding: &ToolBinding,
        workflow: &WorkflowId,
        difficulty: Option<Difficulty>,
        objective: String,
    ) -> Result<WorkflowStartResult, ConductorOwnerError> {
        self.validate_tool_binding(binding)?;
        self.runtime_for_tree_mut(&binding.tree_id)?
            .conductor_mut()
            .gateway_mut()
            .start_workflow(&binding.tree_id, workflow, difficulty, objective)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn list_trees(&self) -> SessionTreeListResult {
        let mut trees = self
            .revisions
            .values()
            .flat_map(|revision| revision.runtime.conductor().gateway().list_trees().trees)
            .collect::<Vec<_>>();
        trees.sort_by(|left, right| left.tree_id.cmp(&right.tree_id));
        SessionTreeListResult { trees }
    }

    fn validate_tool_binding(&self, binding: &ToolBinding) -> Result<(), ConductorOwnerError> {
        let revision = self
            .tree_revisions
            .get(&binding.tree_id)
            .copied()
            .ok_or_else(|| ConductorOwnerError::UnknownTree(binding.tree_id.clone()))?;
        if revision != binding.revision {
            return Err(ConductorOwnerError::StaleToolBinding {
                tree: binding.tree_id.clone(),
                expected_revision: revision,
                actual_revision: binding.revision,
            });
        }
        let snapshot = self.snapshot_tree(&binding.tree_id)?;
        if snapshot.root != binding.caller_node {
            return Err(ConductorOwnerError::ToolCallerDenied(
                binding.caller_node.clone(),
            ));
        }
        let caller = snapshot
            .nodes
            .iter()
            .find(|node| node.id == binding.caller_node)
            .ok_or_else(|| ConductorOwnerError::ToolCallerDenied(binding.caller_node.clone()))?;
        if caller.role != binding.caller_role
            || !matches!(caller.state, phenix_acp::SessionNodeState::Running)
        {
            return Err(ConductorOwnerError::ToolCallerDenied(
                binding.caller_node.clone(),
            ));
        }
        Ok(())
    }

    fn create_tree_extension(
        &mut self,
        request: ExtRequest,
    ) -> Result<ExtResponse, ConductorOwnerError> {
        let mut params: SessionTreeCreateParams = serde_json::from_str(request.params.get())
            .map_err(ConductorOwnerError::DecodeRequest)?;
        let tree_id = match params.tree_id.take() {
            Some(tree_id) => {
                if self.tree_revisions.contains_key(&tree_id) {
                    return Err(ConductorOwnerError::DuplicateTree(tree_id));
                }
                tree_id
            }
            None => self.allocate_tree_id()?,
        };
        params.tree_id = Some(tree_id.clone());
        let routed = encode_extension_request::<SessionTreeCreate>(&params)
            .map_err(|error| ConductorOwnerError::EncodeRequest(error.to_string()))?;
        let revision = self.active_revision()?;
        let response = self
            .revision_mut(revision)?
            .runtime
            .handle_extension(routed)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))?;
        let created = decode_extension_response::<SessionTreeCreate>(response.clone())
            .map_err(|error| ConductorOwnerError::DecodeResponse(error.to_string()))?;
        if created.tree_id != tree_id {
            return Err(ConductorOwnerError::Runtime(format!(
                "configured runtime created tree {} instead of requested tree {tree_id}",
                created.tree_id
            )));
        }
        self.tree_revisions.insert(tree_id, revision);
        Ok(response)
    }

    fn load(&mut self, request: &ExtRequest) -> Result<ExtResponse, ConductorOwnerError> {
        let params: ConfigurationLoadParams = serde_json::from_str(request.params.get())
            .map_err(ConductorOwnerError::DecodeConfiguration)?;
        let result = self.load_params(params)?;
        encode_response(&result)
    }

    fn load_params(
        &mut self,
        params: ConfigurationLoadParams,
    ) -> Result<ConfigurationLoadResult, ConductorOwnerError> {
        let revision = self.next_revision;
        let source_root = resolve_source_root(&self.cwd, &params.source_root);
        let (bootstrap, snapshot) = build_bootstrap(params, &source_root, revision)?;

        // Construct the complete revision before publishing it. A failed parse,
        // validation, backend construction, or transport setup leaves active state
        // unchanged.
        let runtime = match &self.tool_invoker {
            Some(invoker) => bootstrap.build_with_tool_service(
                &self.cwd,
                self.channel_capacity,
                revision,
                Arc::clone(invoker),
            ),
            None => bootstrap.build(&self.cwd, self.channel_capacity),
        }
        .map_err(|error| ConductorOwnerError::Build(error.to_string()))?;
        let mut snapshot = snapshot;
        snapshot.workflows = runtime.workflows().to_vec();
        let result = ConfigurationLoadResult {
            revision,
            definition_id: snapshot.definition_id.clone(),
            router: snapshot.router.clone(),
        };
        self.revisions.insert(
            revision,
            RuntimeRevision {
                runtime,
                configuration: snapshot,
            },
        );
        self.active_revision = Some(revision);
        self.next_revision = revision
            .checked_add(1)
            .ok_or(ConductorOwnerError::IdentifierExhausted)?;
        Ok(result)
    }

    fn get(&self) -> Result<ExtResponse, ConductorOwnerError> {
        let active = self
            .active_revision
            .and_then(|revision| self.revisions.get(&revision))
            .map(|revision| revision.configuration.clone());
        encode_response(&ConfigurationGetResult { active })
    }

    fn active_revision(&self) -> Result<u64, ConductorOwnerError> {
        self.active_revision
            .ok_or(ConductorOwnerError::NotConfigured)
    }

    fn revision_mut(&mut self, revision: u64) -> Result<&mut RuntimeRevision, ConductorOwnerError> {
        self.revisions
            .get_mut(&revision)
            .ok_or(ConductorOwnerError::UnknownRevision(revision))
    }

    fn runtime_for_tree(
        &self,
        tree_id: &SessionTreeId,
    ) -> Result<&ConductorRuntime, ConductorOwnerError> {
        let revision = self
            .tree_revisions
            .get(tree_id)
            .copied()
            .ok_or_else(|| ConductorOwnerError::UnknownTree(tree_id.clone()))?;
        self.revisions
            .get(&revision)
            .map(|revision| &revision.runtime)
            .ok_or(ConductorOwnerError::UnknownRevision(revision))
    }

    fn runtime_for_tree_mut(
        &mut self,
        tree_id: &SessionTreeId,
    ) -> Result<&mut ConductorRuntime, ConductorOwnerError> {
        let revision = self
            .tree_revisions
            .get(tree_id)
            .copied()
            .ok_or_else(|| ConductorOwnerError::UnknownTree(tree_id.clone()))?;
        self.revision_mut(revision)
            .map(|revision| &mut revision.runtime)
    }

    fn allocate_tree_id(&mut self) -> Result<SessionTreeId, ConductorOwnerError> {
        loop {
            let sequence = self.next_tree;
            self.next_tree = sequence
                .checked_add(1)
                .ok_or(ConductorOwnerError::IdentifierExhausted)?;
            let tree_id = SessionTreeId::parse(format!("tree-{sequence}"))
                .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))?;
            if !self.tree_revisions.contains_key(&tree_id) {
                return Ok(tree_id);
            }
        }
    }
}

fn request_tree_id(request: &ExtRequest) -> Result<Option<SessionTreeId>, ConductorOwnerError> {
    let value: serde_json::Value =
        serde_json::from_str(request.params.get()).map_err(ConductorOwnerError::DecodeRequest)?;
    let Some(tree_id) = value.get("tree_id") else {
        return Ok(None);
    };
    let tree_id = tree_id.as_str().ok_or_else(|| {
        ConductorOwnerError::InvalidTreeTarget("tree_id must be a string".to_owned())
    })?;
    SessionTreeId::parse(tree_id.to_owned())
        .map(Some)
        .map_err(|error| ConductorOwnerError::InvalidTreeTarget(error.to_string()))
}

fn parse_tree_id(session_id: &str) -> Result<SessionTreeId, ConductorOwnerError> {
    SessionTreeId::parse(session_id.to_owned())
        .map_err(|error| ConductorOwnerError::InvalidTreeTarget(error.to_string()))
}

fn resolve_source_root(cwd: &Path, configured: &Path) -> PathBuf {
    if configured.is_absolute() {
        configured.to_path_buf()
    } else {
        cwd.join(configured)
    }
}

fn build_bootstrap(
    params: ConfigurationLoadParams,
    source_root: &Path,
    revision: u64,
) -> Result<(ConductorBootstrap, ConfigurationSnapshot), ConductorOwnerError> {
    let input = params.input;
    if input.backends.is_empty() {
        return Err(ConductorOwnerError::MissingBackends);
    }
    if input.definitions.is_empty() {
        return Err(ConductorOwnerError::MissingDefinitions);
    }

    let backend_ids = input
        .backends
        .iter()
        .map(|backend| backend.id.clone())
        .collect::<Vec<_>>();
    let unique_backends = backend_ids.iter().collect::<BTreeSet<_>>();
    if unique_backends.len() != backend_ids.len() {
        return Err(ConductorOwnerError::DuplicateBackend);
    }
    let backends = input
        .backends
        .into_iter()
        .map(|backend| {
            Ok(BootstrapBackend {
                id: backend.id,
                command: command_with_environment(backend.command, backend.environment)?,
                environment: BTreeMap::new(),
            })
        })
        .collect::<Result<Vec<_>, ConductorOwnerError>>()?;

    let mut workflow_count = 0usize;
    let mut routing_table_count = 0usize;
    let mut definitions = Vec::with_capacity(input.definitions.len());
    for definition in input.definitions {
        let definition = match definition {
            ConfigurationDefinitionInput::Workflow { source } => {
                workflow_count += 1;
                let loaded = source
                    .load(source_root)
                    .map_err(ConductorOwnerError::Source)?;
                BootstrapDefinition::Workflow {
                    source: loaded.source,
                    format: loaded.format,
                }
            }
            ConfigurationDefinitionInput::RoutingTable { source } => {
                routing_table_count += 1;
                let loaded = source
                    .load(source_root)
                    .map_err(ConductorOwnerError::Source)?;
                BootstrapDefinition::RoutingTable {
                    source: loaded.source,
                    format: loaded.format,
                }
            }
        };
        definitions.push(definition);
    }

    let standard_session = input
        .standard_session
        .map(|template| BootstrapStandardSession {
            role: template.role,
            difficulty: template.difficulty,
            objective: template.objective,
        });
    let mcp_server_count = input.tools.mcp_servers().len();
    let snapshot = ConfigurationSnapshot {
        revision,
        definition_id: input.definition_id.clone(),
        router: input.router.clone(),
        backend_ids,
        workflows: Vec::new(),
        workflow_count,
        routing_table_count,
        has_standard_session_template: standard_session.is_some(),
        mcp_server_count,
    };
    let bootstrap = ConductorBootstrap {
        definition_id: input.definition_id,
        router: input.router,
        standard_session,
        backends,
        definitions,
        tools: input.tools,
    };
    Ok((bootstrap, snapshot))
}

fn command_with_environment(
    command: String,
    environment: BTreeMap<String, String>,
) -> Result<String, ConductorOwnerError> {
    if environment.is_empty() {
        return Ok(command);
    }
    let mut words = Vec::with_capacity(environment.len() + 2);
    words.push("env".to_owned());
    for (name, value) in environment {
        if name.is_empty() || name.contains('=') || name.contains('\0') {
            return Err(ConductorOwnerError::InvalidEnvironmentName(name));
        }
        if value.contains('\0') {
            return Err(ConductorOwnerError::InvalidEnvironmentValue(name));
        }
        words.push(shell_quote(&format!("{name}={value}")));
    }
    words.push(command);
    Ok(words.join(" "))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn encode_response<T: Serialize>(value: &T) -> Result<ExtResponse, ConductorOwnerError> {
    let raw = to_raw_value(value).map_err(ConductorOwnerError::EncodeConfiguration)?;
    Ok(ExtResponse::new(Arc::from(raw)))
}

#[derive(Debug)]
pub enum ConductorOwnerError {
    InvalidChannelCapacity,
    NotConfigured,
    UnknownRevision(u64),
    UnknownTree(SessionTreeId),
    DuplicateTree(SessionTreeId),
    StaleToolBinding {
        tree: SessionTreeId,
        expected_revision: u64,
        actual_revision: u64,
    },
    ToolCallerDenied(SessionNodeId),
    MissingTreeTarget(String),
    InvalidTreeTarget(String),
    IdentifierExhausted,
    MissingBackends,
    MissingDefinitions,
    DuplicateBackend,
    InvalidEnvironmentName(String),
    InvalidEnvironmentValue(String),
    DecodeConfiguration(serde_json::Error),
    EncodeConfiguration(serde_json::Error),
    DecodeRequest(serde_json::Error),
    EncodeRequest(String),
    DecodeResponse(String),
    Source(ConfigurationSourceError),
    Build(String),
    Runtime(String),
}

impl Display for ConductorOwnerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidChannelCapacity => {
                formatter.write_str("ACP downstream channel capacity must be greater than zero")
            }
            Self::NotConfigured => formatter.write_str(
                "Phenix ACP has no active user configuration; submit _phenix/config/load first",
            ),
            Self::UnknownRevision(revision) => {
                write!(
                    formatter,
                    "unknown Phenix ACP configuration revision {revision}"
                )
            }
            Self::UnknownTree(tree) => write!(formatter, "unknown Phenix session tree {tree}"),
            Self::DuplicateTree(tree) => write!(formatter, "duplicate Phenix session tree {tree}"),
            Self::StaleToolBinding {
                tree,
                expected_revision,
                actual_revision,
            } => write!(
                formatter,
                "tool binding for tree {tree} targets revision {actual_revision}, but the tree is bound to revision {expected_revision}"
            ),
            Self::ToolCallerDenied(node) => {
                write!(formatter, "session node {node} is not authorized to invoke conductor tools")
            }
            Self::MissingTreeTarget(method) => {
                write!(formatter, "Phenix ACP method {method} requires tree_id")
            }
            Self::InvalidTreeTarget(message) => write!(formatter, "invalid tree target: {message}"),
            Self::IdentifierExhausted => {
                formatter.write_str("Phenix owner identifiers are exhausted")
            }
            Self::MissingBackends => {
                formatter.write_str("Phenix ACP configuration requires at least one backend")
            }
            Self::MissingDefinitions => formatter
                .write_str("Phenix ACP configuration requires at least one definition source"),
            Self::DuplicateBackend => {
                formatter.write_str("Phenix ACP configuration contains a duplicate backend ID")
            }
            Self::InvalidEnvironmentName(name) => {
                write!(
                    formatter,
                    "invalid backend environment variable name {name:?}"
                )
            }
            Self::InvalidEnvironmentValue(name) => write!(
                formatter,
                "backend environment variable {name:?} contains a NUL byte"
            ),
            Self::DecodeConfiguration(error) => {
                write!(
                    formatter,
                    "invalid Phenix ACP configuration request: {error}"
                )
            }
            Self::EncodeConfiguration(error) => {
                write!(
                    formatter,
                    "failed to encode Phenix ACP configuration response: {error}"
                )
            }
            Self::DecodeRequest(error) => write!(formatter, "invalid Phenix ACP request: {error}"),
            Self::EncodeRequest(error) => {
                write!(formatter, "failed to encode Phenix ACP request: {error}")
            }
            Self::DecodeResponse(error) => {
                write!(formatter, "failed to decode Phenix ACP response: {error}")
            }
            Self::Source(error) => Display::fmt(error, formatter),
            Self::Build(error) => {
                write!(
                    formatter,
                    "failed to construct Phenix ACP configuration: {error}"
                )
            }
            Self::Runtime(error) => formatter.write_str(error),
        }
    }
}

impl Error for ConductorOwnerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::DecodeConfiguration(error)
            | Self::EncodeConfiguration(error)
            | Self::DecodeRequest(error) => Some(error),
            Self::Source(error) => Some(error),
            Self::InvalidChannelCapacity
            | Self::NotConfigured
            | Self::UnknownRevision(_)
            | Self::UnknownTree(_)
            | Self::DuplicateTree(_)
            | Self::StaleToolBinding { .. }
            | Self::ToolCallerDenied(_)
            | Self::MissingTreeTarget(_)
            | Self::InvalidTreeTarget(_)
            | Self::IdentifierExhausted
            | Self::MissingBackends
            | Self::MissingDefinitions
            | Self::DuplicateBackend
            | Self::InvalidEnvironmentName(_)
            | Self::InvalidEnvironmentValue(_)
            | Self::EncodeRequest(_)
            | Self::DecodeResponse(_)
            | Self::Build(_)
            | Self::Runtime(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_acp::{
        BackendId, ConfigurationBackendInput, ConfigurationInput,
        ConfigurationStandardSessionInput, Difficulty, RoleId, RouterId, ToolConfiguration,
    };

    #[test]
    fn owner_starts_as_an_unconfigured_framework() {
        let mut owner = ConductorOwner::new(PathBuf::from("."), 8).expect("owner");
        assert!(matches!(
            owner.create_standard_session(),
            Err(ConductorOwnerError::NotConfigured)
        ));
    }

    #[test]
    fn configuration_does_not_contain_a_concrete_tree_identity() {
        let input = ConfigurationInput {
            definition_id: phenix_acp::DefinitionId::parse("default").expect("definition"),
            router: RouterId::parse("default").expect("router"),
            backends: vec![ConfigurationBackendInput {
                id: BackendId::parse("backend").expect("backend"),
                command: "example-acp-agent --stdio".to_owned(),
                environment: BTreeMap::new(),
            }],
            definitions: Vec::new(),
            tools: ToolConfiguration::new(),
            standard_session: Some(ConfigurationStandardSessionInput {
                role: RoleId::parse("root").expect("role"),
                difficulty: Difficulty::D2,
                objective: "Help the user".to_owned(),
            }),
        };
        let encoded = serde_json::to_value(input).expect("configuration JSON");
        assert!(encoded.get("root").is_none());
        assert!(encoded.to_string().find("tree_id").is_none());
    }

    #[test]
    fn backend_environment_is_assembled_inside_the_conductor() {
        let command = command_with_environment(
            "mock-agent --acp".to_owned(),
            BTreeMap::from([(
                "PHENIX_MOCK_ACP_CONFIG".to_owned(),
                "value with spaces and 'quotes'".to_owned(),
            )]),
        )
        .expect("environment command");
        let words = shell_words::split(&command).expect("shell words");
        assert_eq!(words[0], "env");
        assert_eq!(
            words[1],
            "PHENIX_MOCK_ACP_CONFIG=value with spaces and 'quotes'"
        );
        assert_eq!(&words[2..], &["mock-agent", "--acp"]);
    }
}
