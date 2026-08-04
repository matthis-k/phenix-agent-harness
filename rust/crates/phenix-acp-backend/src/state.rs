use agent_client_protocol::schema::v1::{
    AgentCapabilities, AvailableCommand, InitializeResponse, SessionConfigKind,
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOptions, SessionId as AcpSessionId,
    SessionModeState, ToolCall,
};
use phenix_runtime_api::{
    AuthMethod as FrontendAuthMethod, AuthProviderSummary, BackendCapabilities, BackendHealth,
    ModelRef, ModelSummary, PersistedSessionSummary, PromptCapabilities, RunId, RunKind, RunOutcome,
    RunState, RunSummary, RuntimeSnapshot, SessionCapabilities, SessionId, ThinkingLevel,
};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub(crate) struct PendingPrompt {
    pub text: String,
    pub images: Vec<phenix_runtime_api::ImageInput>,
}

#[derive(Clone, Debug)]
pub(crate) struct SessionState {
    pub acp_id: AcpSessionId,
    pub summary: PersistedSessionSummary,
    pub run: RunSummary,
    pub cwd: PathBuf,
    pub modes: Option<SessionModeState>,
    pub config_options: Vec<SessionConfigOption>,
    pub commands: Vec<AvailableCommand>,
    pub prompt_active: bool,
    pub follow_ups: VecDeque<PendingPrompt>,
    pub tools: HashMap<String, ToolCall>,
}

impl SessionState {
    pub fn current_model(&self) -> Option<ModelRef> {
        self.config_options
            .iter()
            .find(|option| matches!(option.category, Some(SessionConfigOptionCategory::Model)))
            .and_then(|option| match &option.kind {
                SessionConfigKind::Select(select) => Some(model_ref(select.current_value.to_string())),
                SessionConfigKind::Boolean(_) => None,
                _ => None,
            })
    }

    pub fn current_thinking_level(&self) -> Option<ThinkingLevel> {
        self.config_options
            .iter()
            .find(|option| {
                matches!(
                    option.category,
                    Some(SessionConfigOptionCategory::ThoughtLevel)
                )
            })
            .and_then(|option| match &option.kind {
                SessionConfigKind::Select(select) => {
                    thinking_level_from_value(select.current_value.to_string().as_str())
                }
                SessionConfigKind::Boolean(boolean) => {
                    Some(if boolean.current_value {
                        ThinkingLevel::Medium
                    } else {
                        ThinkingLevel::Off
                    })
                }
                _ => None,
            })
    }

    pub fn models(&self, supports_images: bool) -> Vec<ModelSummary> {
        let supports_thinking = self.config_options.iter().any(|option| {
            matches!(
                option.category,
                Some(SessionConfigOptionCategory::ThoughtLevel)
            )
        });
        self.config_options
            .iter()
            .filter(|option| matches!(option.category, Some(SessionConfigOptionCategory::Model)))
            .flat_map(|option| match &option.kind {
                SessionConfigKind::Select(select) => flatten_options(&select.options),
                SessionConfigKind::Boolean(_) => Vec::new(),
                _ => Vec::new(),
            })
            .map(|option| ModelSummary {
                model: model_ref(option.value.to_string()),
                display_name: option.name.clone(),
                supports_images,
                supports_thinking,
            })
            .collect()
    }

    pub fn thinking_levels(&self) -> Vec<ThinkingLevel> {
        self.config_options
            .iter()
            .filter(|option| {
                matches!(
                    option.category,
                    Some(SessionConfigOptionCategory::ThoughtLevel)
                )
            })
            .flat_map(|option| match &option.kind {
                SessionConfigKind::Select(select) => flatten_options(&select.options)
                    .into_iter()
                    .filter_map(|option| thinking_level_from_value(option.value.to_string().as_str()))
                    .collect(),
                SessionConfigKind::Boolean(_) => vec![ThinkingLevel::Off, ThinkingLevel::Medium],
                _ => Vec::new(),
            })
            .collect()
    }
}

#[derive(Debug)]
pub(crate) struct AdapterState {
    pub initialize: InitializeResponse,
    pub capabilities: BackendCapabilities,
    pub sessions: BTreeMap<SessionId, SessionState>,
    pub active_session: Option<SessionId>,
    next_run: u64,
}

impl AdapterState {
    pub fn new(initialize: InitializeResponse) -> Self {
        let capabilities = project_capabilities(&initialize);
        Self {
            initialize,
            capabilities,
            sessions: BTreeMap::new(),
            active_session: None,
            next_run: 1,
        }
    }

    pub fn auth_providers(&self) -> Vec<AuthProviderSummary> {
        self.initialize
            .auth_methods
            .iter()
            .map(|method| match method {
                agent_client_protocol::schema::v1::AuthMethod::Agent(method) => {
                    AuthProviderSummary {
                        id: method.id.to_string(),
                        display_name: method.name.clone(),
                        methods: vec![FrontendAuthMethod::OAuth],
                        configured: false,
                        source: method.description.clone(),
                    }
                }
                #[cfg(feature = "unstable_auth_methods")]
                agent_client_protocol::schema::v1::AuthMethod::Terminal(method) => {
                    AuthProviderSummary {
                        id: method.id.to_string(),
                        display_name: method.name.clone(),
                        methods: vec![FrontendAuthMethod::ApiKey],
                        configured: false,
                        source: method.description.clone(),
                    }
                }
                _ => AuthProviderSummary {
                    id: "unsupported-auth-method".to_owned(),
                    display_name: "Unsupported ACP authentication method".to_owned(),
                    methods: Vec::new(),
                    configured: false,
                    source: None,
                },
            })
            .collect()
    }

    pub fn insert_session(
        &mut self,
        acp_id: AcpSessionId,
        cwd: PathBuf,
        parent_session: Option<&SessionId>,
        modes: Option<SessionModeState>,
        config_options: Option<Vec<SessionConfigOption>>,
        name: Option<String>,
        updated_at: Option<String>,
    ) -> Result<SessionId, phenix_runtime_api::BackendError> {
        let session_id = SessionId::parse(acp_id.to_string())
            .map_err(|error| phenix_runtime_api::BackendError::Protocol(error.to_string()))?;
        let parent_run = parent_session
            .and_then(|parent| self.sessions.get(parent))
            .map(|session| session.run.id.clone());
        let run_id = RunId::parse(format!("acp-run-{}", self.next_run))
            .map_err(|error| phenix_runtime_api::BackendError::Protocol(error.to_string()))?;
        self.next_run = self
            .next_run
            .checked_add(1)
            .ok_or_else(|| {
                phenix_runtime_api::BackendError::Protocol("ACP run IDs exhausted".to_owned())
            })?;
        let summary = PersistedSessionSummary {
            id: session_id.clone(),
            name: name.or_else(|| Some(format!("ACP session {session_id}"))),
            session_file: None,
            cwd: Some(cwd.to_string_lossy().into_owned()),
            root_run_id: Some(run_id.clone()),
            updated_at,
        };
        let mut run = RunSummary {
            id: run_id,
            parent: parent_run,
            kind: if parent_session.is_some() {
                RunKind::Agent
            } else {
                RunKind::Root
            },
            definition_id: "acp.session".to_owned(),
            display_name: summary
                .name
                .clone()
                .unwrap_or_else(|| "ACP session".to_owned()),
            state: RunState::Created,
            persisted_session: Some(session_id.clone()),
            session_file: None,
            model: None,
            thinking_level: None,
            difficulty: None,
            budget: None,
            pending_messages: 0,
            outcome: None,
        };
        let session = SessionState {
            acp_id,
            summary,
            run: run.clone(),
            cwd,
            modes,
            config_options: config_options.unwrap_or_default(),
            commands: Vec::new(),
            prompt_active: false,
            follow_ups: VecDeque::new(),
            tools: HashMap::new(),
        };
        run.model = session.current_model();
        run.thinking_level = session.current_thinking_level();
        let mut session = session;
        session.run = run;
        self.sessions.insert(session_id.clone(), session);
        self.active_session = Some(session_id.clone());
        Ok(session_id)
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        let root_run = self
            .active_session
            .as_ref()
            .and_then(|session_id| self.sessions.get(session_id))
            .map(|session| root_of(&self.sessions, &session.run.id));
        RuntimeSnapshot {
            capabilities: self.capabilities.clone(),
            health: BackendHealth::Ready,
            active_session: self.active_session.clone(),
            root_run,
            selected_run: self
                .active_session
                .as_ref()
                .and_then(|id| self.sessions.get(id))
                .map(|session| session.run.id.clone()),
            sessions: self
                .sessions
                .values()
                .map(|session| session.summary.clone())
                .collect(),
            runs: self
                .sessions
                .values()
                .map(|session| session.run.clone())
                .collect(),
            objectives: Vec::new(),
        }
    }

    pub fn active_session_mut(
        &mut self,
    ) -> Result<&mut SessionState, phenix_runtime_api::BackendError> {
        let active = self.active_session.clone().ok_or_else(|| {
            phenix_runtime_api::BackendError::InvalidConfiguration(
                "no ACP session is active".to_owned(),
            )
        })?;
        self.sessions.get_mut(&active).ok_or_else(|| {
            phenix_runtime_api::BackendError::Protocol(format!(
                "active ACP session {active} is missing"
            ))
        })
    }

    pub fn session_for_run_mut(
        &mut self,
        run_id: &RunId,
    ) -> Result<&mut SessionState, phenix_runtime_api::BackendError> {
        self.sessions
            .values_mut()
            .find(|session| &session.run.id == run_id)
            .ok_or_else(|| {
                phenix_runtime_api::BackendError::InvalidConfiguration(format!(
                    "run {run_id} is not backed by an ACP session"
                ))
            })
    }

    pub fn session_for_run(
        &self,
        run_id: &RunId,
    ) -> Result<&SessionState, phenix_runtime_api::BackendError> {
        self.sessions
            .values()
            .find(|session| &session.run.id == run_id)
            .ok_or_else(|| {
                phenix_runtime_api::BackendError::InvalidConfiguration(format!(
                    "run {run_id} is not backed by an ACP session"
                ))
            })
    }
}

fn project_capabilities(initialize: &InitializeResponse) -> BackendCapabilities {
    let agent = &initialize.agent_capabilities;
    BackendCapabilities {
        prompting: PromptCapabilities {
            steering: true,
            follow_ups: true,
            images: agent.prompt_capabilities.image,
            compaction: true,
            retry_control: false,
        },
        sessions: SessionCapabilities {
            persistence: agent.load_session
                || agent.session_capabilities.resume.is_some()
                || agent.session_capabilities.list.is_some(),
            switching: agent.load_session || agent.session_capabilities.resume.is_some(),
            branching: session_fork_supported(agent),
            import: agent.load_session,
            export: false,
            tree: true,
        },
        authentication: phenix_runtime_api::AuthenticationCapabilities {
            provider_listing: !initialize.auth_methods.is_empty(),
            oauth: !initialize.auth_methods.is_empty(),
            api_keys: initialize.auth_methods.iter().any(|method| {
                matches!(
                    method,
                    #[cfg(feature = "unstable_auth_methods")]
                    agent_client_protocol::schema::v1::AuthMethod::Terminal(_)
                )
            }),
            device_code: false,
            browser_callback: false,
            logout: agent.auth.logout.is_some(),
        },
        models: phenix_runtime_api::ModelCapabilities {
            listing: true,
            selection: true,
            thinking_levels: true,
            virtual_models: false,
        },
        resources: phenix_runtime_api::ResourceCapabilities {
            commands: true,
            extensions: false,
            skills: false,
            prompt_templates: false,
            reload: false,
        },
        extension_ui: phenix_runtime_api::ExtensionUiCapabilities {
            selection: true,
            confirmation: true,
            text_input: true,
            secret_input: false,
            editor: false,
            notifications: true,
            status: true,
        },
    }
}

fn session_fork_supported(capabilities: &AgentCapabilities) -> bool {
    #[cfg(feature = "unstable_session_fork")]
    {
        capabilities.session_capabilities.fork.is_some()
    }
    #[cfg(not(feature = "unstable_session_fork"))]
    {
        let _ = capabilities;
        false
    }
}

fn root_of(sessions: &BTreeMap<SessionId, SessionState>, run_id: &RunId) -> RunId {
    let mut current = run_id.clone();
    loop {
        let parent = sessions
            .values()
            .find(|session| session.run.id == current)
            .and_then(|session| session.run.parent.clone());
        match parent {
            Some(parent) => current = parent,
            None => return current,
        }
    }
}

fn model_ref(value: String) -> ModelRef {
    let (provider, model) = value
        .split_once('/')
        .map_or_else(|| ("acp".to_owned(), value), |(provider, model)| {
            (provider.to_owned(), model.to_owned())
        });
    ModelRef { provider, model }
}

fn flatten_options(
    options: &SessionConfigSelectOptions,
) -> Vec<&agent_client_protocol::schema::v1::SessionConfigSelectOption> {
    match options {
        SessionConfigSelectOptions::Ungrouped(options) => options.iter().collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| group.options.iter())
            .collect(),
        _ => Vec::new(),
    }
}

pub(crate) fn thinking_level_from_value(value: &str) -> Option<ThinkingLevel> {
    match value.to_ascii_lowercase().as_str() {
        "off" | "none" | "disabled" => Some(ThinkingLevel::Off),
        "minimal" | "min" => Some(ThinkingLevel::Minimal),
        "low" => Some(ThinkingLevel::Low),
        "medium" | "normal" => Some(ThinkingLevel::Medium),
        "high" => Some(ThinkingLevel::High),
        "extra_high" | "extra-high" | "xhigh" => Some(ThinkingLevel::ExtraHigh),
        "max" | "maximum" => Some(ThinkingLevel::Max),
        _ => None,
    }
}

pub(crate) fn thinking_level_value(level: &ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::ExtraHigh => "extra_high",
        ThinkingLevel::Max => "max",
    }
}
