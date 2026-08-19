from pathlib import Path

path = Path("rust/crates/phenix-backend-acp/src/lib.rs")
content = path.read_text()
old = "    AuthenticationState, BackendCatalog, BackendId, InferenceEffort, InferenceOptions,\n    ModelDescriptor, ModelId, ModelTarget, ProviderId, SessionId,\n"
new = "    AuthenticationState, BackendCatalog, BackendId, InferenceOptions, ModelDescriptor, ModelId,\n    ModelTarget, ProviderId, SessionId,\n"
if content.count(old) != 1:
    raise SystemExit(f"expected one library-scope inference effort import, found {content.count(old)}")
content = content.replace(old, new, 1)
old = "mod tests {\n    use super::*;\n    use phenix_backend::ToolProvision;\n"
new = "mod tests {\n    use super::*;\n    use phenix_backend::ToolProvision;\n    use phenix_core::InferenceEffort;\n"
if content.count(old) != 1:
    raise SystemExit(f"expected one test import anchor, found {content.count(old)}")
path.write_text(content.replace(old, new, 1))
