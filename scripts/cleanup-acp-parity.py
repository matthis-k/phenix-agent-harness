from pathlib import Path
import re


def collapse_exact(text: str, block: str) -> str:
    pattern = re.compile(rf"(?:{re.escape(block)}\n?)+")
    return pattern.sub(block, text)


def collapse_match_arms(text: str, header_pattern: str, next_pattern: str) -> str:
    pattern = re.compile(
        rf"(?ms)^(?P<block>{header_pattern}.*?)(?=^{next_pattern})"
    )
    seen: set[str] = set()

    def keep_first(match: re.Match[str]) -> str:
        block = match.group("block")
        normalized = block.strip()
        if normalized in seen:
            return ""
        seen.add(normalized)
        return block

    return pattern.sub(keep_first, text)


protocol_path = Path("rust/crates/phenix-runtime-api/src/protocol.rs")
protocol = protocol_path.read_text()
protocol = re.sub(
    r"(?:use std::collections::BTreeMap;\n)+",
    "use std::collections::BTreeMap;\n",
    protocol,
)
for block in (
    "#[derive(Clone, Debug, Eq, PartialEq)]\n"
    "pub struct SessionModeSummary {\n"
    "    pub id: String,\n"
    "    pub display_name: String,\n"
    "    pub description: Option<String>,\n"
    "    pub selected: bool,\n"
    "}",
    "#[derive(Clone, Debug, Eq, PartialEq)]\n"
    "pub struct ExternalCommand {\n"
    "    pub program: String,\n"
    "    pub arguments: Vec<String>,\n"
    "    pub environment: BTreeMap<String, String>,\n"
    "}",
    "    ExternalCommandRequested {\n"
    "        flow_id: AuthFlowId,\n"
    "        command: ExternalCommand,\n"
    "    },",
):
    protocol = collapse_exact(protocol, block)
protocol_path.write_text(protocol)

reducer_path = Path("rust/crates/phenix-ui-core/src/reducer.rs")
reducer = reducer_path.read_text()
reducer = collapse_match_arms(
    reducer,
    r'        "mode" => \{\n',
    r'        "(?:mode|thinking)" => \{|        "" =>|        _ =>',
)
reducer = collapse_match_arms(
    reducer,
    r"        BackendOutput::Event\(BackendEvent::ExternalCommandRequested \{ flow_id, command \}\) => \{\n",
    r"        BackendOutput::",
)
reducer = collapse_match_arms(
    reducer,
    r"        BackendReply::SessionModes\(modes\) => state\.notifications\.push_back\(\n",
    r"        BackendReply::",
)
reducer = collapse_match_arms(
    reducer,
    r"        BackendEvent::ExternalCommandRequested \{ \.\. \} => \{\n",
    r"        BackendEvent::",
)
reducer_path.write_text(reducer)

runtime_path = Path("rust/crates/phenix-ui-runtime/src/runtime.rs")
runtime = runtime_path.read_text()
runtime = re.sub(r"(?:use std::process::Command;\n)+", "use std::process::Command;\n", runtime)
runtime = re.sub(
    r"(?:use std::sync::atomic::\{AtomicBool, Ordering\};\n)+",
    "use std::sync::atomic::{AtomicBool, Ordering};\n",
    runtime,
)
runtime = re.sub(r"(?:use std::sync::Arc;\n)+", "use std::sync::Arc;\n", runtime)
runtime = runtime.replace(
    "use phenix_runtime_api::{BackendClient, BackendRuntime, BackendWorker};",
    "use phenix_runtime_api::{BackendClient, BackendCommand, BackendRuntime, BackendWorker};",
)
runtime = collapse_match_arms(
    runtime,
    r"    pub fn set_external_io_pause\(&mut self, pause: Arc<AtomicBool>\) \{\n",
    r"    pub fn set_",
)
runtime = collapse_match_arms(
    runtime,
    r"                AppEffect::RunExternal \{ flow_id, command \} => \{\n",
    r"                AppEffect::",
)
runtime_path.write_text(runtime)

main_path = Path("rust/crates/phenix-tui/src/main.rs")
main = main_path.read_text()
main = re.sub(
    r"(?:use std::sync::atomic::\{AtomicBool, Ordering\};\n)+",
    "use std::sync::atomic::{AtomicBool, Ordering};\n",
    main,
)
main = re.sub(r"(?:use std::sync::Arc;\n)+", "use std::sync::Arc;\n", main)
main_path.write_text(main)

wire_path = Path("rust/crates/phenix-process-backend/src/wire.rs")
wire = wire_path.read_text()
wire = collapse_match_arms(
    wire,
    r"            BackendCommand::SessionModes \{ \.\. \} => Self::Accepted,\n",
    r"            BackendCommand::",
)
wire = collapse_match_arms(
    wire,
    r"        BackendCommand::SessionModes \{ \.\. \}\n",
    r"        BackendCommand::",
)
wire_path.write_text(wire)
