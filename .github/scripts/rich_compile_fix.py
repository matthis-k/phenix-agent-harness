from pathlib import Path

terminal = Path("rust/crates/phenix-tui/src/terminal_media.rs")
text = terminal.read_text()
old = "            backend.flush()?;"
new = "            ratatui::backend::Backend::flush(&mut backend)?;"
if old not in text:
    raise SystemExit("terminal media flush call not found")
terminal.write_text(text.replace(old, new, 1))

source = Path("rust/crates/phenix-acp/src/source.rs")
text = source.read_text()
old_test = '''    #[test]
    fn source_collection_rejects_duplicate_ids_and_wrong_kinds() {
        let mut sources = DefinitionSources::new();
        sources.add_workflow(WORKFLOW).expect("workflow");
        assert!(matches!(
            sources.add_workflow(WORKFLOW),
            Err(DefinitionSourceError::DuplicateDefinition { .. })
        ));
        assert!(matches!(
            sources.add_workflow(ROUTER),
            Err(DefinitionSourceError::UnexpectedKind { .. })
        ));
    }
'''
if old_test not in text:
    raise SystemExit("stale DefinitionSources test not found")
source.write_text(text.replace(old_test, "", 1))
