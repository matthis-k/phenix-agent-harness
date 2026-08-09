phenix.acp.configure({
  definition_id = "phenix.harness",
  router = "router.legacy-mixed",
  standard_session = {
    role = "coordinator",
    difficulty = "d2",
    objective = "Interactive Phenix session tree",
  },
})

phenix.acp.backend({
  id = "pi",
  command = "pi-acp",
})

-- Core engineering flow. Base role contracts are documented in BASE_AGENTS.md;
-- each workflow specializes those reusable roles with a bounded objective.
phenix.acp.workflow("workflows/grill-with-docs.md")
phenix.acp.workflow("workflows/spec.md")
phenix.acp.workflow("workflows/tickets.md")
phenix.acp.workflow("workflows/tdd.md")
phenix.acp.workflow("workflows/implement.md")
phenix.acp.workflow("workflows/review.md")
phenix.acp.workflow("workflows/debug.md")
phenix.acp.workflow("workflows/domain-model.md")
phenix.acp.workflow("workflows/architecture.md")
phenix.acp.workflow("workflows/wayfinder.md")

-- Existing specialized workflows remain available for direct use.
phenix.acp.workflow("workflows/design.md")
phenix.acp.workflow("workflows/migrate.md")
phenix.acp.workflow("workflows/qa.md")
phenix.acp.workflow("workflows/refactor.md")
phenix.acp.workflow("workflows/research.md")
phenix.acp.workflow("workflows/security.md")
phenix.acp.workflow("workflows/ui-change.md")

phenix.acp.routing_table("routing/free.md")
phenix.acp.routing_table("routing/opencode-go.md")
phenix.acp.routing_table("routing/chatgpt-plus.md")
phenix.acp.routing_table("routing/mixed.md")
