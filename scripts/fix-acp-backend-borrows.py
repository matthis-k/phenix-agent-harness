from pathlib import Path


path = Path("rust/crates/phenix-acp-backend/src/lib.rs")
text = path.read_text()


def replace_once(old: str, new: str) -> None:
    global text
    if old in text:
        text = text.replace(old, new, 1)
    elif new not in text:
        raise RuntimeError(f"missing borrow-fix anchor: {old}")


replace_once(
    "        BackendCommand::ModelList => {\n            let models = runtime\n                .adapter\n                .active_session_mut()?\n                .models(runtime.adapter.capabilities.prompting.images);",
    "        BackendCommand::ModelList => {\n            let supports_images = runtime.adapter.capabilities.prompting.images;\n            let models = runtime\n                .adapter\n                .active_session_mut()?\n                .models(supports_images);",
)
replace_once(
    "    let session = runtime.adapter.session_for_run_mut(&run_id)?;\n    if session.prompt_active {\n        return Err(BackendError::InvalidConfiguration(format!(\n            \"run {run_id} already has an active ACP prompt\"\n        )));\n    }\n    if !prompt.images.is_empty() && !runtime.adapter.capabilities.prompting.images {",
    "    let supports_images = runtime.adapter.capabilities.prompting.images;\n    if !prompt.images.is_empty() && !supports_images {",
)
replace_once(
    "        return Err(BackendError::Unsupported(\n            \"the ACP agent does not accept image prompt blocks\".to_owned(),\n        ));\n    }\n    let mut content: Vec<ContentBlock>",
    "        return Err(BackendError::Unsupported(\n            \"the ACP agent does not accept image prompt blocks\".to_owned(),\n        ));\n    }\n    let session = runtime.adapter.session_for_run_mut(&run_id)?;\n    if session.prompt_active {\n        return Err(BackendError::InvalidConfiguration(format!(\n            \"run {run_id} already has an active ACP prompt\"\n        )));\n    }\n    let mut content: Vec<ContentBlock>",
)

path.write_text(text)
