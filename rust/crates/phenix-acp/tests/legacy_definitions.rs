use phenix_acp::{
    parse_routing_table, parse_workflow, BackendId, Definitions, Difficulty, RoleId,
    RoutingRequest, SessionRouter, SessionTreeId, ThinkingLevel, Workflow, WorkflowId,
    WorkflowRequest,
};

struct WorkflowFixture {
    id: &'static str,
    source: &'static str,
    roles: &'static [&'static str],
}

const LEGACY_WORKFLOWS: &[WorkflowFixture] = &[
    WorkflowFixture {
        id: "workflow.debug",
        source: include_str!("fixtures/legacy/workflows/debug.md"),
        roles: &["reproducer", "critic", "implementer", "tester", "finalizer"],
    },
    WorkflowFixture {
        id: "workflow.design",
        source: include_str!("fixtures/legacy/workflows/design.md"),
        roles: &["scout", "planner", "architect", "critic", "finalizer"],
    },
    WorkflowFixture {
        id: "workflow.implement",
        source: include_str!("fixtures/legacy/workflows/implement.md"),
        roles: &["difficulty-estimator", "planner", "implementer", "verifier"],
    },
    WorkflowFixture {
        id: "workflow.migrate",
        source: include_str!("fixtures/legacy/workflows/migrate.md"),
        roles: &["scout", "planner", "implementer", "critic", "finalizer"],
    },
    WorkflowFixture {
        id: "workflow.qa",
        source: include_str!("fixtures/legacy/workflows/qa.md"),
        roles: &[
            "coordinator",
            "scout",
            "tester",
            "architect",
            "critic",
            "qa-synthesizer",
        ],
    },
    WorkflowFixture {
        id: "workflow.refactor",
        source: include_str!("fixtures/legacy/workflows/refactor.md"),
        roles: &[
            "scout",
            "architect",
            "implementer",
            "architect",
            "finalizer",
        ],
    },
    WorkflowFixture {
        id: "workflow.research",
        source: include_str!("fixtures/legacy/workflows/research.md"),
        roles: &[
            "coordinator",
            "researcher",
            "researcher",
            "researcher",
            "critic",
            "finalizer",
        ],
    },
    WorkflowFixture {
        id: "workflow.review",
        source: include_str!("fixtures/legacy/workflows/review.md"),
        roles: &["verifier", "qa-synthesizer"],
    },
    WorkflowFixture {
        id: "workflow.security",
        source: include_str!("fixtures/legacy/workflows/security.md"),
        roles: &["scout", "threat-modeler", "critic", "finalizer"],
    },
    WorkflowFixture {
        id: "workflow.ui-change",
        source: include_str!("fixtures/legacy/workflows/ui-change.md"),
        roles: &[
            "scout",
            "architect",
            "implementer",
            "tester",
            "critic",
            "finalizer",
        ],
    },
];

struct RouterFixture {
    id: &'static str,
    source: &'static str,
    role: &'static str,
    provider: &'static str,
    model: &'static str,
}

const LEGACY_ROUTERS: &[RouterFixture] = &[
    RouterFixture {
        id: "router.legacy-free",
        source: include_str!("fixtures/legacy/routing/free.md"),
        role: "implementer",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouterFixture {
        id: "router.legacy-opencode-go",
        source: include_str!("fixtures/legacy/routing/opencode-go.md"),
        role: "implementer",
        provider: "opencode-go",
        model: "kimi-k2.7-code",
    },
    RouterFixture {
        id: "router.legacy-chatgpt-plus",
        source: include_str!("fixtures/legacy/routing/chatgpt-plus.md"),
        role: "architect",
        provider: "openai-codex",
        model: "gpt-5.6",
    },
    RouterFixture {
        id: "router.legacy-mixed",
        source: include_str!("fixtures/legacy/routing/mixed.md"),
        role: "planner",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
];

#[test]
fn legacy_workflow_projections_parse_and_build_plans() {
    let tree_id = SessionTreeId::parse("tree-legacy-workflows").expect("tree id");
    let objective = "migrate the legacy Phenix configuration";
    let mut definitions = Definitions::new();

    for fixture in LEGACY_WORKFLOWS {
        let workflow = parse_workflow(fixture.source)
            .unwrap_or_else(|error| panic!("{} did not parse: {error}", fixture.id));
        assert_eq!(workflow.id().as_str(), fixture.id);
        assert_eq!(
            workflow
                .steps()
                .iter()
                .map(|step| step.role().as_str())
                .collect::<Vec<_>>(),
            fixture.roles,
            "{} role projection changed",
            fixture.id
        );

        let plan = workflow
            .plan(&WorkflowRequest {
                tree_id: tree_id.clone(),
                objective: objective.to_owned(),
            })
            .unwrap_or_else(|error| panic!("{} did not build a plan: {error}", fixture.id));
        assert_eq!(plan.steps.len(), fixture.roles.len());
        assert!(plan.steps.iter().all(|step| {
            step.objective.contains(objective) && !step.objective.contains("{objective}")
        }));

        definitions
            .add_workflow(fixture.source)
            .unwrap_or_else(|error| panic!("{} did not register: {error}", fixture.id));
    }

    assert_eq!(definitions.workflows().count(), LEGACY_WORKFLOWS.len());
}

#[test]
fn migrated_routers_select_complete_model_configs_for_each_difficulty() {
    let tree_id = SessionTreeId::parse("tree-legacy-routing").expect("tree id");
    let pi = BackendId::parse("pi").expect("backend id");
    let workflow = WorkflowId::parse("workflow.implement").expect("workflow id");
    let mut definitions = Definitions::new();

    for fixture in LEGACY_ROUTERS {
        let router = parse_routing_table(fixture.source)
            .unwrap_or_else(|error| panic!("{} did not parse: {error}", fixture.id));
        assert_eq!(router.id().as_str(), fixture.id);

        for (difficulty, thinking) in [
            (Difficulty::D0, ThinkingLevel::Minimal),
            (Difficulty::D1, ThinkingLevel::Low),
            (Difficulty::D2, ThinkingLevel::Medium),
            (Difficulty::D3, ThinkingLevel::High),
            (Difficulty::D4, ThinkingLevel::Max),
        ] {
            let decision = router
                .route(&RoutingRequest {
                    tree_id: tree_id.clone(),
                    parent_node: None,
                    role: RoleId::parse(fixture.role).expect("role id"),
                    difficulty,
                    objective: "route a legacy delegated session".to_owned(),
                    workflow: Some(workflow.clone()),
                    available_backends: vec![pi.clone()],
                })
                .unwrap_or_else(|error| {
                    panic!(
                        "{} failed to route role {} at {difficulty}: {error}",
                        fixture.id, fixture.role
                    )
                });
            assert_eq!(decision.difficulty, difficulty);
            assert_eq!(decision.model.backend.as_str(), "pi");
            assert_eq!(decision.model.provider.as_str(), fixture.provider);
            assert_eq!(decision.model.model.as_str(), fixture.model);
            assert_eq!(decision.model.thinking, thinking);
        }

        let unavailable = router.route(&RoutingRequest {
            tree_id: tree_id.clone(),
            parent_node: None,
            role: RoleId::parse(fixture.role).expect("role id"),
            difficulty: Difficulty::D2,
            objective: "reject the wrong backend".to_owned(),
            workflow: Some(workflow.clone()),
            available_backends: vec![BackendId::parse("other").expect("backend id")],
        });
        assert!(
            unavailable.is_err(),
            "{} accepted an unavailable backend",
            fixture.id
        );

        definitions
            .add_routing_table(fixture.source)
            .unwrap_or_else(|error| panic!("{} did not register: {error}", fixture.id));
    }

    assert_eq!(definitions.routing_tables().count(), LEGACY_ROUTERS.len());
}
