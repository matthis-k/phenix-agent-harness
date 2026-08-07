from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"expected text not found in {path}: {old[:80]!r}")
    file.write_text(text.replace(old, new))


# Runtime: production imports should not carry test-only editor/view types.
replace(
    "rust/crates/phenix-ui-runtime/src/runtime.rs",
    "#[cfg(test)]\nuse phenix_ui_core::ElementId;\nuse phenix_ui_core::{\n    command_completions, group_transcript_turns, parse_markdown, reduce, AppEffect, AppEvent,\n    AppState, FocusDirection, FocusTarget, InputEditor, LayoutAxis, OverlayState, ResizeRequest,\n    VimMode,\n};",
    "#[cfg(test)]\nuse phenix_ui_core::{ElementId, InputEditor, RichBlockView};\nuse phenix_ui_core::{\n    command_completions, group_transcript_turns, parse_markdown, reduce, AppEffect, AppEvent,\n    AppState, FocusDirection, FocusTarget, LayoutAxis, OverlayState, ResizeRequest, VimMode,\n};",
)
replace(
    "rust/crates/phenix-ui-runtime/src/runtime.rs",
    "use std::path::{Path, PathBuf};",
    "use std::path::PathBuf;",
)

# ACP projection: ImageContent exists solely to construct the regression fixture.
replace(
    "rust/crates/phenix-acp-backend/src/projection.rs",
    "    ContentBlock, ContentChunk, ImageContent, SessionNotification, SessionUpdate, ToolCall,\n    ToolCallStatus, ToolCallUpdate,",
    "    ContentBlock, ContentChunk, SessionNotification, SessionUpdate, ToolCall, ToolCallStatus,\n    ToolCallUpdate,",
)
replace(
    "rust/crates/phenix-acp-backend/src/projection.rs",
    "mod tests {\n    use super::*;",
    "mod tests {\n    use super::*;\n    use phenix_acp::acp::schema::v1::ImageContent;",
)

# Conductor: Serialize is no longer used by the runtime surface.
replace(
    "rust/crates/phenix-conductor/src/lib.rs",
    "use serde::{Deserialize, Serialize};",
    "use serde::Deserialize;",
)

# Legacy source collection API is unexported and superseded by the canonical
# authoring/configuration Definitions path. Remove it rather than lint-suppress it.
source = Path("rust/crates/phenix-acp/src/source.rs")
text = source.read_text()
text = text.replace("    BackendId, GatewayError, IdError, ModelId, ModelSelection, PhenixAcpGatewayBuilder, ProviderId,\n", "    BackendId, GatewayError, IdError, ModelId, ModelSelection, ProviderId,\n")
text = text.replace('const WORKFLOW_DECLARATION: &str = "phenix-workflow";\n', "")
text = text.replace('const ROUTER_DECLARATION: &str = "phenix-router";\n', "")
kind_impl = '''impl ParsedDefinition {
    pub fn kind(&self) -> DefinitionSourceKind {
        match self {
            Self::Workflow(_) => DefinitionSourceKind::Workflow,
            Self::Router(_) => DefinitionSourceKind::Router,
        }
    }
}

'''
if kind_impl not in text:
    raise SystemExit("ParsedDefinition::kind block not found")
text = text.replace(kind_impl, "")
start = text.find("#[derive(Clone, Debug, Default)]\npub struct DefinitionSources")
end = text.find("pub fn parse_definition(", start)
if start < 0 or end < 0:
    raise SystemExit("DefinitionSources legacy block not found")
text = text[:start] + text[end:]
source.write_text(text)
