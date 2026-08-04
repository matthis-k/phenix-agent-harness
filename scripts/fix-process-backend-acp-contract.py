from pathlib import Path


path = Path("rust/crates/phenix-process-backend/src/wire.rs")
text = path.read_text()


def replace_once(old: str, new: str) -> None:
    global text
    if old in text:
        text = text.replace(old, new, 1)
    elif new not in text:
        raise RuntimeError(f"missing process-backend anchor: {old}")


replace_once(
    "            BackendCommand::ThinkingLevels { .. } => Self::ThinkingLevels,",
    "            BackendCommand::ThinkingLevels { .. } => Self::ThinkingLevels,\n            BackendCommand::SessionModes { .. } => Self::Accepted,",
)
replace_once(
    "            | BackendCommand::SessionRename { .. }\n            | BackendCommand::ModelSelect { .. }",
    "            | BackendCommand::SessionRename { .. }\n            | BackendCommand::SessionModeSelect { .. }\n            | BackendCommand::ModelSelect { .. }",
)
replace_once(
    "            | BackendCommand::AuthLoginCancel { .. }\n            | BackendCommand::CompactionStart { .. }",
    "            | BackendCommand::AuthLoginCancel { .. }\n            | BackendCommand::AuthTerminalFinished { .. }\n            | BackendCommand::CompactionStart { .. }",
)
replace_once(
    "        BackendCommand::SessionExport { session_id, path } => json!({",
    "        BackendCommand::SessionModes { .. }\n        | BackendCommand::SessionModeSelect { .. }\n        | BackendCommand::AuthTerminalFinished { .. } => {\n            return Err(BackendError::Unsupported(\n                \"the transitional process backend does not support ACP-only commands\".to_owned(),\n            ));\n        }\n        BackendCommand::SessionExport { session_id, path } => json!({",
)
replace_once(
    "        AuthMethod::ApiKey => \"api_key\",\n    }",
    "        AuthMethod::ApiKey => \"api_key\",\n        AuthMethod::Terminal => \"terminal\",\n    }",
)
replace_once(
    "            api_keys: bool_path(value, &[\"authentication\", \"apiKeys\"]),\n            device_code:",
    "            api_keys: bool_path(value, &[\"authentication\", \"apiKeys\"]),\n            terminal: false,\n            device_code:",
)

path.write_text(text)
