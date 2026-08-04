from pathlib import Path
import re


path = Path("rust/crates/phenix-runtime-api/src/protocol.rs")
text = path.read_text()


def collapse_exact(block: str) -> None:
    global text
    pattern = re.compile(rf"(?:{re.escape(block)}\n?)+")
    text = pattern.sub(block, text)


text = re.sub(
    r"(?:use std::collections::BTreeMap;\n)+",
    "use std::collections::BTreeMap;\n",
    text,
)

collapse_exact(
    "#[derive(Clone, Debug, Eq, PartialEq)]\n"
    "pub struct SessionModeSummary {\n"
    "    pub id: String,\n"
    "    pub display_name: String,\n"
    "    pub description: Option<String>,\n"
    "    pub selected: bool,\n"
    "}"
)
collapse_exact(
    "#[derive(Clone, Debug, Eq, PartialEq)]\n"
    "pub struct ExternalCommand {\n"
    "    pub program: String,\n"
    "    pub arguments: Vec<String>,\n"
    "    pub environment: BTreeMap<String, String>,\n"
    "}"
)
collapse_exact(
    "    ExternalCommandRequested {\n"
    "        flow_id: AuthFlowId,\n"
    "        command: ExternalCommand,\n"
    "    },"
)

path.write_text(text)
