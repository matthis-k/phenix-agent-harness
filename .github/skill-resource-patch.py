from pathlib import Path


def patch(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# context.rs: freeze skill resources at discovery and expose text reads.
path = "rust/crates/phenix-conductor/src/context.rs"
patch(path, "use std::collections::BTreeMap;\n", "use std::collections::{BTreeMap, BTreeSet};\n")
patch(path, "use std::path::{Path, PathBuf};\n", "use std::path::{Component, Path, PathBuf};\n\nconst MAX_TEXT_RESOURCE_BYTES: u64 = 1024 * 1024;\n")
patch(
    path,
    """struct SkillDefinition {\n    descriptor: SkillDescriptor,\n    instructions: String,\n    root: PathBuf,\n    resources: Vec<PathBuf>,\n    allowed_tools: Vec<String>,\n}\n""",
    """struct SkillDefinition {\n    descriptor: SkillDescriptor,\n    instructions: String,\n    root: PathBuf,\n    resources: BTreeMap<PathBuf, SkillResourceContent>,\n    allowed_tools: Vec<String>,\n}\n\n#[derive(Clone, Debug, Eq, PartialEq)]\nenum SkillResourceContent {\n    Text(String),\n    Unavailable,\n}\n""",
)
patch(
    path,
    """    UnknownSkill(SkillId),\n    ManualOnlySkill(SkillId),\n}\n""",
    """    UnknownSkill(SkillId),\n    ManualOnlySkill(SkillId),\n    InactiveSkill(SkillId),\n    InvalidSkillResourcePath { skill: SkillId, path: String },\n    UnknownSkillResource { skill: SkillId, path: String },\n    UnsupportedSkillResource { skill: SkillId, path: String },\n}\n""",
)
patch(
    path,
    """            Self::UnknownSkill(id) => write!(f, \"unknown skill: {id}\"),\n            Self::ManualOnlySkill(id) => write!(f, \"skill is manual-only: {id}\"),\n""",
    """            Self::UnknownSkill(id) => write!(f, \"unknown skill: {id}\"),\n            Self::ManualOnlySkill(id) => write!(f, \"skill is manual-only: {id}\"),\n            Self::InactiveSkill(id) => write!(f, \"skill is not active for this execution: {id}\"),\n            Self::InvalidSkillResourcePath { skill, path } => {\n                write!(f, \"invalid resource path {path:?} for skill {skill}\")\n            }\n            Self::UnknownSkillResource { skill, path } => {\n                write!(f, \"unknown resource {path:?} for skill {skill}\")\n            }\n            Self::UnsupportedSkillResource { skill, path } => write!(\n                f,\n                \"resource {path:?} for skill {skill} is binary or exceeds the text resource limit\"\n            ),\n""",
)
patch(
    path,
    """    pub fn has_model_invocable_skills(&self) -> bool {\n        self.skills\n            .values()\n            .any(|skill| skill.descriptor.invocation == SkillInvocationPolicy::ModelEligible)\n    }\n\n    pub fn compose_prompt(&self, input: &str) -> Result<String, ContextError> {\n""",
    """    pub fn has_model_invocable_skills(&self) -> bool {\n        self.skills\n            .values()\n            .any(|skill| skill.descriptor.invocation == SkillInvocationPolicy::ModelEligible)\n    }\n\n    pub fn has_skills(&self) -> bool {\n        !self.skills.is_empty()\n    }\n\n    pub fn compose_prompt(&self, input: &str) -> Result<String, ContextError> {\n        self.compose_prompt_with_activations(input)\n            .map(|(prompt, _)| prompt)\n    }\n\n    pub fn compose_prompt_with_activations(\n        &self,\n        input: &str,\n    ) -> Result<(String, BTreeSet<SkillId>), ContextError> {\n""",
)
patch(
    path,
    """        if self.base_documents.is_empty() && model_skills.is_empty() && active_skill.is_none() {\n            return Ok(user_prompt.to_owned());\n        }\n""",
    """        if self.base_documents.is_empty() && model_skills.is_empty() && active_skill.is_none() {\n            return Ok((user_prompt.to_owned(), BTreeSet::new()));\n        }\n""",
)
patch(
    path,
    """        output.push_str(\"\\n</user_request>\");\n        Ok(output)\n    }\n\n    pub fn model_skill_payload(&self, id: &SkillId) -> Result<String, ContextError> {\n""",
    """        output.push_str(\"\\n</user_request>\");\n        let active_skills = explicit_skill.into_iter().collect();\n        Ok((output, active_skills))\n    }\n\n    pub fn model_skill_payload(&self, id: &SkillId) -> Result<String, ContextError> {\n""",
)
patch(
    path,
    """        Ok(render_skill(skill))\n    }\n\n    fn resolve_manual_activation<'a>(\n""",
    """        Ok(render_skill(skill))\n    }\n\n    pub fn skill_resource_payload(\n        &self,\n        id: &SkillId,\n        path: &str,\n    ) -> Result<String, ContextError> {\n        let skill = self\n            .skills\n            .get(id)\n            .ok_or_else(|| ContextError::UnknownSkill(id.clone()))?;\n        let relative = normalized_resource_path(id, path)?;\n        let resource = skill.resources.get(&relative).ok_or_else(|| {\n            ContextError::UnknownSkillResource {\n                skill: id.clone(),\n                path: path.to_owned(),\n            }\n        })?;\n        match resource {\n            SkillResourceContent::Text(content) => Ok(format!(\n                \"<skill_resource skill=\\\"{}\\\" path=\\\"{}\\\">\\n{}\\n</skill_resource>\",\n                id,\n                relative.display(),\n                content\n            )),\n            SkillResourceContent::Unavailable => Err(ContextError::UnsupportedSkillResource {\n                skill: id.clone(),\n                path: path.to_owned(),\n            }),\n        }\n    }\n\n    fn resolve_manual_activation<'a>(\n""",
)
patch(
    path,
    """fn collect_resources(root: &Path) -> Result<Vec<PathBuf>, ContextError> {\n    let mut resources = Vec::new();\n    for directory in [\"scripts\", \"references\", \"assets\"] {\n        let path = root.join(directory);\n        if path.is_dir() {\n            collect_files(root, &path, &mut resources)?;\n        }\n    }\n    resources.sort();\n    Ok(resources)\n}\n\nfn collect_files(\n    root: &Path,\n    directory: &Path,\n    output: &mut Vec<PathBuf>,\n) -> Result<(), ContextError> {\n    let mut entries = fs::read_dir(directory)\n        .map_err(|error| io_error(directory, error))?\n        .collect::<Result<Vec<_>, _>>()\n        .map_err(|error| io_error(directory, error))?;\n    entries.sort_by_key(|entry| entry.path());\n    for entry in entries {\n        let path = entry.path();\n        if path.is_dir() {\n            collect_files(root, &path, output)?;\n        } else if path.is_file() {\n            output.push(path.strip_prefix(root).unwrap_or(&path).to_path_buf());\n        }\n    }\n    Ok(())\n}\n""",
    """fn collect_resources(\n    root: &Path,\n) -> Result<BTreeMap<PathBuf, SkillResourceContent>, ContextError> {\n    let mut resources = BTreeMap::new();\n    for directory in [\"scripts\", \"references\", \"assets\"] {\n        let path = root.join(directory);\n        if path.is_dir() {\n            collect_files(root, &path, &mut resources)?;\n        }\n    }\n    Ok(resources)\n}\n\nfn collect_files(\n    root: &Path,\n    directory: &Path,\n    output: &mut BTreeMap<PathBuf, SkillResourceContent>,\n) -> Result<(), ContextError> {\n    let mut entries = fs::read_dir(directory)\n        .map_err(|error| io_error(directory, error))?\n        .collect::<Result<Vec<_>, _>>()\n        .map_err(|error| io_error(directory, error))?;\n    entries.sort_by_key(|entry| entry.path());\n    for entry in entries {\n        let path = entry.path();\n        let file_type = entry.file_type().map_err(|error| io_error(&path, error))?;\n        if file_type.is_symlink() {\n            continue;\n        }\n        if file_type.is_dir() {\n            collect_files(root, &path, output)?;\n        } else if file_type.is_file() {\n            let relative = path.strip_prefix(root).unwrap_or(&path).to_path_buf();\n            let metadata = entry.metadata().map_err(|error| io_error(&path, error))?;\n            let content = if metadata.len() > MAX_TEXT_RESOURCE_BYTES {\n                SkillResourceContent::Unavailable\n            } else {\n                let bytes = fs::read(&path).map_err(|error| io_error(&path, error))?;\n                match String::from_utf8(bytes) {\n                    Ok(text) => SkillResourceContent::Text(text),\n                    Err(_) => SkillResourceContent::Unavailable,\n                }\n            };\n            output.insert(relative, content);\n        }\n    }\n    Ok(())\n}\n\nfn normalized_resource_path(id: &SkillId, value: &str) -> Result<PathBuf, ContextError> {\n    let path = Path::new(value);\n    if value.trim().is_empty()\n        || path.is_absolute()\n        || !path.components().all(|component| matches!(component, Component::Normal(_)))\n    {\n        return Err(ContextError::InvalidSkillResourcePath {\n            skill: id.clone(),\n            path: value.to_owned(),\n        });\n    }\n    Ok(path.to_path_buf())\n}\n""",
)
patch(
    path,
    """        for resource in &skill.resources {\n            output.push_str(&format!(\"- {}\\n\", resource.display()));\n        }\n""",
    """        for resource in skill.resources.keys() {\n            output.push_str(&format!(\"- {}\\n\", resource.display()));\n        }\n""",
)
patch(
    path,
    """        write(\n            root.join(\".agents/skills/tdd/SKILL.md\"),\n            \"---\\nname: tdd\\ndescription: Use when explicitly requested.\\ndisable-model-invocation: true\\n---\\n# TDD\\nWrite a failing regression first.\",\n        );\n\n        let registry = ContextRegistry::discover(&nested).unwrap();\n""",
    """        write(\n            root.join(\".agents/skills/tdd/SKILL.md\"),\n            \"---\\nname: tdd\\ndescription: Use when explicitly requested.\\ndisable-model-invocation: true\\n---\\n# TDD\\nWrite a failing regression first.\",\n        );\n        let resource_path = root.join(\".cursor/skills/unslop/references/style.md\");\n        write(&resource_path, \"frozen resource v1\");\n\n        let registry = ContextRegistry::discover(&nested).unwrap();\n        write(&resource_path, \"mutated resource v2\");\n""",
)
patch(
    path,
    """        assert!(payload.contains(\"Remove generic AI patterns\"));\n        assert!(payload.contains(\"root=\\\"\"));\n        assert!(matches!(\n            registry.model_skill_payload(&SkillId::parse(\"tdd\").unwrap()),\n            Err(ContextError::ManualOnlySkill(_))\n        ));\n\n        fs::remove_dir_all(root).unwrap();\n""",
    """        assert!(payload.contains(\"Remove generic AI patterns\"));\n        assert!(payload.contains(\"root=\\\"\"));\n        assert!(payload.contains(\"references/style.md\"));\n        let resource = registry\n            .skill_resource_payload(\n                &SkillId::parse(\"unslop\").unwrap(),\n                \"references/style.md\",\n            )\n            .unwrap();\n        assert!(resource.contains(\"frozen resource v1\"));\n        assert!(!resource.contains(\"mutated resource v2\"));\n        assert!(matches!(\n            registry.skill_resource_payload(\n                &SkillId::parse(\"unslop\").unwrap(),\n                \"../outside\",\n            ),\n            Err(ContextError::InvalidSkillResourcePath { .. })\n        ));\n        assert!(matches!(\n            registry.model_skill_payload(&SkillId::parse(\"tdd\").unwrap()),\n            Err(ContextError::ManualOnlySkill(_))\n        ));\n\n        fs::remove_dir_all(root).unwrap();\n""",
)

# lib.rs: track skill activation per execution and enforce it for resource reads.
path = "rust/crates/phenix-conductor/src/lib.rs"
patch(
    path,
    """    routing: RoutingRegistry,\n    context: ContextRegistry,\n    policy: InvocationPolicy,\n""",
    """    routing: RoutingRegistry,\n    context: ContextRegistry,\n    skill_activations: BTreeMap<ExecutionId, BTreeSet<SkillId>>,\n    policy: InvocationPolicy,\n""",
)
patch(
    path,
    """            routing: RoutingRegistry::default(),\n            context: ContextRegistry::default(),\n            policy: InvocationPolicy::new(),\n""",
    """            routing: RoutingRegistry::default(),\n            context: ContextRegistry::default(),\n            skill_activations: BTreeMap::new(),\n            policy: InvocationPolicy::new(),\n""",
)
patch(
    path,
    """    #[must_use]\n    pub fn has_model_invocable_skills(&self) -> bool {\n        self.context.has_model_invocable_skills()\n    }\n\n    pub fn load_skill(&self, id: &SkillId) -> Result<String, ConductorError> {\n        Ok(self.context.model_skill_payload(id)?)\n    }\n""",
    """    #[must_use]\n    pub fn has_model_invocable_skills(&self) -> bool {\n        self.context.has_model_invocable_skills()\n    }\n\n    #[must_use]\n    pub fn has_skills(&self) -> bool {\n        self.context.has_skills()\n    }\n\n    pub fn load_skill(\n        &mut self,\n        execution_id: &ExecutionId,\n        id: &SkillId,\n    ) -> Result<String, ConductorError> {\n        let payload = self.context.model_skill_payload(id)?;\n        self.skill_activations\n            .entry(execution_id.clone())\n            .or_default()\n            .insert(id.clone());\n        Ok(payload)\n    }\n\n    pub fn read_skill_resource(\n        &self,\n        execution_id: &ExecutionId,\n        id: &SkillId,\n        path: &str,\n    ) -> Result<String, ConductorError> {\n        if !self\n            .skill_activations\n            .get(execution_id)\n            .is_some_and(|skills| skills.contains(id))\n        {\n            return Err(ContextError::InactiveSkill(id.clone()).into());\n        }\n        Ok(self.context.skill_resource_payload(id, path)?)\n    }\n""",
)
patch(
    path,
    """        let prompt = self.context.compose_prompt(&input)?;\n\n        Ok(ResolvedInvocation {\n""",
    """        let (prompt, explicit_skills) = self.context.compose_prompt_with_activations(&input)?;\n        if !explicit_skills.is_empty() {\n            self.skill_activations\n                .entry(execution_id.clone())\n                .or_default()\n                .extend(explicit_skills);\n        }\n\n        Ok(ResolvedInvocation {\n""",
)
patch(
    path,
    """        if is_terminal(&state) {\n            if let Some(parent) = parent {\n""",
    """        if is_terminal(&state) {\n            self.skill_activations.remove(execution_id);\n            if let Some(parent) = parent {\n""",
)

# semantic_tools.rs: provide resource reads only for active skills.
path = "rust/crates/phenix-conductor/src/semantic_tools.rs"
patch(
    path,
    "pub(super) const SKILL_LOAD_ID: &str = \"phenix_skill_load\";\n",
    "pub(super) const SKILL_LOAD_ID: &str = \"phenix_skill_load\";\npub(super) const SKILL_RESOURCE_READ_ID: &str = \"phenix_skill_resource_read\";\n",
)
patch(
    path,
    """struct SkillLoadInput {\n    skill: String,\n}\n""",
    """struct SkillLoadInput {\n    skill: String,\n}\n\n#[derive(Debug, Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct SkillResourceReadInput {\n    skill: String,\n    path: String,\n}\n""",
)
patch(
    path,
    """    if runtime.has_model_invocable_skills() {\n        resolved.tools.callables.push(skill_load_descriptor());\n    }\n""",
    """    if runtime.has_model_invocable_skills() {\n        resolved.tools.callables.push(skill_load_descriptor());\n    }\n    if runtime.has_skills() {\n        resolved.tools.callables.push(skill_resource_read_descriptor());\n    }\n""",
)
patch(
    path,
    """        ORCHESTRATION_LIST_ID | ORCHESTRATION_START_ID | SKILL_LOAD_ID\n""",
    """        ORCHESTRATION_LIST_ID\n            | ORCHESTRATION_START_ID\n            | SKILL_LOAD_ID\n            | SKILL_RESOURCE_READ_ID\n""",
)
patch(
    path,
    """        SKILL_LOAD_ID => match parse_skill_load(&invocation.arguments_json) {\n            Ok(skill) => match runtime.load_skill(&skill) {\n""",
    """        SKILL_LOAD_ID => match parse_skill_load(&invocation.arguments_json) {\n            Ok(skill) => match runtime.load_skill(execution_id, &skill) {\n""",
)
patch(
    path,
    """        ORCHESTRATION_START_ID => match parse_start(&invocation.arguments_json) {\n""",
    """        SKILL_RESOURCE_READ_ID => match parse_skill_resource_read(&invocation.arguments_json) {\n            Ok((skill, path)) => match runtime.read_skill_resource(execution_id, &skill, &path) {\n                Ok(output) => ToolResult {\n                    output,\n                    success: true,\n                },\n                Err(error) => ToolResult {\n                    output: error.to_string(),\n                    success: false,\n                },\n            },\n            Err(error) => ToolResult {\n                output: error,\n                success: false,\n            },\n        },\n        ORCHESTRATION_START_ID => match parse_start(&invocation.arguments_json) {\n""",
)
patch(
    path,
    """fn parse_skill_load(arguments_json: &str) -> Result<SkillId, String> {\n    let input: SkillLoadInput = serde_json::from_str(arguments_json)\n        .map_err(|error| format!(\"invalid skill load arguments: {error}\"))?;\n    SkillId::parse(input.skill).map_err(|error| format!(\"invalid skill id: {error}\"))\n}\n""",
    """fn parse_skill_load(arguments_json: &str) -> Result<SkillId, String> {\n    let input: SkillLoadInput = serde_json::from_str(arguments_json)\n        .map_err(|error| format!(\"invalid skill load arguments: {error}\"))?;\n    SkillId::parse(input.skill).map_err(|error| format!(\"invalid skill id: {error}\"))\n}\n\nfn parse_skill_resource_read(arguments_json: &str) -> Result<(SkillId, String), String> {\n    let input: SkillResourceReadInput = serde_json::from_str(arguments_json)\n        .map_err(|error| format!(\"invalid skill resource read arguments: {error}\"))?;\n    if input.path.trim().is_empty() {\n        return Err(\"skill resource path must not be empty\".to_owned());\n    }\n    let skill = SkillId::parse(input.skill).map_err(|error| format!(\"invalid skill id: {error}\"))?;\n    Ok((skill, input.path))\n}\n""",
)
patch(
    path,
    """fn orchestration_list_descriptor() -> CallableDescriptor {\n""",
    """fn skill_resource_read_descriptor() -> CallableDescriptor {\n    CallableDescriptor {\n        id: CallableId::parse(SKILL_RESOURCE_READ_ID).expect(\"static skill resource read id\"),\n        kind: CallableKind::Tool,\n        description: \"Read one frozen text resource listed by a skill that is active for this execution. A skill becomes active through explicit manual invocation or a successful phenix_skill_load.\".to_owned(),\n        input_schema: json!({\n            \"type\": \"object\",\n            \"additionalProperties\": false,\n            \"required\": [\"skill\", \"path\"],\n            \"properties\": {\n                \"skill\": { \"type\": \"string\", \"minLength\": 1 },\n                \"path\": {\n                    \"type\": \"string\",\n                    \"minLength\": 1,\n                    \"description\": \"Relative resource path exactly as listed by the active skill\"\n                }\n            }\n        }),\n        output_schema: json!({ \"type\": \"string\" }),\n        capabilities: CapabilitySet::default(),\n        policy: CallablePolicy {\n            requires_permission: false,\n        },\n    }\n}\n\nfn orchestration_list_descriptor() -> CallableDescriptor {\n""",
)

# README: document progressive frozen resources.
path = "README.md"
patch(
    path,
    """Skill `allowed-tools` metadata is advisory only and never expands conductor tool permissions. Skill resources under `scripts/`, `references/`, and `assets/` are inventoried relative to the skill root; executing scripts remains subject to the ordinary workspace/tool permission model.\n""",
    """Skill `allowed-tools` metadata is advisory only and never expands conductor tool permissions. Skill resources under `scripts/`, `references/`, and `assets/` are snapshotted at discovery and inventoried relative to the skill root. After a skill is active, `phenix_skill_resource_read` progressively exposes listed text resources without allowing path traversal or symlink escape; binary or oversized assets remain inventory-only. Executing scripts remains subject to the ordinary workspace/tool permission model.\n""",
)

print("skill resource support patch applied")
