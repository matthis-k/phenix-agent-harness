from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:120]!r}")
    if text.count(old) != 1:
        raise SystemExit(f"non-unique patch anchor in {path}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


CONTEXT_RS = r'''use phenix_core::{SkillDescriptor, SkillId, SkillInvocationPolicy};
use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
enum ContextDocumentKind {
    AgentInstructions,
    ProjectInstructions,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ContextDocument {
    kind: ContextDocumentKind,
    path: PathBuf,
    scope_root: PathBuf,
    content: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SkillDefinition {
    descriptor: SkillDescriptor,
    instructions: String,
    root: PathBuf,
    resources: Vec<PathBuf>,
    allowed_tools: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ContextRegistry {
    base_documents: Vec<ContextDocument>,
    skills: BTreeMap<SkillId, SkillDefinition>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContextError {
    Io { path: PathBuf, message: String },
    InvalidSkill { path: PathBuf, message: String },
    UnknownSkill(SkillId),
}

impl Display for ContextError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, message } => {
                write!(f, "context I/O failed for {}: {message}", path.display())
            }
            Self::InvalidSkill { path, message } => {
                write!(f, "invalid skill {}: {message}", path.display())
            }
            Self::UnknownSkill(id) => write!(f, "unknown skill: {id}"),
        }
    }
}

impl Error for ContextError {}

impl ContextRegistry {
    pub fn discover(cwd: impl AsRef<Path>) -> Result<Self, ContextError> {
        let cwd = cwd.as_ref();
        let project_root = project_root(cwd);
        let mut registry = Self::default();
        registry.base_documents = discover_base_documents(&project_root, cwd)?;

        // Lowest to highest precedence. Project-local sources override user sources,
        // portable roots override compatibility roots, and Phenix-native roots win.
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            for root in [
                home.join(".cursor/skills"),
                home.join(".claude/skills"),
                home.join(".codex/skills"),
                home.join(".agents/skills"),
                home.join(".config/phenix/skills"),
            ] {
                registry.discover_skill_root(&root)?;
            }
        }
        for root in [
            project_root.join(".cursor/skills"),
            project_root.join(".claude/skills"),
            project_root.join(".codex/skills"),
            project_root.join(".agents/skills"),
            project_root.join(".phenix/skills"),
        ] {
            registry.discover_skill_root(&root)?;
        }
        if let Some(extra) = env::var_os("PHENIX_SKILL_PATH") {
            for root in env::split_paths(&extra) {
                registry.discover_skill_root(&root)?;
            }
        }
        Ok(registry)
    }

    pub fn skill_descriptors(&self) -> Vec<SkillDescriptor> {
        self.skills
            .values()
            .map(|skill| skill.descriptor.clone())
            .collect()
    }

    pub fn has_model_invocable_skills(&self) -> bool {
        self.skills.values().any(|skill| {
            skill.descriptor.invocation == SkillInvocationPolicy::ModelEligible
        })
    }

    pub fn compose_prompt(&self, input: &str) -> Result<String, ContextError> {
        let (user_prompt, explicit_skill) = self.resolve_manual_activation(input)?;
        let model_skills = self
            .skills
            .values()
            .filter(|skill| skill.descriptor.invocation == SkillInvocationPolicy::ModelEligible)
            .collect::<Vec<_>>();
        let active_skill = explicit_skill
            .as_ref()
            .and_then(|id| self.skills.get(id));

        if self.base_documents.is_empty() && model_skills.is_empty() && active_skill.is_none() {
            return Ok(user_prompt.to_owned());
        }

        let mut output = String::from("<phenix_context>\n");
        if !self.base_documents.is_empty() {
            output.push_str("<base_context>\n");
            for document in &self.base_documents {
                let kind = match document.kind {
                    ContextDocumentKind::AgentInstructions => "agent_instructions",
                    ContextDocumentKind::ProjectInstructions => "project_instructions",
                };
                output.push_str(&format!(
                    "<document kind=\"{kind}\" path=\"{}\" scope=\"{}\">\n{}\n</document>\n",
                    document.path.display(),
                    document.scope_root.display(),
                    document.content.trim()
                ));
            }
            output.push_str("</base_context>\n");
        }
        if !model_skills.is_empty() {
            output.push_str("<available_skills>\n");
            output.push_str("These skills are discoverable for this turn. Load a matching skill with phenix_skill_load before following it. Do not guess skill contents.\n");
            for skill in model_skills {
                output.push_str(&format!(
                    "- {}: {}\n",
                    skill.descriptor.id, skill.descriptor.description
                ));
            }
            output.push_str("</available_skills>\n");
        }
        if let Some(skill) = active_skill {
            output.push_str(&render_skill(skill));
        }
        output.push_str("</phenix_context>\n\n<user_request>\n");
        output.push_str(user_prompt.trim_start());
        output.push_str("\n</user_request>");
        Ok(output)
    }

    pub fn skill_payload(&self, id: &SkillId) -> Result<String, ContextError> {
        self.skills
            .get(id)
            .map(render_skill)
            .ok_or_else(|| ContextError::UnknownSkill(id.clone()))
    }

    fn resolve_manual_activation<'a>(
        &self,
        input: &'a str,
    ) -> Result<(&'a str, Option<SkillId>), ContextError> {
        let trimmed = input.trim_start();
        if let Some(rest) = trimmed.strip_prefix("/skill ") {
            let mut parts = rest.splitn(2, char::is_whitespace);
            let name = parts.next().unwrap_or_default().trim();
            let id = SkillId::parse(name.to_owned()).map_err(|_| ContextError::InvalidSkill {
                path: PathBuf::from("<manual>"),
                message: "manual skill name must not be empty".to_owned(),
            })?;
            if !self.skills.contains_key(&id) {
                return Err(ContextError::UnknownSkill(id));
            }
            return Ok((parts.next().unwrap_or_default().trim_start(), Some(id)));
        }
        if let Some(command) = trimmed.strip_prefix('/') {
            let mut parts = command.splitn(2, char::is_whitespace);
            let name = parts.next().unwrap_or_default();
            if let Ok(id) = SkillId::parse(name.to_owned()) {
                if self.skills.contains_key(&id) {
                    return Ok((parts.next().unwrap_or_default().trim_start(), Some(id)));
                }
            }
        }
        Ok((input, None))
    }

    fn discover_skill_root(&mut self, root: &Path) -> Result<(), ContextError> {
        if !root.is_dir() {
            return Ok(());
        }
        let mut entries = fs::read_dir(root)
            .map_err(|error| io_error(root, error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| io_error(root, error))?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            if !skill_file.is_file() {
                continue;
            }
            let skill = parse_skill(&skill_file, &path)?;
            self.skills.insert(skill.descriptor.id.clone(), skill);
        }
        Ok(())
    }
}

fn project_root(cwd: &Path) -> PathBuf {
    cwd.ancestors()
        .find(|candidate| candidate.join(".git").exists())
        .unwrap_or(cwd)
        .to_path_buf()
}

fn discover_base_documents(
    project_root: &Path,
    cwd: &Path,
) -> Result<Vec<ContextDocument>, ContextError> {
    let mut documents = Vec::new();
    load_agent_document(project_root, &mut documents)?;
    for name in ["CONTRIBUTING.md", "DEVELOPMENT.md"] {
        let path = project_root.join(name);
        if path.is_file() {
            documents.push(read_context_document(
                &path,
                project_root,
                ContextDocumentKind::ProjectInstructions,
            )?);
        }
    }

    if let Ok(relative) = cwd.strip_prefix(project_root) {
        let mut scope = project_root.to_path_buf();
        for component in relative.components() {
            scope.push(component.as_os_str());
            if scope != project_root {
                load_agent_document(&scope, &mut documents)?;
            }
        }
    }
    Ok(documents)
}

fn load_agent_document(
    scope: &Path,
    documents: &mut Vec<ContextDocument>,
) -> Result<(), ContextError> {
    let override_path = scope.join("AGENTS.override.md");
    let normal_path = scope.join("AGENTS.md");
    let path = if override_path.is_file() {
        Some(override_path)
    } else if normal_path.is_file() {
        Some(normal_path)
    } else {
        None
    };
    if let Some(path) = path {
        documents.push(read_context_document(
            &path,
            scope,
            ContextDocumentKind::AgentInstructions,
        )?);
    }
    Ok(())
}

fn read_context_document(
    path: &Path,
    scope_root: &Path,
    kind: ContextDocumentKind,
) -> Result<ContextDocument, ContextError> {
    let content = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    Ok(ContextDocument {
        kind,
        path: path.to_path_buf(),
        scope_root: scope_root.to_path_buf(),
        content,
    })
}

fn parse_skill(path: &Path, root: &Path) -> Result<SkillDefinition, ContextError> {
    let source = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    let normalized = source.replace("\r\n", "\n");
    let rest = normalized
        .strip_prefix("---\n")
        .ok_or_else(|| invalid_skill(path, "SKILL.md must start with YAML frontmatter"))?;
    let end = rest
        .find("\n---\n")
        .ok_or_else(|| invalid_skill(path, "SKILL.md frontmatter must end with ---"))?;
    let frontmatter = &rest[..end];
    let instructions = rest[end + 5..].trim().to_owned();

    let mut fields = BTreeMap::<String, String>::new();
    for raw_line in frontmatter.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('-') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        fields.insert(key.trim().to_owned(), unquote(value.trim()).to_owned());
    }

    let name = fields
        .remove("name")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid_skill(path, "frontmatter requires non-empty name"))?;
    let description = fields
        .remove("description")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid_skill(path, "frontmatter requires non-empty description"))?;
    let directory_name = root.file_name().and_then(|value| value.to_str()).unwrap_or_default();
    if directory_name != name {
        return Err(invalid_skill(
            path,
            format!("skill name {name:?} must match directory {directory_name:?}"),
        ));
    }
    let id = SkillId::parse(name.clone())
        .map_err(|_| invalid_skill(path, "skill name must not be empty"))?;
    let manual_only = fields
        .remove("disable-model-invocation")
        .is_some_and(|value| matches!(value.as_str(), "true" | "True" | "TRUE" | "yes" | "1"));
    let allowed_tools = fields
        .remove("allowed-tools")
        .map(|value| parse_inline_list(&value))
        .unwrap_or_default();
    let resources = collect_resources(root)?;

    Ok(SkillDefinition {
        descriptor: SkillDescriptor {
            id,
            name,
            description,
            invocation: if manual_only {
                SkillInvocationPolicy::ManualOnly
            } else {
                SkillInvocationPolicy::ModelEligible
            },
        },
        instructions,
        root: root.to_path_buf(),
        resources,
        allowed_tools,
    })
}

fn parse_inline_list(value: &str) -> Vec<String> {
    let value = value.trim().trim_start_matches('[').trim_end_matches(']');
    value
        .split(',')
        .flat_map(|part| {
            if value.contains(',') {
                vec![part]
            } else {
                part.split_whitespace().collect::<Vec<_>>()
            }
        })
        .map(|part| unquote(part.trim()).to_owned())
        .filter(|part| !part.is_empty())
        .collect()
}

fn collect_resources(root: &Path) -> Result<Vec<PathBuf>, ContextError> {
    let mut resources = Vec::new();
    for directory in ["scripts", "references", "assets"] {
        let path = root.join(directory);
        if path.is_dir() {
            collect_files(root, &path, &mut resources)?;
        }
    }
    resources.sort();
    Ok(resources)
}

fn collect_files(root: &Path, directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), ContextError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| io_error(directory, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| io_error(directory, error))?;
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, output)?;
        } else if path.is_file() {
            output.push(path.strip_prefix(root).unwrap_or(&path).to_path_buf());
        }
    }
    Ok(())
}

fn render_skill(skill: &SkillDefinition) -> String {
    let mut output = format!(
        "<active_skill id=\"{}\" root=\"{}\">\n{}\n",
        skill.descriptor.id,
        skill.root.display(),
        skill.instructions.trim()
    );
    if !skill.resources.is_empty() {
        output.push_str("\nResources relative to the skill root:\n");
        for resource in &skill.resources {
            output.push_str(&format!("- {}\n", resource.display()));
        }
    }
    if !skill.allowed_tools.is_empty() {
        output.push_str("\nSkill-declared allowed-tools (advisory only; conductor permissions remain authoritative):\n");
        for tool in &skill.allowed_tools {
            output.push_str(&format!("- {tool}\n"));
        }
    }
    output.push_str("</active_skill>\n");
    output
}

fn unquote(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn parse_io_message(error: std::io::Error) -> String {
    error.to_string()
}

fn io_error(path: &Path, error: std::io::Error) -> ContextError {
    ContextError::Io {
        path: path.to_path_buf(),
        message: parse_io_message(error),
    }
}

fn invalid_skill(path: &Path, message: impl Into<String>) -> ContextError {
    ContextError::InvalidSkill {
        path: path.to_path_buf(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("phenix-context-{nonce}"))
    }

    fn write(path: impl AsRef<Path>, content: &str) {
        let path = path.as_ref();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn discovers_scoped_context_and_agent_skill_conventions() {
        let root = fixture_root();
        fs::create_dir_all(root.join(".git")).unwrap();
        let nested = root.join("crates/conductor");
        fs::create_dir_all(&nested).unwrap();
        write(root.join("AGENTS.md"), "root agent rules");
        write(root.join("CONTRIBUTING.md"), "contribution rules");
        write(root.join("crates/AGENTS.override.md"), "crate override rules");
        write(
            root.join(".cursor/skills/unslop/SKILL.md"),
            "---\nname: unslop\ndescription: Cut AI tells from writing. Must always apply.\n---\n# Unslop\nRemove generic AI patterns.",
        );
        write(
            root.join(".agents/skills/tdd/SKILL.md"),
            "---\nname: tdd\ndescription: Use when explicitly requested.\ndisable-model-invocation: true\n---\n# TDD\nWrite a failing regression first.",
        );

        let registry = ContextRegistry::discover(&nested).unwrap();
        let catalog = registry.skill_descriptors();
        assert_eq!(catalog.len(), 2);
        assert_eq!(
            catalog
                .iter()
                .find(|skill| skill.id.as_str() == "unslop")
                .unwrap()
                .invocation,
            SkillInvocationPolicy::ModelEligible
        );
        assert_eq!(
            catalog
                .iter()
                .find(|skill| skill.id.as_str() == "tdd")
                .unwrap()
                .invocation,
            SkillInvocationPolicy::ManualOnly
        );

        let automatic = registry.compose_prompt("Rewrite this text").unwrap();
        assert!(automatic.contains("root agent rules"));
        assert!(automatic.contains("contribution rules"));
        assert!(automatic.contains("crate override rules"));
        assert!(automatic.contains("unslop: Cut AI tells"));
        assert!(!automatic.contains("Write a failing regression first"));
        assert!(!automatic.contains("tdd: Use when explicitly requested"));

        let manual = registry.compose_prompt("/tdd fix the bug").unwrap();
        assert!(manual.contains("Write a failing regression first"));
        assert!(manual.contains("<user_request>\nfix the bug"));

        let payload = registry
            .skill_payload(&SkillId::parse("unslop").unwrap())
            .unwrap();
        assert!(payload.contains("Remove generic AI patterns"));
        assert!(payload.contains("root=\""));

        fs::remove_dir_all(root).unwrap();
    }
}
'''

Path("rust/crates/phenix-conductor/src/context.rs").write_text(CONTEXT_RS)

# phenix-core: normalized skill catalog types.
replace_once(
    "rust/crates/phenix-core/src/lib.rs",
    "id_type!(AuthenticationMethodId);\n",
    """id_type!(AuthenticationMethodId);\nid_type!(SkillId);\n\n#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]\n#[serde(rename_all = \"snake_case\")]\npub enum SkillInvocationPolicy {\n    ModelEligible,\n    ManualOnly,\n}\n\n#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]\npub struct SkillDescriptor {\n    pub id: SkillId,\n    pub name: String,\n    pub description: String,\n    pub invocation: SkillInvocationPolicy,\n}\n""",
)

# phenix-conductor library: own the immutable context registry and compose every model invocation.
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "mod callables;\n",
    "mod callables;\nmod context;\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "pub use callables::{CallableRegistry, CallableRegistryError};\n",
    "pub use callables::{CallableRegistry, CallableRegistryError};\npub use context::{ContextError, ContextRegistry};\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "    SessionSummary, ToolCallId,\n};\n",
    "    SessionSummary, SkillDescriptor, SkillId, ToolCallId,\n};\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "    Routing(RoutingRegistryError),\n    Backend(BackendError),\n",
    "    Routing(RoutingRegistryError),\n    Context(ContextError),\n    Backend(BackendError),\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "            Self::Routing(error) => Display::fmt(error, f),\n            Self::Backend(error) => Display::fmt(error, f),\n",
    "            Self::Routing(error) => Display::fmt(error, f),\n            Self::Context(error) => Display::fmt(error, f),\n            Self::Backend(error) => Display::fmt(error, f),\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "impl From<RoutingRegistryError> for ConductorError {\n    fn from(value: RoutingRegistryError) -> Self {\n        Self::Routing(value)\n    }\n}\n",
    """impl From<RoutingRegistryError> for ConductorError {\n    fn from(value: RoutingRegistryError) -> Self {\n        Self::Routing(value)\n    }\n}\n\nimpl From<ContextError> for ConductorError {\n    fn from(value: ContextError) -> Self {\n        Self::Context(value)\n    }\n}\n""",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "    routing: RoutingRegistry,\n    policy: InvocationPolicy,\n",
    "    routing: RoutingRegistry,\n    context: ContextRegistry,\n    policy: InvocationPolicy,\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "            routing: RoutingRegistry::default(),\n            policy: InvocationPolicy::new(),\n",
    "            routing: RoutingRegistry::default(),\n            context: ContextRegistry::default(),\n            policy: InvocationPolicy::new(),\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "    pub fn register_routing_profile(\n        &mut self,\n        profile: RoutingProfile,\n    ) -> Result<(), ConductorError> {\n        self.routing.register(profile)?;\n        Ok(())\n    }\n\n    #[must_use]\n    pub fn callable_descriptors",
    """    pub fn register_routing_profile(\n        &mut self,\n        profile: RoutingProfile,\n    ) -> Result<(), ConductorError> {\n        self.routing.register(profile)?;\n        Ok(())\n    }\n\n    pub fn install_context_registry(&mut self, context: ContextRegistry) {\n        self.context = context;\n    }\n\n    #[must_use]\n    pub fn skill_descriptors(&self) -> Vec<SkillDescriptor> {\n        self.context.skill_descriptors()\n    }\n\n    #[must_use]\n    pub fn has_model_invocable_skills(&self) -> bool {\n        self.context.has_model_invocable_skills()\n    }\n\n    pub fn load_skill(&self, id: &SkillId) -> Result<String, ConductorError> {\n        Ok(self.context.skill_payload(id)?)\n    }\n\n    #[must_use]\n    pub fn callable_descriptors""",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "        Ok(ResolvedInvocation {\n            execution_id: execution_id.clone(),\n",
    "        let prompt = self.context.compose_prompt(&input)?;\n\n        Ok(ResolvedInvocation {\n            execution_id: execution_id.clone(),\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/lib.rs",
    "            prompt: input,\n            tools: ToolProvision {\n",
    "            prompt,\n            tools: ToolProvision {\n",
)

# Semantic model tools: progressive skill disclosure.
replace_once(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "    ExecutionEventKind, ExecutionKind, ExecutionSummary,\n};\n",
    "    ExecutionEventKind, ExecutionKind, ExecutionSummary, SkillId,\n};\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "pub(super) const ORCHESTRATION_START_ID: &str = \"phenix_orchestration_start\";\n",
    "pub(super) const ORCHESTRATION_START_ID: &str = \"phenix_orchestration_start\";\npub(super) const SKILL_LOAD_ID: &str = \"phenix_skill_load\";\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "struct OrchestrationStartInput {\n    orchestration: String,\n    objective: String,\n}\n",
    """struct OrchestrationStartInput {\n    orchestration: String,\n    objective: String,\n}\n\n#[derive(Debug, Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct SkillLoadInput {\n    skill: String,\n}\n""",
)
replace_once(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "    if is_root && has_orchestrations {\n        resolved.tools.callables.extend(descriptors());\n    }\n}\n\npub(super) fn is_semantic_tool(id: &CallableId) -> bool {\n    matches!(id.as_str(), ORCHESTRATION_LIST_ID | ORCHESTRATION_START_ID)\n}\n",
    """    if is_root && has_orchestrations {\n        resolved.tools.callables.extend(orchestration_descriptors());\n    }\n    if runtime.has_model_invocable_skills() {\n        resolved.tools.callables.push(skill_load_descriptor());\n    }\n}\n\npub(super) fn is_semantic_tool(id: &CallableId) -> bool {\n    matches!(\n        id.as_str(),\n        ORCHESTRATION_LIST_ID | ORCHESTRATION_START_ID | SKILL_LOAD_ID\n    )\n}\n""",
)
replace_once(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "        ORCHESTRATION_START_ID => match parse_start(&invocation.arguments_json) {\n",
    """        SKILL_LOAD_ID => match parse_skill_load(&invocation.arguments_json) {\n            Ok(skill) => match runtime.load_skill(&skill) {\n                Ok(output) => ToolResult {\n                    output,\n                    success: true,\n                },\n                Err(error) => ToolResult {\n                    output: error.to_string(),\n                    success: false,\n                },\n            },\n            Err(error) => ToolResult {\n                output: error,\n                success: false,\n            },\n        },\n        ORCHESTRATION_START_ID => match parse_start(&invocation.arguments_json) {\n""",
)
replace_once(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "fn descriptors() -> Vec<CallableDescriptor> {\n",
    "fn orchestration_descriptors() -> Vec<CallableDescriptor> {\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "fn list_output(orchestrations: Vec<CallableDescriptor>) -> String {\n",
    """fn parse_skill_load(arguments_json: &str) -> Result<SkillId, String> {\n    let input: SkillLoadInput = serde_json::from_str(arguments_json)\n        .map_err(|error| format!(\"invalid skill load arguments: {error}\"))?;\n    SkillId::parse(input.skill).map_err(|error| format!(\"invalid skill id: {error}\"))\n}\n\nfn list_output(orchestrations: Vec<CallableDescriptor>) -> String {\n""",
)
replace_once(
    "rust/crates/phenix-conductor/src/semantic_tools.rs",
    "fn orchestration_list_descriptor() -> CallableDescriptor {\n",
    """fn skill_load_descriptor() -> CallableDescriptor {\n    CallableDescriptor {\n        id: CallableId::parse(SKILL_LOAD_ID).expect(\"static skill load id\"),\n        kind: CallableKind::Tool,\n        description: \"Load the full instructions and resource inventory for one discoverable Phenix skill by id. Use the available-skills catalog from context instead of guessing names.\".to_owned(),\n        input_schema: json!({\n            \"type\": \"object\",\n            \"additionalProperties\": false,\n            \"required\": [\"skill\"],\n            \"properties\": {\n                \"skill\": {\n                    \"type\": \"string\",\n                    \"minLength\": 1,\n                    \"description\": \"Skill id from the available-skills catalog\"\n                }\n            }\n        }),\n        output_schema: json!({\n            \"type\": \"string\"\n        }),\n        capabilities: CapabilitySet::default(),\n        policy: CallablePolicy {\n            requires_permission: false,\n        },\n    }\n}\n\nfn orchestration_list_descriptor() -> CallableDescriptor {\n""",
)

# Protocol: expose complete skill catalog to frontends, including manual-only skills.
replace_once(
    "rust/crates/phenix-protocol/src/lib.rs",
    "    RoutingProfileDescriptor, SessionId, SessionSummary,\n};\n",
    "    RoutingProfileDescriptor, SessionId, SessionSummary, SkillDescriptor,\n};\n",
)
replace_once(
    "rust/crates/phenix-protocol/src/lib.rs",
    "    GetRoutingCatalog,\n",
    "    GetRoutingCatalog,\n    GetSkillCatalog,\n",
)
replace_once(
    "rust/crates/phenix-protocol/src/lib.rs",
    "    RoutingCatalog {\n        profiles: Vec<RoutingProfileDescriptor>,\n    },\n",
    "    RoutingCatalog {\n        profiles: Vec<RoutingProfileDescriptor>,\n    },\n    SkillCatalog {\n        skills: Vec<SkillDescriptor>,\n    },\n",
)
replace_once(
    "rust/crates/phenix-protocol/src/lib.rs",
    "    fn routing_catalog_wire_shape_is_conductor_owned() {\n",
    """    fn skill_catalog_wire_shape_is_conductor_owned() {\n        let request = ClientMessage {\n            id: 12,\n            command: Command::GetSkillCatalog,\n        };\n        let value = serde_json::to_value(request).expect(\"serialize skill catalog request\");\n        assert_eq!(value[\"command\"][\"type\"], \"get_skill_catalog\");\n        assert_eq!(value[\"command\"].as_object().unwrap().len(), 1);\n    }\n\n    #[test]\n    fn routing_catalog_wire_shape_is_conductor_owned() {\n""",
)

# Server dispatch for skill catalog.
replace_once(
    "rust/crates/phenix-conductor/src/server.rs",
    "            Command::GetRoutingCatalog => {\n                let profiles = self.lock_runtime()?.routing_profiles();\n                self.respond(output, id, Ok(Reply::RoutingCatalog { profiles }))?;\n                return Ok(());\n            }\n",
    """            Command::GetRoutingCatalog => {\n                let profiles = self.lock_runtime()?.routing_profiles();\n                self.respond(output, id, Ok(Reply::RoutingCatalog { profiles }))?;\n                return Ok(());\n            }\n            Command::GetSkillCatalog => {\n                let skills = self.lock_runtime()?.skill_descriptors();\n                self.respond(output, id, Ok(Reply::SkillCatalog { skills }))?;\n                return Ok(());\n            }\n""",
)
replace_once(
    "rust/crates/phenix-conductor/src/server.rs",
    "            Command::GetRoutingCatalog => {\n                unreachable!(\"routing catalog handled before dispatch\")\n            }\n",
    """            Command::GetRoutingCatalog => {\n                unreachable!(\"routing catalog handled before dispatch\")\n            }\n            Command::GetSkillCatalog => {\n                unreachable!(\"skill catalog handled before dispatch\")\n            }\n""",
)

# Binary startup: freeze repository context/skill discovery for this process.
replace_once(
    "rust/crates/phenix-conductor/src/main.rs",
    "use phenix_conductor::{ConductorRuntime, ConductorServer, JsonFileStore};\n",
    "use phenix_conductor::{ContextRegistry, ConductorRuntime, ConductorServer, JsonFileStore};\n",
)
replace_once(
    "rust/crates/phenix-conductor/src/main.rs",
    "    {\n        let mut runtime = server.runtime();\n        workspace_tools::register(&mut runtime, cwd.clone())?;\n    }\n",
    """    {\n        let context = ContextRegistry::discover(&cwd)?;\n        let mut runtime = server.runtime();\n        runtime.install_context_registry(context);\n        workspace_tools::register(&mut runtime, cwd.clone())?;\n    }\n""",
)

print("context and skills patch applied")
