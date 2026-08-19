from pathlib import Path
import re

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content)


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    content = read(path)
    actual = content.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrences of {old!r}, found {actual}")
    write(path, content.replace(old, new, count))


def sub(path: str, pattern: str, replacement: str, count: int = 1, flags: int = 0) -> None:
    content = read(path)
    updated, actual = re.subn(pattern, replacement, content, count=count, flags=flags)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} matches for {pattern!r}, found {actual}")
    write(path, updated)


# Canonical inference effort and orchestration wire vocabulary.
core = "rust/crates/phenix-core/src/lib.rs"
replace(
    core,
    "#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]\npub struct InferenceOptions {\n    pub effort: Option<String>,\n}\n",
    "#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]\n#[serde(rename_all = \"snake_case\")]\npub enum InferenceEffort {\n    None,\n    Minimal,\n    Low,\n    Medium,\n    High,\n    ExtraHigh,\n    Max,\n}\n\n#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]\npub struct InferenceOptions {\n    pub effort: Option<InferenceEffort>,\n}\n",
)
replace(core, "    #[serde(rename = \"workflow\")]\n    Orchestration,", "    Orchestration,", count=2)

journal = "rust/crates/phenix-conductor/src/journal.rs"
replace(journal, "    #[serde(rename = \"workflow\")]\n    Orchestration {", "    Orchestration {")
replace(
    journal,
    "    #[serde(rename = \"workflow_advanced\")]\n    OrchestrationAdvanced {",
    "    OrchestrationAdvanced {",
)

# Keep all current conductor/core/protocol terminology canonical. Historical specs are
# not used as compatibility contracts, but current runtime code/tests must not emit the
# old word or old callable IDs.
for root in [
    ROOT / "rust/crates/phenix-core/src",
    ROOT / "rust/crates/phenix-conductor/src",
    ROOT / "rust/crates/phenix-conductor/tests",
    ROOT / "rust/crates/phenix-protocol/src",
]:
    for path in root.rglob("*.rs"):
        content = path.read_text()
        content = re.sub(r"\bWorkflows\b", "Orchestrations", content)
        content = re.sub(r"\bWorkflow\b", "Orchestration", content)
        content = re.sub(r"\bworkflows\b", "orchestrations", content)
        content = re.sub(r"\bworkflow\b", "orchestration", content)
        path.write_text(content)

old_test = ROOT / "rust/crates/phenix-conductor/tests/black_box_workflow_callables.rs"
new_test = ROOT / "rust/crates/phenix-conductor/tests/black_box_orchestration_callables.rs"
if old_test.exists():
    old_test.rename(new_test)

for path in [".github/workflows/ci.yml", "modules/development.nix"]:
    content = read(path)
    content = content.replace("conductor-workflow-callables", "conductor-orchestration-callables")
    content = content.replace("black_box_workflow_callables", "black_box_orchestration_callables")
    write(path, content)

architecture = "rust/ARCHITECTURE.md"
content = read(architecture)
content = content.replace(
    "External product vocabulary may still call an orchestration a workflow where that is the intentional user-facing contract. Such labels are presentation or persistence concerns and do not create a second workflow domain model inside the conductor.",
    "Orchestration is the canonical current vocabulary across source configuration, callable descriptors, protocol DTOs, execution state, and persistence. New runtime surfaces must not emit a second compatibility vocabulary for the same concept.",
)
write(architecture, content)

# Workspace tools: add exact edit and make grep Rust-owned -> ripgrep directly.
workspace = "rust/crates/phenix-conductor/src/workspace_tools.rs"
replace(
    workspace,
    "#[derive(Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct GrepInput {",
    "#[derive(Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct EditInput {\n    path: String,\n    old_text: String,\n    new_text: String,\n    replace_all: Option<bool>,\n}\n\n#[derive(Deserialize)]\n#[serde(deny_unknown_fields)]\nstruct GrepInput {",
)

edit_registration = r'''
    let edit_workspace = workspace.clone();
    runtime.register_tool(
        tool_descriptor(
            "edit",
            format!(
                "Edit a UTF-8 text file in the current Phenix workspace ({}). The old_text match must be unique unless replace_all is explicitly true.",
                workspace.display()
            ),
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "old_text", "new_text"],
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Workspace-relative file path"
                    },
                    "old_text": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Exact text to replace"
                    },
                    "new_text": {
                        "type": "string",
                        "description": "Replacement text"
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every exact match; defaults to false and requires a unique match"
                    }
                }
            }),
            json!({
                "type": "object",
                "required": ["path", "replacements", "bytes_written"],
                "properties": {
                    "path": { "type": "string" },
                    "replacements": { "type": "integer" },
                    "bytes_written": { "type": "integer" }
                }
            }),
        ),
        move |arguments| execute_edit(&edit_workspace, arguments),
    )?;

'''
needle = "    runtime.register_tool(\n        tool_descriptor(\n            \"grep\","
content = read(workspace)
if content.count(needle) != 1:
    raise RuntimeError("workspace grep registration anchor changed")
write(workspace, content.replace(needle, edit_registration + needle, 1))

replace(workspace, "The pattern uses GNU grep regular-expression syntax; .git is excluded.", "The pattern uses ripgrep regular-expression syntax; .git is excluded.")
replace(
    workspace,
    '"description": "Workspace-relative file or directory to search; defaults to ."',
    '"description": "Workspace-relative, home-relative, or absolute file/directory path that resolves inside the workspace; defaults to ."',
)

edit_impl = r'''
fn execute_edit(workspace: &Path, arguments: &str) -> Result<String, String> {
    let input: EditInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid edit arguments: {error}"))?;
    if input.old_text.is_empty() {
        return Err("edit old_text must not be empty".to_owned());
    }
    let relative = relative_workspace_path(&input.path)?;
    let path = workspace.join(&relative);
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {} for edit: {error}", input.path))?;
    let matches = content.match_indices(&input.old_text).count();
    if matches == 0 {
        return Err(format!("edit old_text did not match {}", input.path));
    }
    let replace_all = input.replace_all.unwrap_or(false);
    if !replace_all && matches != 1 {
        return Err(format!(
            "edit old_text matched {matches} occurrences in {}; provide more context or set replace_all=true",
            input.path
        ));
    }
    let replacements = if replace_all { matches } else { 1 };
    let updated = if replace_all {
        content.replace(&input.old_text, &input.new_text)
    } else {
        content.replacen(&input.old_text, &input.new_text, 1)
    };
    fs::write(&path, updated.as_bytes())
        .map_err(|error| format!("failed to write edited {}: {error}", input.path))?;

    Ok(json!({
        "path": relative.to_string_lossy().into_owned(),
        "replacements": replacements,
        "bytes_written": updated.len(),
    })
    .to_string())
}

'''
content = read(workspace)
anchor = "fn execute_grep(workspace: &Path, arguments: &str) -> Result<String, String> {"
if content.count(anchor) != 1:
    raise RuntimeError("workspace execute_grep anchor changed")
write(workspace, content.replace(anchor, edit_impl + anchor, 1))

sub(
    workspace,
    r"fn execute_grep\(workspace: &Path, arguments: &str\) -> Result<String, String> \{.*?\n\}\n\nfn relative_workspace_path",
    r'''fn execute_grep(workspace: &Path, arguments: &str) -> Result<String, String> {
    let input: GrepInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid grep arguments: {error}"))?;
    if input.pattern.is_empty() {
        return Err("grep pattern must not be empty".to_owned());
    }
    let relative = search_workspace_path(workspace, input.path.as_deref().unwrap_or("."))?;
    let rg = std::env::var_os("PHENIX_RG").unwrap_or_else(|| OsString::from("rg"));
    let mut command = Command::new(rg);
    command
        .arg("--hidden")
        .arg("--no-ignore")
        .arg("--line-number")
        .arg("--with-filename")
        .arg("--no-heading")
        .arg("--color")
        .arg("never")
        .arg("--glob")
        .arg("!.git/**")
        .arg("--glob")
        .arg("!**/.git/**");
    if input.case_sensitive == Some(false) {
        command.arg("--ignore-case");
    }
    let output = command
        .arg("--")
        .arg(&input.pattern)
        .arg(&relative)
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("failed to execute ripgrep: {error}"))?;
    let exit_code = output.status.code().unwrap_or(-1);
    if !matches!(exit_code, 0 | 1) {
        return Err(format!(
            "ripgrep failed with exit code {exit_code}: {}",
            capture(&output.stderr)
        ));
    }

    Ok(json!({
        "pattern": input.pattern,
        "path": relative.to_string_lossy().into_owned(),
        "matches": capture(&output.stdout),
        "stderr": capture(&output.stderr),
    })
    .to_string())
}

fn search_workspace_path(workspace: &Path, raw: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    normalize_search_path(workspace, raw, home.as_deref())
}

fn normalize_search_path(
    workspace: &Path,
    raw: &str,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("workspace path must not be empty".to_owned());
    }
    let workspace = fs::canonicalize(workspace)
        .map_err(|error| format!("failed to resolve workspace {}: {error}", workspace.display()))?;
    let requested = if raw == "~" {
        home.ok_or_else(|| "cannot expand ~ because HOME is not set".to_owned())?
            .to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.ok_or_else(|| "cannot expand ~/ because HOME is not set".to_owned())?
            .join(rest)
    } else {
        PathBuf::from(raw)
    };
    let candidate = if requested.is_absolute() {
        requested
    } else {
        workspace.join(requested)
    };
    let candidate = fs::canonicalize(&candidate)
        .map_err(|error| format!("failed to resolve grep path {raw}: {error}"))?;
    if !candidate.starts_with(&workspace) {
        return Err(format!("grep path escapes workspace: {raw}"));
    }
    let relative = candidate
        .strip_prefix(&workspace)
        .expect("workspace prefix was checked")
        .to_path_buf();
    Ok(if relative.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        relative
    })
}

fn relative_workspace_path''',
    flags=re.S,
)

# Add edit/path behavior coverage and update expected default surfaces.
content = read(workspace)
content = content.replace(
    '            vec![\n                "bash".to_owned(),\n                "grep".to_owned(),\n                "read".to_owned(),\n                "write".to_owned(),\n            ]',
    '            vec![\n                "bash".to_owned(),\n                "edit".to_owned(),\n                "grep".to_owned(),\n                "read".to_owned(),\n                "write".to_owned(),\n            ]',
)
content = content.replace(
    'recorder.assert_model_tools(model_name, &["bash", "grep", "read", "write"]);',
    'recorder.assert_model_tools(model_name, &["bash", "edit", "grep", "read", "write"]);',
)
content = content.replace(
    'recorder.assert_model_tools("root", &["bash", "grep", "read", "write"]);',
    'recorder.assert_model_tools("root", &["bash", "edit", "grep", "read", "write"]);',
)
write(workspace, content)

insert_before = "    #[test]\n    fn dedicated_file_tools_reject_workspace_escape_paths() {"
extra_tests = r'''    #[test]
    fn edit_requires_a_unique_match_unless_replace_all_is_explicit() {
        let workspace = temp_workspace("edit-tool");
        fs::write(workspace.join("example.txt"), "alpha beta alpha\n").unwrap();

        let error = execute_edit(
            &workspace,
            r#"{"path":"example.txt","old_text":"alpha","new_text":"omega"}"#,
        )
        .unwrap_err();
        assert!(error.contains("matched 2 occurrences"));

        let result = execute_edit(
            &workspace,
            r#"{"path":"example.txt","old_text":"alpha","new_text":"omega","replace_all":true}"#,
        )
        .unwrap();
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["replacements"], 2);
        assert_eq!(
            fs::read_to_string(workspace.join("example.txt")).unwrap(),
            "omega beta omega\n"
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn grep_path_normalization_accepts_tilde_and_rejects_escape() {
        let home = temp_workspace("grep-home");
        let workspace = home.join("phenix/repos/phenix-nvim");
        fs::create_dir_all(workspace.join("lua/phenix")).unwrap();
        fs::write(workspace.join("lua/phenix/ui.lua"), "transcript input\n").unwrap();

        assert_eq!(
            normalize_search_path(
                &workspace,
                "~/phenix/repos/phenix-nvim/lua",
                Some(&home),
            )
            .unwrap(),
            Path::new("lua")
        );
        assert_eq!(
            normalize_search_path(&workspace, workspace.join("lua").to_str().unwrap(), Some(&home))
                .unwrap(),
            Path::new("lua")
        );
        assert!(normalize_search_path(&workspace, "~/outside", Some(&home)).is_err());
        let _ = fs::remove_dir_all(home);
    }

'''
content = read(workspace)
if content.count(insert_before) != 1:
    raise RuntimeError("workspace tests insertion anchor changed")
write(workspace, content.replace(insert_before, extra_tests + insert_before, 1))

# Nix supplies only concrete executables; remove the GNU-grep compatibility parser.
module = "modules/phenix-acp.nix"
sub(
    module,
    r'''\n      phenixWorkspaceGrep = pkgs\.writeShellScript "phenix-workspace-grep" ''.*?\n      '';\n\n      phenixConductor =''',
    "\n      phenixConductor =",
    flags=re.S,
)
replace(module, '--set PHENIX_GREP "${phenixWorkspaceGrep}" \\\\n', '--set PHENIX_RG "${pkgs.ripgrep}/bin/rg" \\\\n')
sub(
    module,
    r'''\n            grep_home="\$TMPDIR/grep-home".*?\n\n            conductor="\$\{phenixConductor\}/bin/phenix-conductor"''',
    '\n            conductor="${phenixConductor}/bin/phenix-conductor"',
    flags=re.S,
)
replace(
    module,
    '(.id == "bash" or .id == "grep" or .id == "read" or .id == "write")',
    '(.id == "bash" or .id == "edit" or .id == "grep" or .id == "read" or .id == "write")',
)
replace(module, '] | sort == ["bash", "grep", "read", "write"])', '] | sort == ["bash", "edit", "grep", "read", "write"])')

# Provider identity stays nominal in the native backend. Aliases are rejected at the
# Phenix boundary; adapter/environment aliases remain only where an external system
# actually owns them.
providers = "rust/crates/phenix-backend-native/src/providers.rs"
replace(providers, "use phenix_backend::BackendError;\n", "use phenix_backend::BackendError;\nuse phenix_core::{ModelId, ProviderId};\n")
replace(providers, 'pub(crate) const OLLAMA_CLOUD_PROVIDER: &str = "ollama-cloud";\n', 'pub(crate) const OLLAMA_PROVIDER: &str = "ollama";\npub(crate) const OLLAMA_CLOUD_PROVIDER: &str = "ollama-cloud";\n')
sub(
    providers,
    r"pub\(crate\) fn is_gateway_provider\(provider: &str\) -> bool \{.*?\n\}\n\npub\(crate\) fn is_api_key_auth_provider",
    r'''pub(crate) fn is_gateway_provider(provider: &ProviderId) -> bool {
    matches!(provider.as_str(), OPENCODE_ZEN_PROVIDER | OPENCODE_GO_PROVIDER)
}

pub(crate) fn validate_gateway_model(
    provider: &ProviderId,
    model: &ModelId,
) -> Result<(), BackendError> {
    gateway_adapter(provider, model).map(|_| ())
}

pub(crate) fn gateway_target(
    credentials: &CredentialStore,
    provider: &ProviderId,
    model: &ModelId,
) -> Result<Option<ServiceTarget>, BackendError> {
    let (credential_provider, endpoint, auth_names) = match provider.as_str() {
        OPENCODE_ZEN_PROVIDER => (
            OPENCODE_ZEN_PROVIDER,
            OPENCODE_ZEN_ENDPOINT,
            &[OPENCODE_API_KEY_ENV][..],
        ),
        OPENCODE_GO_PROVIDER => (
            OPENCODE_GO_PROVIDER,
            OPENCODE_GO_ENDPOINT,
            &[OPENCODE_API_KEY_ENV, OPENCODE_GO_API_KEY_ENV][..],
        ),
        _ => return Ok(None),
    };
    let adapter_kind = gateway_adapter(provider, model)?;
    let auth = match credentials
        .api_key(credential_provider)
        .map_err(BackendError::Protocol)?
    {
        Some(secret) => AuthData::from_single(secret),
        None => auth_from_environment(auth_names),
    };
    Ok(Some(ServiceTarget {
        endpoint: Endpoint::from_static(endpoint),
        auth,
        model: ModelIden::new(adapter_kind, model.as_str()),
    }))
}

pub(crate) fn canonical_auth_provider(provider: &ProviderId) -> Option<&'static str> {
    match provider.as_str() {
        OPENAI_API_PROVIDER => Some(OPENAI_API_PROVIDER),
        "openai-codex" => Some("openai-codex"),
        ANTHROPIC_PROVIDER => Some(ANTHROPIC_PROVIDER),
        GEMINI_PROVIDER => Some(GEMINI_PROVIDER),
        GITHUB_COPILOT_PROVIDER => Some(GITHUB_COPILOT_PROVIDER),
        OPENCODE_ZEN_PROVIDER => Some(OPENCODE_ZEN_PROVIDER),
        OPENCODE_GO_PROVIDER => Some(OPENCODE_GO_PROVIDER),
        OPEN_ROUTER_PROVIDER => Some(OPEN_ROUTER_PROVIDER),
        OLLAMA_CLOUD_PROVIDER => Some(OLLAMA_CLOUD_PROVIDER),
        DEEPSEEK_PROVIDER => Some(DEEPSEEK_PROVIDER),
        GROQ_PROVIDER => Some(GROQ_PROVIDER),
        XAI_PROVIDER => Some(XAI_PROVIDER),
        _ => None,
    }
}

pub(crate) fn genai_model(provider: &ProviderId, model: &ModelId) -> Result<String, BackendError> {
    let namespace = match provider.as_str() {
        OPENAI_API_PROVIDER | "openai-codex" => "openai_resp",
        ANTHROPIC_PROVIDER => "anthropic",
        GEMINI_PROVIDER => "gemini",
        GITHUB_COPILOT_PROVIDER => "github_copilot",
        OPEN_ROUTER_PROVIDER => "open_router",
        OLLAMA_PROVIDER => "ollama",
        OLLAMA_CLOUD_PROVIDER => "ollama_cloud",
        DEEPSEEK_PROVIDER => "deepseek",
        GROQ_PROVIDER => "groq",
        XAI_PROVIDER => "xai",
        other => {
            return Err(BackendError::Unsupported(format!(
                "unsupported Phenix provider {other:?}"
            )))
        }
    };
    Ok(format!("{namespace}::{}", model.as_str()))
}

pub(crate) fn is_api_key_auth_provider''',
    flags=re.S,
)
sub(
    providers,
    r"fn gateway_adapter\(provider: &str, model: &str\) -> Result<AdapterKind, BackendError> \{.*?\n\}\n\nfn auth_from_environment",
    r'''fn gateway_adapter(provider: &ProviderId, model: &ModelId) -> Result<AdapterKind, BackendError> {
    match provider.as_str() {
        OPENCODE_ZEN_PROVIDER => zen_adapter(model),
        OPENCODE_GO_PROVIDER => Ok(go_adapter(model)),
        other => Err(BackendError::Unsupported(format!(
            "provider {other:?} is not an OpenCode gateway"
        ))),
    }
}

fn zen_adapter(model: &ModelId) -> Result<AdapterKind, BackendError> {
    let model = model.as_str();
    if model.starts_with("gemini-") {
        return Err(BackendError::Unsupported(format!(
            "OpenCode Zen model {model:?} requires the Google-native Zen endpoint, which the built-in Phenix backend does not expose yet"
        )));
    }
    if model.starts_with("gpt-") || model.starts_with("grok-") {
        return Ok(AdapterKind::OpenAIResp);
    }
    if model.starts_with("claude-") || model.starts_with("qwen") {
        return Ok(AdapterKind::Anthropic);
    }
    Ok(AdapterKind::OpenAI)
}

fn go_adapter(model: &ModelId) -> AdapterKind {
    let model = model.as_str();
    if model.starts_with("gpt-") {
        return AdapterKind::OpenAIResp;
    }
    if model.starts_with("minimax-") || model.starts_with("qwen") {
        return AdapterKind::Anthropic;
    }
    AdapterKind::OpenAI
}

fn auth_from_environment''',
    flags=re.S,
)
sub(
    providers,
    r"#\[cfg\(test\)\]\nmod tests \{.*\Z",
    r'''#[cfg(test)]
mod tests {
    use super::*;

    fn provider(value: &str) -> ProviderId {
        ProviderId::parse(value).unwrap()
    }

    fn model(value: &str) -> ModelId {
        ModelId::parse(value).unwrap()
    }

    #[test]
    fn default_catalog_covers_requested_provider_classes() {
        for provider in [
            "openai-codex",
            OPENAI_API_PROVIDER,
            OPENCODE_GO_PROVIDER,
            OPENCODE_ZEN_PROVIDER,
            OPEN_ROUTER_PROVIDER,
        ] {
            assert!(
                DEFAULT_MODELS
                    .iter()
                    .any(|model| model.starts_with(&format!("{provider}/"))),
                "missing default model for {provider}"
            );
        }
        assert!(!DEFAULT_MODELS.contains(&"openai-codex/gpt-5.6"));
    }

    #[test]
    fn only_canonical_phenix_provider_ids_have_auth_mappings() {
        for (provider_id, auth_provider) in [
            (OPENAI_API_PROVIDER, OPENAI_API_PROVIDER),
            ("anthropic", ANTHROPIC_PROVIDER),
            ("gemini", GEMINI_PROVIDER),
            ("github-copilot", GITHUB_COPILOT_PROVIDER),
            ("opencode-zen", OPENCODE_ZEN_PROVIDER),
            ("opencode-go", OPENCODE_GO_PROVIDER),
            ("open-router", OPEN_ROUTER_PROVIDER),
            ("ollama-cloud", OLLAMA_CLOUD_PROVIDER),
            ("deepseek", DEEPSEEK_PROVIDER),
            ("groq", GROQ_PROVIDER),
            ("xai", XAI_PROVIDER),
        ] {
            assert_eq!(canonical_auth_provider(&provider(provider_id)), Some(auth_provider));
            assert!(is_api_key_auth_provider(auth_provider));
            assert!(environment_name(auth_provider).is_some());
            assert!(environment_description(auth_provider).is_some());
        }
        assert_eq!(
            canonical_auth_provider(&provider("openai-codex")),
            Some("openai-codex")
        );
        for alias in ["openai", "openai-responses", "google", "opencode", "openrouter"] {
            assert_eq!(canonical_auth_provider(&provider(alias)), None, "alias {alias}");
        }
        assert_eq!(canonical_auth_provider(&provider(OLLAMA_PROVIDER)), None);
    }

    #[test]
    fn canonical_provider_mapping_owns_provider_adapter_identity() {
        assert_eq!(
            genai_model(&provider(OPENAI_API_PROVIDER), &model("gpt-5.6-terra")).unwrap(),
            "openai_resp::gpt-5.6-terra"
        );
        assert!(genai_model(&provider("openai-responses"), &model("gpt-5.6-terra")).is_err());
    }

    #[test]
    fn opencode_go_uses_each_current_wire_protocol() {
        assert_eq!(go_adapter(&model("gpt-5.6-luna")), AdapterKind::OpenAIResp);
        assert_eq!(go_adapter(&model("qwen3.7-plus")), AdapterKind::Anthropic);
        assert_eq!(go_adapter(&model("minimax-m3")), AdapterKind::Anthropic);
        assert_eq!(go_adapter(&model("deepseek-v4-flash")), AdapterKind::OpenAI);
    }

    #[test]
    fn opencode_zen_uses_each_current_wire_protocol() {
        assert_eq!(zen_adapter(&model("gpt-5.6-terra")).unwrap(), AdapterKind::OpenAIResp);
        assert_eq!(zen_adapter(&model("claude-sonnet-5")).unwrap(), AdapterKind::Anthropic);
        assert_eq!(zen_adapter(&model("qwen3.7-plus")).unwrap(), AdapterKind::Anthropic);
        assert_eq!(zen_adapter(&model("deepseek-v4-flash")).unwrap(), AdapterKind::OpenAI);
        assert!(matches!(
            zen_adapter(&model("gemini-3.6-flash")),
            Err(BackendError::Unsupported(_))
        ));
    }
}
''',
    flags=re.S,
)

native = "rust/crates/phenix-backend-native/src/lib.rs"
replace(
    native,
    "    AuthenticationMethodKind, AuthenticationState, BackendCatalog, BackendId, InferenceOptions,\n    ModelDescriptor, ModelId, ModelTarget, ProviderId, SessionId,\n",
    "    AuthenticationMethodKind, AuthenticationState, BackendCatalog, BackendId, InferenceEffort,\n    InferenceOptions, ModelDescriptor, ModelId, ModelTarget, ProviderId, SessionId,\n",
)
sub(
    native,
    r"#\[derive\(Clone, Debug, Eq, PartialEq\)\]\nstruct ModelSelection \{.*?\n\}\n\npub struct PhenixBackend",
    r'''fn parse_configured_model(value: &str) -> Result<ModelTarget, BackendError> {
    let (provider, model) = value.split_once('/').ok_or_else(|| {
        BackendError::Protocol(format!(
            "Phenix model selection {value:?} must be provider/model"
        ))
    })?;
    if provider.trim().is_empty() || model.trim().is_empty() {
        return Err(BackendError::Protocol(format!(
            "Phenix model selection {value:?} must be provider/model"
        )));
    }
    let target = ModelTarget {
        backend: BackendId::parse(BACKEND_ID)
            .map_err(|error| BackendError::Protocol(error.to_string()))?,
        provider: ProviderId::parse(provider)
            .map_err(|error| BackendError::Protocol(error.to_string()))?,
        model: ModelId::parse(model).map_err(|error| BackendError::Protocol(error.to_string()))?,
        inference: InferenceOptions::default(),
    };
    validate_model_target(&target)?;
    Ok(target)
}

fn model_wire_value(target: &ModelTarget) -> String {
    format!("{}/{}", target.provider, target.model)
}

fn validate_model_target(target: &ModelTarget) -> Result<(), BackendError> {
    if target.backend.as_str() != BACKEND_ID {
        return Err(BackendError::Unsupported(format!(
            "Phenix backend cannot serve target backend {}",
            target.backend
        )));
    }
    if providers::is_gateway_provider(&target.provider) {
        providers::validate_gateway_model(&target.provider, &target.model)
    } else {
        providers::genai_model(&target.provider, &target.model).map(|_| ())
    }
}

fn provider_reasoning_effort(effort: &InferenceEffort) -> ReasoningEffort {
    match effort {
        InferenceEffort::None => ReasoningEffort::None,
        InferenceEffort::Minimal => ReasoningEffort::Minimal,
        InferenceEffort::Low => ReasoningEffort::Low,
        InferenceEffort::Medium => ReasoningEffort::Medium,
        InferenceEffort::High => ReasoningEffort::High,
        InferenceEffort::ExtraHigh => ReasoningEffort::XHigh,
        InferenceEffort::Max => ReasoningEffort::Max,
    }
}

fn dispatch_tool_call<T: serde::Serialize + ?Sized>(
    tools: &PreparedToolSurface,
    host: &mut dyn BackendHost,
    fn_name: &str,
    fn_arguments: &T,
) -> Result<String, BackendError> {
    let Some(descriptor) = tools
        .callables()
        .iter()
        .find(|descriptor| descriptor.id.as_str() == fn_name)
    else {
        return Ok(json!({
            "error": format!("unknown or unavailable Phenix tool {fn_name:?}")
        })
        .to_string());
    };
    let arguments_json = match serde_json::to_string(fn_arguments) {
        Ok(arguments) => arguments,
        Err(error) => {
            return Ok(json!({
                "error": format!("cannot encode tool arguments: {error}")
            })
            .to_string())
        }
    };
    match host.invoke_tool(ToolInvocation {
        callable: descriptor.id.clone(),
        arguments_json,
    }) {
        Ok(result) if result.success => Ok(result.output),
        Ok(result) => Ok(json!({ "error": result.output }).to_string()),
        Err(BackendError::Protocol(error)) => {
            Ok(json!({ "error": format!("tool dispatch failed: {error}") }).to_string())
        }
        Err(error) => Err(error),
    }
}

pub struct PhenixBackend''',
    flags=re.S,
)
replace(native, "    models: Vec<ModelSelection>,", "    models: Vec<ModelTarget>,")
sub(
    native,
    r"    fn validate_request\(&self, request: &BackendSessionRequest\) -> Result<\(\), BackendError> \{.*?\n    \}\n\n    fn new_session",
    r'''    fn validate_request(&self, request: &BackendSessionRequest) -> Result<(), BackendError> {
        validate_model_target(&request.model)?;
        if !request.tools.is_empty()
            && request.tools.presentation() != Some(ToolPresentation::Native)
        {
            return Err(BackendError::Unsupported(
                "Phenix backend requires native conductor tool presentation".to_owned(),
            ));
        }
        Ok(())
    }

    fn new_session''',
    flags=re.S,
)
replace(native, ".filter_map(|selection| providers::canonical_auth_provider(&selection.provider))", ".filter_map(|target| providers::canonical_auth_provider(&target.provider))")
replace(native, ".map(|selection| model_descriptor(&self.credentials, selection))", ".map(|target| model_descriptor(&self.credentials, target))")
sub(
    native,
    r"        let selection = ModelSelection \{.*?        let tool_definitions = tools",
    r'''        let provider = if model.provider.as_str() == oauth::PROVIDER {
            &self.codex_provider
        } else {
            &self.provider
        };
        let provider_target = match providers::gateway_target(
            &self.credentials,
            &model.provider,
            &model.model,
        )? {
            Some(target) => target,
            None => {
                let provider_model = providers::genai_model(&model.provider, &model.model)?;
                provider
                    .resolve_service_target(provider_model)
                    .await
                    .map_err(|error| {
                        BackendError::Transport(format!(
                            "cannot resolve provider target for {}: {error}",
                            model_wire_value(&model)
                        ))
                    })?
            }
        };
        let tool_definitions = tools''',
    flags=re.S,
)
replace(
    native,
    "        let reasoning_effort = parse_reasoning_effort(model.inference.effort.as_deref())?;",
    "        let reasoning_effort = model.inference.effort.as_ref().map(provider_reasoning_effort);",
)
sub(
    native,
    r"            let mut responses = Vec::new\(\);\n            for call in tool_calls \{.*?\n            \}\n            history.push\(ChatMessage::from\(responses\)\);",
    r'''            let mut responses = Vec::new();
            for call in tool_calls {
                let output = dispatch_tool_call(&tools, host, &call.fn_name, &call.fn_arguments)?;
                responses.push(ToolResponse::new(call.call_id, output));
            }
            history.push(ChatMessage::from(responses));''',
    flags=re.S,
)
sub(
    native,
    r"fn provider_has_valid_auth\(\n    credentials: &CredentialStore,\n    provider: &str,\n\) -> Result<bool, BackendError> \{\n    let Some\(provider\) = providers::canonical_auth_provider\(provider\) else \{",
    r'''fn provider_has_valid_auth(
    credentials: &CredentialStore,
    provider: &ProviderId,
) -> Result<bool, BackendError> {
    let Some(provider) = providers::canonical_auth_provider(provider) else {''',
)
sub(
    native,
    r"fn model_descriptor\(\n    credentials: &CredentialStore,\n    selection: &ModelSelection,\n\) -> Result<ModelDescriptor, BackendError> \{.*?\n\}",
    r'''fn model_descriptor(
    credentials: &CredentialStore,
    target: &ModelTarget,
) -> Result<ModelDescriptor, BackendError> {
    Ok(ModelDescriptor {
        target: target.clone(),
        name: model_wire_value(target),
        selectable: provider_has_valid_auth(credentials, &target.provider)?,
    })
}''',
    flags=re.S,
)
sub(
    native,
    r"fn configured_models\(\) -> Result<Vec<ModelSelection>, BackendError> \{.*?\n\}\n\nfn parse_reasoning_effort\(.*?\n\}\n",
    r'''fn configured_models() -> Result<Vec<ModelTarget>, BackendError> {
    let source = std::env::var("PHENIX_MODELS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("PHENIX_MODEL").ok())
        .unwrap_or_else(|| providers::DEFAULT_MODELS.join(","));
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for value in source
        .split([',', ';', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let target = parse_configured_model(value)?;
        if seen.insert((target.provider.clone(), target.model.clone())) {
            models.push(target);
        }
    }
    if models.is_empty() {
        return Err(BackendError::Protocol(
            "Phenix model catalog must contain at least one provider/model".to_owned(),
        ));
    }
    Ok(models)
}
''',
    flags=re.S,
)
sub(
    native,
    r"#\[cfg\(test\)\]\nmod tests \{.*\Z",
    r'''#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::{ToolProvision, ToolResult};
    use phenix_core::{
        CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    };
    use serde_json::json;

    #[test]
    fn model_catalog_marks_provider_auth_selectability() {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "phenix-model-auth-test-{}-{unique}",
            std::process::id()
        ));
        let credentials = CredentialStore {
            path: root.join("credentials.json"),
        };
        let codex = parse_configured_model("openai-codex/gpt-test").unwrap();
        let local = parse_configured_model("ollama/local-test").unwrap();

        assert!(!model_descriptor(&credentials, &codex).unwrap().selectable);
        assert!(model_descriptor(&credentials, &local).unwrap().selectable);

        credentials
            .save_oauth(
                oauth::PROVIDER,
                StoredCredential::OAuth {
                    access_token: "access".to_owned(),
                    refresh_token: "refresh".to_owned(),
                    id_token: "id".to_owned(),
                    account_id: "account".to_owned(),
                    expires_at: u64::MAX,
                },
            )
            .unwrap();
        assert!(model_descriptor(&credentials, &codex).unwrap().selectable);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn model_identity_remains_nominal_and_rejects_aliases() {
        let target = parse_configured_model("openai-codex/gpt-5.6-sol").unwrap();
        assert_eq!(target.backend.as_str(), BACKEND_ID);
        assert_eq!(target.provider.as_str(), "openai-codex");
        assert_eq!(target.model.as_str(), "gpt-5.6-sol");
        assert_eq!(
            providers::genai_model(&target.provider, &target.model).unwrap(),
            "openai_resp::gpt-5.6-sol"
        );
        for alias in [
            "openai/gpt-5.6-sol",
            "openai-responses/gpt-5.6-sol",
            "google/gemini-test",
            "opencode/model",
            "openrouter/model",
        ] {
            assert!(parse_configured_model(alias).is_err(), "alias {alias}");
        }
    }

    #[test]
    fn native_backend_negotiates_native_tools() {
        let capabilities = BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::Native]),
            images: false,
            persistent_sessions: true,
        };
        let surface = ToolProvision::default().prepare(&capabilities).unwrap();
        assert!(surface.is_empty());
        assert!(capabilities.persistent_sessions);
    }

    #[test]
    fn tool_round_limit_is_opt_in() {
        assert_eq!(parse_max_tool_rounds(None).unwrap(), None);
        assert_eq!(parse_max_tool_rounds(Some("  ")).unwrap(), None);
        assert_eq!(parse_max_tool_rounds(Some("7")).unwrap().unwrap().get(), 7);
        assert!(matches!(
            parse_max_tool_rounds(Some("0")),
            Err(BackendError::Protocol(_))
        ));
        assert!(matches!(
            parse_max_tool_rounds(Some("many")),
            Err(BackendError::Protocol(_))
        ));
    }

    #[test]
    fn reasoning_effort_is_canonical_core_domain() {
        assert_eq!(
            provider_reasoning_effort(&InferenceEffort::High),
            ReasoningEffort::High
        );
        assert_eq!(
            provider_reasoning_effort(&InferenceEffort::ExtraHigh),
            ReasoningEffort::XHigh
        );
    }

    fn test_tool_surface() -> PreparedToolSurface {
        ToolProvision {
            callables: vec![CallableDescriptor {
                id: CallableId::parse("read").unwrap(),
                kind: CallableKind::Tool,
                description: "test read".to_owned(),
                input_schema: json!({"type": "object"}),
                output_schema: json!({"type": "object"}),
                capabilities: CapabilitySet::default(),
                policy: CallablePolicy::default(),
            }],
        }
        .prepare(&BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::Native]),
            images: false,
            persistent_sessions: false,
        })
        .unwrap()
    }

    struct TestToolHost {
        result: Result<ToolResult, BackendError>,
        calls: usize,
    }

    impl BackendHost for TestToolHost {
        fn emit(&mut self, _event: BackendEvent) -> Result<(), BackendError> {
            Ok(())
        }

        fn invoke_tool(&mut self, _invocation: ToolInvocation) -> Result<ToolResult, BackendError> {
            self.calls += 1;
            self.result.clone()
        }
    }

    #[test]
    fn faulty_tool_calls_are_returned_to_the_model_and_transport_failures_remain_fatal() {
        let tools = test_tool_surface();
        let mut host = TestToolHost {
            result: Ok(ToolResult {
                output: "missing file".to_owned(),
                success: false,
            }),
            calls: 0,
        };
        let failed = dispatch_tool_call(&tools, &mut host, "read", &json!({"path": "missing"}))
            .unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&failed).unwrap()["error"], "missing file");
        assert_eq!(host.calls, 1);

        let unknown = dispatch_tool_call(&tools, &mut host, "made_up_tool", &json!({})).unwrap();
        assert!(unknown.contains("unknown or unavailable Phenix tool"));
        assert_eq!(host.calls, 1, "unknown tools must not reach the host");

        let mut protocol_host = TestToolHost {
            result: Err(BackendError::Protocol("bad tool request".to_owned())),
            calls: 0,
        };
        let protocol = dispatch_tool_call(&tools, &mut protocol_host, "read", &json!({})).unwrap();
        assert!(protocol.contains("tool dispatch failed"));

        let mut transport_host = TestToolHost {
            result: Err(BackendError::Transport("persistence unavailable".to_owned())),
            calls: 0,
        };
        assert!(matches!(
            dispatch_tool_call(&tools, &mut transport_host, "read", &json!({})),
            Err(BackendError::Transport(_))
        ));
    }
}
''',
    flags=re.S,
)

# Bounded independent execution scheduling: keep the event sequencer/runtime lock
# canonical, but run independent execution chains on a fixed-size worker pool.
server = "rust/crates/phenix-conductor/src/server.rs"
replace(server, "const EXECUTION_BUFFER: usize = 64;\n", "const EXECUTION_BUFFER: usize = 64;\nconst EXECUTION_WORKERS: usize = 4;\n")
replace(
    server,
    "            let executor = scope.spawn(move || {\n                execution_loop(\n                    execution_receiver,\n                    runtime,\n                    backends,\n                    active_scopes,\n                    store,\n                    persist_lock,\n                )\n            });\n",
    "            let execution_receiver = Arc::new(Mutex::new(execution_receiver));\n            let executors = (0..EXECUTION_WORKERS)\n                .map(|_| {\n                    let execution_receiver = Arc::clone(&execution_receiver);\n                    let runtime = runtime.clone();\n                    let backends = backends.clone();\n                    let active_scopes = active_scopes.clone();\n                    let store = store.clone();\n                    let persist_lock = persist_lock.clone();\n                    scope.spawn(move || {\n                        execution_loop(\n                            execution_receiver,\n                            runtime,\n                            backends,\n                            active_scopes,\n                            store,\n                            persist_lock,\n                        )\n                    })\n                })\n                .collect::<Vec<_>>();\n",
)
replace(
    server,
    "            let executor_result = executor.join().map_err(|_| ServerError::WorkerPanicked)?;\n",
    "            let mut executor_result = Ok(());\n            for executor in executors {\n                let worker_result = executor.join().map_err(|_| ServerError::WorkerPanicked)?;\n                if executor_result.is_ok() {\n                    executor_result = worker_result;\n                }\n            }\n",
)
sub(
    server,
    r"fn execution_loop\(\n    executions: Receiver<ExecutionJob>,\n    runtime: SharedRuntime,",
    "fn execution_loop(\n    executions: Arc<Mutex<Receiver<ExecutionJob>>>,\n    runtime: SharedRuntime,",
)
replace(
    server,
    "    while let Ok(job) = executions.recv() {\n        execute_job_chain(\n            job.execution_id,\n            &runtime,\n            &backends,\n            &active_scopes,\n            store.as_ref(),\n            &persist_lock,\n        )?;\n    }\n    Ok(())\n}",
    "    loop {\n        let job = {\n            let receiver = executions\n                .lock()\n                .map_err(|_| ServerError::StatePoisoned(\"execution receiver\"))?;\n            receiver.recv()\n        };\n        let Ok(job) = job else {\n            break;\n        };\n        execute_job_chain(\n            job.execution_id,\n            &runtime,\n            &backends,\n            &active_scopes,\n            store.as_ref(),\n            &persist_lock,\n        )?;\n    }\n    Ok(())\n}",
)
replace(server, "    use std::sync::atomic::{AtomicUsize, Ordering};\n", "    use std::sync::atomic::{AtomicUsize, Ordering};\n    use std::sync::Condvar;\n    use std::time::Duration;\n")

scheduler_test = r'''

    #[derive(Clone)]
    struct ConcurrentGate {
        state: Arc<(Mutex<usize>, Condvar)>,
    }

    struct ConcurrentBackend {
        gate: ConcurrentGate,
    }

    struct ConcurrentSession {
        gate: ConcurrentGate,
    }

    impl Backend for ConcurrentBackend {
        fn capabilities(&self) -> phenix_backend::BackendCapabilities {
            phenix_backend::BackendCapabilities {
                tool_presentations: BTreeSet::new(),
                images: false,
                persistent_sessions: false,
            }
        }

        fn open_session(
            &mut self,
            _request: BackendSessionRequest,
        ) -> Result<Arc<dyn BackendSession>, BackendError> {
            Ok(Arc::new(ConcurrentSession {
                gate: self.gate.clone(),
            }))
        }
    }

    impl BackendSession for ConcurrentSession {
        fn execute(
            &self,
            _request: BackendExecutionRequest,
            _host: &mut dyn BackendHost,
        ) -> Result<(), BackendError> {
            let (lock, ready) = &*self.gate.state;
            let mut active = lock.lock().unwrap();
            *active += 1;
            ready.notify_all();
            let (active, _) = ready
                .wait_timeout_while(active, Duration::from_secs(2), |active| *active < 2)
                .unwrap();
            if *active < 2 {
                return Err(BackendError::Transport(
                    "independent sessions did not execute concurrently".to_owned(),
                ));
            }
            Ok(())
        }

        fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), BackendError> {
            Ok(())
        }
    }

    #[test]
    fn independent_sessions_use_bounded_parallel_execution_lanes() {
        assert!(EXECUTION_WORKERS >= 2);
        let gate = ConcurrentGate {
            state: Arc::new((Mutex::new(0), Condvar::new())),
        };
        let mut server = ConductorServer::new(ConductorRuntime::new());
        server
            .register_backend(
                BackendId::parse("fixture").unwrap(),
                Box::new(ConcurrentBackend { gate }),
            )
            .unwrap();
        let target = serde_json::to_string(&ExecutionTarget::Fixed(model_target())).unwrap();
        let input = format!(
            "{{\"id\":1,\"command\":{{\"type\":\"create_session\",\"parent_session\":null,\"name\":\"a\",\"target\":{target}}}}}\n\\
             {{\"id\":2,\"command\":{{\"type\":\"create_session\",\"parent_session\":null,\"name\":\"b\",\"target\":{target}}}}}\n\\
             {{\"id\":3,\"command\":{{\"type\":\"submit\",\"session_id\":\"session-1\",\"text\":\"one\"}}}}\n\\
             {{\"id\":4,\"command\":{{\"type\":\"submit\",\"session_id\":\"session-2\",\"text\":\"two\"}}}}\n"
        );
        server
            .serve_ndjson(std::io::Cursor::new(input), std::io::sink())
            .unwrap();
        let executions = server.runtime().snapshot().executions;
        assert_eq!(executions.len(), 2);
        assert!(
            executions
                .iter()
                .all(|execution| execution.state == ExecutionState::Completed),
            "independent execution states: {executions:?}"
        );
    }
'''
content = read(server)
idx = content.rfind("\n}")
if idx == -1 or "mod tests" not in content[idx - 20000 :]:
    raise RuntimeError("server tests closing brace not found")
write(server, content[:idx] + scheduler_test + content[idx:])

# Current configuration tests and API examples now use orchestration IDs/prompt text.
# The broad conductor rewrite above handled Rust; make the active packaging smoke agree.
replace(
    module,
    '.id == "bash" or .id == "edit" or .id == "grep" or .id == "read" or .id == "write"',
    '.id == "bash" or .id == "edit" or .id == "grep" or .id == "read" or .id == "write"',
)

# Remove this one-shot machinery from the resulting branch; the workflow continues
# from the already-loaded process and commits only product changes.
(ROOT / ".github/agent-runtime-qa-cleanup.py").unlink()
(ROOT / ".github/workflows/agent-runtime-qa-cleanup.yml").unlink()
