from pathlib import Path


path = Path("rust/crates/phenix-runtime-api/src/protocol.rs")
text = path.read_text()


def collapse(block: str) -> None:
    global text
    duplicate = f"{block}\n\n{block}"
    while duplicate in text:
        text = text.replace(duplicate, block, 1)


while "use std::collections::BTreeMap;\nuse std::collections::BTreeMap;" in text:
    text = text.replace(
        "use std::collections::BTreeMap;\nuse std::collections::BTreeMap;",
        "use std::collections::BTreeMap;",
        1,
    )

collapse(
    "#[derive(Clone, Debug, Eq, PartialEq)]\n"
    "pub struct SessionModeSummary {\n"
    "    pub id: String,\n"
    "    pub display_name: String,\n"
    "    pub description: Option<String>,\n"
    "    pub selected: bool,\n"
    "}"
)
collapse(
    "#[derive(Clone, Debug, Eq, PartialEq)]\n"
    "pub struct ExternalCommand {\n"
    "    pub program: String,\n"
    "    pub arguments: Vec<String>,\n"
    "    pub environment: BTreeMap<String, String>,\n"
    "}"
)
collapse(
    "    ExternalCommandRequested {\n"
    "        flow_id: AuthFlowId,\n"
    "        command: ExternalCommand,\n"
    "    },"
)

path.write_text(text)
