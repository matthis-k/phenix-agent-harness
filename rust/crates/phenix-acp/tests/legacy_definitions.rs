use phenix_acp::{
    parse_routing_table, parse_workflow, BackendId, Definitions, RoleId, RoutingRequest,
    SessionRouter, SessionTreeId, Workflow, WorkflowId, WorkflowRequest,
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

struct RouteExpectation {
    role: &'static str,
    provider: &'static str,
    model: &'static str,
}

struct RouterFixture {
    id: &'static str,
    source: &'static str,
    routes: &'static [RouteExpectation],
}

const FREE_ROUTES: &[RouteExpectation] = &[
    RouteExpectation {
        role: "scout",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "planner",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "architect",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "implementer",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "tester",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "verifier",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "critic",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "finalizer",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "qa-synthesizer",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
    RouteExpectation {
        role: "reproducer",
        provider: "opencode",
        model: "deepseek-v4-flash-free",
    },
];

const GO_ROUTES: &[RouteExpectation] = &[
    RouteExpectation {
        role: "scout",
        provider: "opencode-go",
        model: "mimo-v2.5",
    },
    RouteExpectation {
        role: "planner",
        provider: "opencode-go",
        model: "glm-5.1",
    },
    RouteExpectation {
        role: "architect",
        provider: "opencode-go",
        model: "glm-5.2",
    },
    RouteExpectation {
        role: "implementer",
        provider: "opencode-go",
        model: "kimi-k2.7-code",
    },
    RouteExpectation {
        role: "tester",
        provider: "opencode-go",
        model: "kimi-k2.6",
    },
    RouteExpectation {
        role: "verifier",
        provider: "opencode-go",
        model: "qwen3.7-max",
    },
    RouteExpectation {
        role: "critic",
        provider: "opencode-go",
        model: "qwen3.7-max",
    },
    RouteExpectation {
        role: "finalizer",
        provider: "opencode-go",
        model: "qwen3.7-plus",
    },
    RouteExpectation {
        role: "qa-synthesizer",
        provider: "opencode-go",
        model: "qwen3.7-max",
    },
    RouteExpectation {
        role: "reproducer",
        provider: "opencode-go",
        model: "qwen3.7-plus",
    },
];

const GPT_ROUTES: &[RouteExpectation] = &[
    RouteExpectation {
        role: "scout",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
    },
    RouteExpectation {
        role: "planner",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "architect",
        provider: "openai-codex",
        model: "gpt-5.6",
    },
    RouteExpectation {
        role: "implementer",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "tester",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
    },
    RouteExpectation {
        role: "verifier",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "critic",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "finalizer",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "qa-synthesizer",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "reproducer",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
];

const MIXED_ROUTES: &[RouteExpectation] = &[
    RouteExpectation {
        role: "scout",
        provider: "opencode-go",
        model: "mimo-v2.5",
    },
    RouteExpectation {
        role: "planner",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "architect",
        provider: "openai-codex",
        model: "gpt-5.6",
    },
    RouteExpectation {
        role: "implementer",
        provider: "opencode-go",
        model: "kimi-k2.7-code",
    },
    RouteExpectation {
        role: "tester",
        provider: "opencode-go",
        model: "kimi-k2.6",
    },
    RouteExpectation {
        role: "verifier",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "critic",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "finalizer",
        provider: "opencode-go",
        model: "qwen3.7-plus",
    },
    RouteExpectation {
        role: "qa-synthesizer",
        provider: "openai-codex",
        model: "gpt-5.6-terra",
    },
    RouteExpectation {
        role: "reproducer",
        provider: "opencode-go",
        model: "qwen3.7-plus",
    },
];

const LEGACY_ROUTERS: &[RouterFixture] = &[
    RouterFixture {
        id: "router.legacy-free",
        source: include_str!("fixtures/legacy/routing/free.md"),
        routes: FREE_ROUTES,
    },
    RouterFixture {
        id: "router.legacy-opencode-go",
        source: include_str!("fixtures/legacy/routing/opencode-go.md"),
        routes: GO_ROUTES,
    },
    RouterFixture {
        id: "router.legacy-chatgpt-plus",
        source: include_str!("fixtures/legacy/routing/chatgpt-plus.md"),
        routes: GPT_ROUTES,
    },
    RouterFixture {
        id: "router.legacy-mixed",
        source: include_str!("fixtures/legacy/routing/mixed.md"),
        routes: MIXED_ROUTES,
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
fn legacy_model_set_routers_parse_and_route_to_expected_targets() {
    let tree_id = SessionTreeId::parse("tree-legacy-routing").expect("tree id");
    let pi = BackendId::parse("pi").expect("backend id");
    let workflow = WorkflowId::parse("workflow.implement").expect("workflow id");
    let mut definitions = Definitions::new();

    for fixture in LEGACY_ROUTERS {
        let router = parse_routing_table(fixture.source)
            .unwrap_or_else(|error| panic!("{} did not parse: {error}", fixture.id));
        assert_eq!(router.id().as_str(), fixture.id);

        for expected in fixture.routes {
            let decision = router
                .route(&RoutingRequest {
                    tree_id: tree_id.clone(),
                    parent_node: None,
                    role: RoleId::parse(expected.role).expect("role id"),
                    objective: "route a legacy delegated session".to_owned(),
                    workflow: Some(workflow.clone()),
                    available_backends: vec![pi.clone()],
                })
                .unwrap_or_else(|error| {
                    panic!(
                        "{} failed to route role {}: {error}",
                        fixture.id, expected.role
                    )
                });
            assert_eq!(decision.backend.as_str(), "pi");
            let model = decision.model.expect("legacy route must select a model");
            assert_eq!(model.provider.as_str(), expected.provider);
            assert_eq!(model.model.as_str(), expected.model);
        }

        let unavailable = router.route(&RoutingRequest {
            tree_id: tree_id.clone(),
            parent_node: None,
            role: RoleId::parse("implementer").expect("role id"),
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
