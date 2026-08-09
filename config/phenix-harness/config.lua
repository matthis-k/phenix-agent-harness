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

phenix.acp.workflow("workflows/debug.md")
phenix.acp.workflow("workflows/design.md")
phenix.acp.workflow("workflows/implement.md")
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
