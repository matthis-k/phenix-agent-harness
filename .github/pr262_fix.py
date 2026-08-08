from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise RuntimeError(f"expected text not found in {path}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "rust/crates/phenix-ui-runtime/src/frontend.rs",
    "session_neighbor(state, delta).map(|session_id| UserIntent::SwitchSession(session_id))",
    "session_neighbor(state, delta).map(UserIntent::SwitchSession)",
)

replace_once(
    "rust/crates/phenix-ui-core/src/state.rs",
    '''        let mut state = AppState::default();
        state.snapshot = Some(RuntimeSnapshot {
            capabilities: BackendCapabilities::default(),
            health: BackendHealth::Ready,
            active_session: None,
            root_run: Some(RunId::parse("root").expect("root")),
            selected_run: Some(RunId::parse("root").expect("root")),
            sessions: Vec::new(),
            runs: vec![
                run("root", None),
                run("child-a", Some("root")),
                run("grandchild", Some("child-a")),
                run("child-b", Some("root")),
            ],
            objectives: Vec::new(),
        });
''',
    '''        let mut state = AppState {
            snapshot: Some(RuntimeSnapshot {
                capabilities: BackendCapabilities::default(),
                health: BackendHealth::Ready,
                active_session: None,
                root_run: Some(RunId::parse("root").expect("root")),
                selected_run: Some(RunId::parse("root").expect("root")),
                sessions: Vec::new(),
                runs: vec![
                    run("root", None),
                    run("child-a", Some("root")),
                    run("grandchild", Some("child-a")),
                    run("child-b", Some("root")),
                ],
                objectives: Vec::new(),
            }),
            ..AppState::default()
        };
''',
)

source = Path("rust/crates/phenix-acp/src/source.rs")
text = source.read_text()
old_import = "    BackendId, GatewayError, IdError, ModelId, ModelSelection, PhenixAcpGatewayBuilder, ProviderId,\n"
if old_import not in text:
    raise RuntimeError("source.rs import boundary not found")
text = text.replace(
    old_import,
    "    BackendId, GatewayError, IdError, ModelId, ModelSelection, ProviderId,\n",
    1,
)
for constant in (
    'const WORKFLOW_DECLARATION: &str = "phenix-workflow";\n',
    'const ROUTER_DECLARATION: &str = "phenix-router";\n',
):
    if constant not in text:
        raise RuntimeError(f"obsolete constant not found: {constant.strip()}")
    text = text.replace(constant, "", 1)

start = text.index("impl ParsedDefinition {")
end = text.index("pub fn parse_definition(source: &str)", start)
text = text[:start] + text[end:]

variants = '''    UnexpectedKind {
        expected: DefinitionSourceKind,
        actual: DefinitionSourceKind,
    },
    DuplicateDefinition {
        kind: DefinitionSourceKind,
        id: String,
    },
    Gateway(GatewayError),
'''
if variants not in text:
    raise RuntimeError("obsolete DefinitionSourceError variants not found")
text = text.replace(variants, "", 1)

display_arms = '''            Self::UnexpectedKind { expected, actual } => {
                write!(
                    formatter,
                    "expected {expected} source, found {actual} source"
                )
            }
            Self::DuplicateDefinition { kind, id } => {
                write!(formatter, "duplicate {kind} definition {id}")
            }
            Self::Gateway(error) => Display::fmt(error, formatter),
'''
if display_arms not in text:
    raise RuntimeError("obsolete DefinitionSourceError display arms not found")
text = text.replace(display_arms, "", 1)

error_impl = '''impl Error for DefinitionSourceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Gateway(error) => Some(error),
            _ => None,
        }
    }
}
'''
if error_impl not in text:
    raise RuntimeError("DefinitionSourceError source impl not found")
text = text.replace(error_impl, "impl Error for DefinitionSourceError {}\n", 1)

test_start = text.index(
    "    #[test]\n    fn source_collection_rejects_duplicate_ids_and_wrong_kinds()"
)
module_end = text.rfind("\n}")
if module_end <= test_start:
    raise RuntimeError("source.rs test module boundary not found")
text = text[:test_start] + text[module_end:]
source.write_text(text)
