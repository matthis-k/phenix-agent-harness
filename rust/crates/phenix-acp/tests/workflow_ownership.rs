use phenix_acp::{
    parse_workflow, RoleId, WorkflowCondition, WorkflowJoin, WorkflowStateKind,
};

const IMPLEMENT: &str = include_str!("../../../../config/phenix-harness/workflows/implement.md");
const DEBUG: &str = include_str!("../../../../config/phenix-harness/workflows/debug.md");
const MIGRATE: &str = include_str!("../../../../config/phenix-harness/workflows/migrate.md");
const QA: &str = include_str!("../../../../config/phenix-harness/workflows/qa.md");
const REFACTOR: &str = include_str!("../../../../config/phenix-harness/workflows/refactor.md");
const RESEARCH: &str = include_str!("../../../../config/phenix-harness/workflows/research.md");
const UI_CHANGE: &str = include_str!("../../../../config/phenix-harness/workflows/ui-change.md");
const CONFIG: &str = include_str!("../../../../config/phenix-harness/config.lua");

fn graph(source: &str) -> phenix_acp::WorkflowGraph {
    parse_workflow(source)
        .expect("managed workflow parses")
        .policy_graph()
        .expect("managed workflow has policy graph")
        .clone()
}

#[test]
fn implementation_uses_supplied_plan_as_a_branch_not_an_advisory() {
    let graph = graph(IMPLEMENT);
    assert!(graph.transitions.iter().any(|transition| matches!(
        &transition.when,
        WorkflowCondition::InputExists { path }
            if transition.to == "implement" && path == "plan"
    )));
    assert!(graph.transitions.iter().any(|transition| matches!(
        &transition.when,
        WorkflowCondition::InputMissing { path }
            if transition.to == "plan" && path == "plan"
    )));
}

#[test]
fn debug_has_a_non_mutating_inconclusive_terminal() {
    let graph = graph(DEBUG);
    assert!(graph.transitions.iter().any(|transition| matches!(
        &transition.when,
        WorkflowCondition::OutputEquals { path, value }
            if transition.from == "reproduce"
                && transition.to == "inconclusive"
                && path == "status"
                && value == "inconclusive"
    )));
    let inconclusive = graph
        .states
        .iter()
        .find(|state| state.key == "inconclusive")
        .expect("inconclusive state");
    assert!(matches!(inconclusive.kind, WorkflowStateKind::Return { .. }));
}

#[test]
fn qa_waits_for_settled_evidence_and_marks_optional_reviewers_explicitly() {
    let graph = graph(QA);
    let synthesize = graph
        .states
        .iter()
        .find(|state| state.key == "synthesize")
        .expect("synthesis state");
    assert_eq!(synthesize.join, WorkflowJoin::AllSettled);
    for key in ["architecture", "security"] {
        assert!(!graph
            .states
            .iter()
            .find(|state| state.key == key)
            .expect("optional review state")
            .required);
    }
    for key in ["repository", "tests"] {
        assert!(graph
            .states
            .iter()
            .find(|state| state.key == key)
            .expect("required evidence state")
            .required);
    }
}

#[test]
fn research_classifies_domains_before_spawning_evidence_branches() {
    let graph = graph(RESEARCH);
    for domain in ["repository", "ecosystem", "constraints"] {
        assert!(graph.transitions.iter().any(|transition| matches!(
            &transition.when,
            WorkflowCondition::OutputContains { path, value }
                if transition.from == "classify"
                    && transition.to == domain
                    && path == "domains"
                    && value == domain
        )));
    }
}

#[test]
fn refactor_acceptance_is_independent_from_the_architecture_owner() {
    let graph = graph(REFACTOR);
    let review = graph
        .states
        .iter()
        .find(|state| state.key == "review")
        .expect("review state");
    assert!(matches!(
        &review.kind,
        WorkflowStateKind::Invoke { role, .. }
            if role == &RoleId::parse("critic").expect("critic role")
    ));
}

#[test]
fn specialized_post_implementation_reviews_have_bounded_repair_rechecks() {
    for (name, source) in [
        ("implement", IMPLEMENT),
        ("debug", DEBUG),
        ("migrate", MIGRATE),
        ("refactor", REFACTOR),
        ("ui-change", UI_CHANGE),
    ] {
        let graph = graph(source);
        assert!(
            graph.states.iter().any(|state| state.key.contains("repair")),
            "{name} lacks a repair state"
        );
        assert!(
            graph.states.iter().any(|state| state.key.contains("recheck")),
            "{name} lacks a bounded recheck state"
        );
        assert!(
            graph.states.iter().any(|state| matches!(state.kind, WorkflowStateKind::Fail { .. })),
            "{name} lacks an explicit failure terminal"
        );
    }
}

#[test]
fn review_alias_does_not_register_a_redundant_workflow_node() {
    assert!(!CONFIG.contains("workflows/review.md"));
    assert!(CONFIG.contains("workflows/qa.md"));
}
