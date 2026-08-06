from pathlib import Path
import re

path = Path("rust/crates/phenix-acp/tests/legacy_definitions.rs")
source = path.read_text()
replacement = r'''#[test]
fn configured_harness_definitions_remain_parseable() {
    let workflows = [
        ("workflow.debug", include_str!("../../../../config/phenix-harness/workflows/debug.md")),
        ("workflow.design", include_str!("../../../../config/phenix-harness/workflows/design.md")),
        ("workflow.implement", include_str!("../../../../config/phenix-harness/workflows/implement.md")),
        ("workflow.migrate", include_str!("../../../../config/phenix-harness/workflows/migrate.md")),
        ("workflow.qa", include_str!("../../../../config/phenix-harness/workflows/qa.md")),
        ("workflow.refactor", include_str!("../../../../config/phenix-harness/workflows/refactor.md")),
        ("workflow.research", include_str!("../../../../config/phenix-harness/workflows/research.md")),
        ("workflow.review", include_str!("../../../../config/phenix-harness/workflows/review.md")),
        ("workflow.security", include_str!("../../../../config/phenix-harness/workflows/security.md")),
        ("workflow.ui-change", include_str!("../../../../config/phenix-harness/workflows/ui-change.md")),
    ];
    for (expected_id, source) in workflows {
        let workflow = parse_workflow(source).unwrap_or_else(|error| {
            panic!("configured workflow {expected_id} did not parse: {error}")
        });
        assert_eq!(workflow.id().as_str(), expected_id);
    }

    let routing_tables = [
        ("router.legacy-free", include_str!("../../../../config/phenix-harness/routing/free.md")),
        ("router.legacy-opencode-go", include_str!("../../../../config/phenix-harness/routing/opencode-go.md")),
        ("router.legacy-chatgpt-plus", include_str!("../../../../config/phenix-harness/routing/chatgpt-plus.md")),
        ("router.legacy-mixed", include_str!("../../../../config/phenix-harness/routing/mixed.md")),
    ];
    for (expected_id, source) in routing_tables {
        let router = parse_routing_table(source).unwrap_or_else(|error| {
            panic!("configured routing table {expected_id} did not parse: {error}")
        });
        assert_eq!(router.id().as_str(), expected_id);
    }
}
'''
pattern = r'#\[test\]\nfn checked_in_acp_example_definitions_remain_parseable\(\) \{.*\n\}\n\Z'
updated, count = re.subn(pattern, replacement, source, flags=re.DOTALL)
if count != 1:
    raise RuntimeError(f"expected one obsolete configured-definition test, found {count}")
path.write_text(updated)
