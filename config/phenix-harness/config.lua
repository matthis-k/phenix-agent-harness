phenix.acp.configure({
  definition_id = "phenix.harness",
  router = "router.mixed",
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

-- Shared base agents. Workflows compose these roles; Matt-derived workflows
-- add procedure structure rather than introducing a second agent taxonomy.
local agents = {
  coordinator = {
    role = "coordinator",
    contract = "Coordinate bounded specialist work and preserve explicit decisions.",
  },
  scout = {
    role = "scout",
    contract = "Inspect concrete repository and ecosystem evidence without changing code.",
  },
  planner = {
    role = "planner",
    contract = "Convert settled intent into an executable plan without implementing it.",
  },
  architect = {
    role = "architect",
    contract = "Model boundaries, ownership, invariants, and architectural tradeoffs without implementing them.",
  },
  implementer = {
    role = "implementer",
    contract = "Make the smallest coherent code change that satisfies the settled objective.",
  },
  tester = {
    role = "tester",
    contract = "Establish executable feedback and distinguish observations from hypotheses.",
  },
  critic = {
    role = "critic",
    contract = "Challenge engineering quality, architecture, and evidence independently.",
  },
  verifier = {
    role = "verifier",
    contract = "Verify conformance to the requested behavior and acceptance evidence independently.",
  },
  finalizer = {
    role = "finalizer",
    contract = "Synthesize already-established evidence without inventing new findings.",
  },
  qa_synthesizer = {
    role = "qa-synthesizer",
    contract = "Synthesize independent QA evidence while preserving provenance and disagreement.",
  },
}

local function checked_cell(value, label)
  assert(type(value) == "string" and value ~= "", label .. " must be a non-empty string")
  assert(not value:find("[\r\n|]"), label .. " must be a single Markdown-table-safe line")
  return value
end

local function step(key, parent, agent, task)
  checked_cell(key, "workflow step key")
  checked_cell(agent.role, "workflow role")
  checked_cell(agent.contract, "base agent contract")
  checked_cell(task, "workflow task")
  if parent ~= nil then
    checked_cell(parent, "workflow parent")
  end
  return {
    key = key,
    parent = parent,
    role = agent.role,
    objective = agent.contract .. " " .. task .. " for {objective}",
  }
end

local function define_workflow(definition)
  checked_cell(definition.id, "workflow id")
  checked_cell(definition.title, "workflow title")
  assert(type(definition.steps) == "table" and #definition.steps > 0, "workflow requires steps")

  local source = {
    "# " .. definition.title,
    "",
    "```phenix-workflow",
    "id: " .. definition.id,
    "```",
    "",
    "## Steps",
    "",
    "| Key | Parent | Role | Objective |",
    "|---|---|---|---|",
  }

  for _, item in ipairs(definition.steps) do
    local parent = item.parent or ""
    source[#source + 1] = string.format(
      "| `%s` | %s | `%s` | %s |",
      checked_cell(item.key, "workflow step key"),
      checked_cell(parent == "" and "-" or parent, "workflow parent"),
      checked_cell(item.role, "workflow role"),
      checked_cell(item.objective, "workflow objective")
    )
  end

  phenix.acp.workflow({
    source = table.concat(source, "\n"),
    format = "markdown",
  })
end

local function qa_review_steps()
  return {
    step("fanout", nil, agents.coordinator, "Coordinate independent QA branches and keep their evidence separate"),
    step("repository", "fanout", agents.scout, "Review repository structure, correctness, duplication, and integration seams"),
    step("tests", "fanout", agents.tester, "Run or interpret deterministic checks and identify coverage gaps"),
    step("architecture", "fanout", agents.architect, "Review architecture, module boundaries, ownership, and migration containment"),
    step("security", "fanout", agents.critic, "Review trust boundaries, unsafe assumptions, and concrete security risks"),
    step("synthesize", "fanout", agents.qa_synthesizer, "Produce one prioritized QA report from the independent branches"),
  }
end

-- Native Phenix workflow core, restored in the current ACP role/tree model.
-- Difficulty is a typed workflow-start input and is consumed by routing below.
define_workflow({
  id = "workflow.implement",
  title = "Phenix implementation",
  steps = {
    step("plan", nil, agents.planner, "Produce the minimum executable plan appropriate to the selected difficulty"),
    step("implement", "plan", agents.implementer, "Apply the plan using existing abstractions and keep the change bounded"),
    step("verify", "implement", agents.verifier, "Independently verify requested behavior, deterministic checks, and relevant regressions"),
  },
})

define_workflow({
  id = "workflow.qa",
  title = "Phenix QA",
  steps = qa_review_steps(),
})

local qa_fix_steps = qa_review_steps()
qa_fix_steps[#qa_fix_steps + 1] =
  step("repair-plan", "synthesize", agents.planner, "Turn actionable QA findings into a bounded repair plan; keep a no-op plan when there is nothing to fix")
qa_fix_steps[#qa_fix_steps + 1] =
  step("repair", "repair-plan", agents.implementer, "Apply only the actionable QA repairs justified by the report")
qa_fix_steps[#qa_fix_steps + 1] =
  step("verify-repair", "repair", agents.verifier, "Verify each repaired finding and guard against regressions")
qa_fix_steps[#qa_fix_steps + 1] =
  step("finalize", "verify-repair", agents.finalizer, "Produce the final QA-and-fix handoff with evidence and any unresolved findings")
define_workflow({
  id = "workflow.qa-fix",
  title = "Phenix QA and fix",
  steps = qa_fix_steps,
})

-- Matt Pocock inspired procedures translated into Phenix workflow structure.
-- They deliberately reuse the same base agents instead of defining skill-specific agents.
define_workflow({
  id = "workflow.grill",
  title = "Alignment grilling",
  steps = {
    step("inspect", nil, agents.scout, "Resolve questions already answered by code, tests, documentation, and existing decisions"),
    step("grill", "inspect", agents.coordinator, "Stress-test one unresolved decision at a time and keep prerequisite decisions ordered"),
    step("model", "grill", agents.architect, "Normalize settled vocabulary and identify only durable architectural decisions"),
    step("record", "model", agents.finalizer, "Produce the durable decision and context handoff without implementing the feature"),
  },
})

define_workflow({
  id = "workflow.spec",
  title = "Specification synthesis",
  steps = {
    step("context", nil, agents.scout, "Recover settled intent, project vocabulary, constraints, and existing behavior"),
    step("seams", "context", agents.architect, "Identify the highest stable implementation and acceptance seams"),
    step("spec", "seams", agents.planner, "Write an implementation-independent specification with invariants, acceptance criteria, and non-goals"),
    step("verify", "spec", agents.verifier, "Verify the specification is grounded, testable, and free of invented product decisions"),
  },
})

define_workflow({
  id = "workflow.tickets",
  title = "Tracer-bullet decomposition",
  steps = {
    step("prefactor", nil, agents.architect, "Identify prerequisite structural changes that make the implementation easy before making the easy change"),
    step("slice", "prefactor", agents.planner, "Decompose work into independently verifiable vertical slices with explicit blocking edges"),
    step("challenge", "slice", agents.critic, "Reject needless fragmentation, oversized tickets, and horizontal slicing unless migration requires it"),
    step("publish", "challenge", agents.finalizer, "Produce the blocker-first ticket frontier with acceptance evidence and dependencies"),
  },
})

define_workflow({
  id = "workflow.tdd",
  title = "Test-driven development",
  steps = {
    step("red", nil, agents.tester, "Create the smallest durable failing test and prove it fails for the intended missing behavior"),
    step("green", "red", agents.implementer, "Make the smallest coherent implementation that turns the focused test green"),
    step("refactor", "green", agents.implementer, "Improve boundaries and remove duplication while keeping focused feedback green"),
    step("verify", "refactor", agents.verifier, "Run focused and surrounding validation and verify the requested behavior without regression"),
  },
})

define_workflow({
  id = "workflow.debug",
  title = "Evidence-driven diagnosis",
  steps = {
    step("reproduce", nil, agents.tester, "Build the smallest reliable reproducer and capture the exact observable failure"),
    step("minimize", "reproduce", agents.tester, "Minimize the reproducer while preserving the failure"),
    step("hypothesize", "minimize", agents.critic, "Rank falsifiable root-cause hypotheses and state discriminating evidence"),
    step("instrument", "hypothesize", agents.tester, "Run the narrowest experiment needed to discriminate the leading hypotheses"),
    step("fix", "instrument", agents.implementer, "Apply the smallest root-cause repair justified by the evidence"),
    step("regression", "fix", agents.verifier, "Re-run the reproducer and relevant regressions and preserve durable regression coverage"),
    step("finalize", "regression", agents.finalizer, "Summarize reproduction, causal evidence, repair, and residual uncertainty"),
  },
})

define_workflow({
  id = "workflow.review",
  title = "Independent code review",
  steps = {
    step("standards", nil, agents.critic, "Review only engineering quality, architecture, maintainability, correctness risks, tests, and duplication"),
    step("spec", nil, agents.verifier, "Review only conformance to the stated request, specification, and acceptance criteria"),
  },
})

define_workflow({
  id = "workflow.architecture",
  title = "Architecture deepening",
  steps = {
    step("inspect", nil, agents.scout, "Map concrete code paths, abstractions, duplicated knowledge, naming, and dependency direction"),
    step("model", "inspect", agents.architect, "Find opportunities to deepen modules, reduce exposed concepts, and reuse stronger existing abstractions"),
    step("challenge", "model", agents.critic, "Challenge migration cost, accidental abstraction, coupling, and whether the proposal actually simplifies the system"),
    step("plan", "challenge", agents.planner, "Produce a prioritized architecture plan with tradeoffs, migration containment, and validation seams"),
  },
})

define_workflow({
  id = "workflow.domain-model",
  title = "Domain modeling",
  steps = {
    step("discover", nil, agents.scout, "Collect terminology, entities, operations, invariants, and contradictory names from code and documentation"),
    step("model", "discover", agents.architect, "Choose canonical terms and define their semantic boundaries and relationships"),
    step("challenge", "model", agents.critic, "Reject aliases, overloaded terms, and abstractions that do not reduce conceptual ambiguity"),
    step("publish", "challenge", agents.finalizer, "Produce the settled domain vocabulary and unresolved semantic conflicts"),
  },
})

define_workflow({
  id = "workflow.wayfinder",
  title = "Long-horizon wayfinding",
  steps = {
    step("recon", nil, agents.scout, "Identify constraints, unknowns, irreversible decisions, dependencies, and available evidence"),
    step("map", "recon", agents.planner, "Build a compact decision and investigation map and identify the current frontier"),
    step("resolve", "map", agents.architect, "Resolve the highest-leverage architecture and domain decisions that evidence can settle"),
    step("verify", "resolve", agents.verifier, "Verify the frontier names remaining uncertainty and is ready for specification and decomposition"),
  },
})

define_workflow({
  id = "workflow.research",
  title = "Source-oriented research",
  steps = {
    step("repository", nil, agents.scout, "Investigate repository code, tests, documentation, and history"),
    step("ecosystem", nil, agents.scout, "Investigate authoritative upstream documentation, specifications, releases, and prior art"),
    step("constraints", nil, agents.scout, "Investigate risks, constraints, edge cases, and counterexamples"),
    step("challenge", "constraints", agents.critic, "Challenge contradictions, source quality, unsupported conclusions, and missing counterevidence"),
    step("finalize", "challenge", agents.finalizer, "Produce a source-oriented handoff separating facts, inferences, disagreement, and uncertainty"),
  },
})

local function model_routes(target)
  return {
    d0 = target .. "/minimal",
    d1 = target .. "/low",
    d2 = target .. "/medium",
    d3 = target .. "/high",
    d4 = target .. "/max",
  }
end

local function route(role, workflow_id, target, explanation)
  local models = model_routes(target)
  return {
    role = role,
    workflow = workflow_id or "*",
    d0 = models.d0,
    d1 = models.d1,
    d2 = models.d2,
    d3 = models.d3,
    d4 = models.d4,
    explanation = explanation,
  }
end

local function pinned_route(role, workflow_id, target, thinking, explanation)
  local selected = target .. "/" .. thinking
  return {
    role = role,
    workflow = workflow_id,
    d0 = selected,
    d1 = selected,
    d2 = selected,
    d3 = selected,
    d4 = selected,
    explanation = explanation,
  }
end

local function define_routing_table(definition)
  checked_cell(definition.id, "routing table id")
  checked_cell(definition.title, "routing table title")
  assert(type(definition.routes) == "table" and #definition.routes > 0, "routing table requires routes")

  local source = {
    "# " .. definition.title,
    "",
    "```phenix-router",
    "id: " .. definition.id,
    "```",
    "",
    "## Routes",
    "",
    "| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |",
    "|---|---|---|---|---|---|---|---|",
  }

  for _, item in ipairs(definition.routes) do
    source[#source + 1] = string.format(
      "| `%s` | `%s` | `%s` | `%s` | `%s` | `%s` | `%s` | %s |",
      checked_cell(item.role, "route role"),
      checked_cell(item.workflow, "route workflow"),
      checked_cell(item.d0, "route d0"),
      checked_cell(item.d1, "route d1"),
      checked_cell(item.d2, "route d2"),
      checked_cell(item.d3, "route d3"),
      checked_cell(item.d4, "route d4"),
      checked_cell(item.explanation, "route explanation")
    )
  end

  phenix.acp.routing_table({
    source = table.concat(source, "\n"),
    format = "markdown",
  })
end

local function qa_pins(targets)
  return {
    pinned_route("scout", "workflow.qa", targets.scout, "medium", "QA repository review uses a stable D2-class route"),
    pinned_route("tester", "workflow.qa", targets.tester, "medium", "QA test review uses a stable D2-class route"),
    pinned_route("architect", "workflow.qa", targets.architect, "high", "QA architecture review uses a stable D3-class route"),
    pinned_route("critic", "workflow.qa", targets.critic, "high", "QA security review uses a stable D3-class route"),
    pinned_route("qa-synthesizer", "workflow.qa", targets.qa_synthesizer, "high", "QA synthesis uses a stable D3-class route"),
    pinned_route("scout", "workflow.qa-fix", targets.scout, "medium", "QA-fix repository review uses a stable D2-class route"),
    pinned_route("tester", "workflow.qa-fix", targets.tester, "medium", "QA-fix test review uses a stable D2-class route"),
    pinned_route("architect", "workflow.qa-fix", targets.architect, "high", "QA-fix architecture review uses a stable D3-class route"),
    pinned_route("critic", "workflow.qa-fix", targets.critic, "high", "QA-fix security review uses a stable D3-class route"),
    pinned_route("qa-synthesizer", "workflow.qa-fix", targets.qa_synthesizer, "high", "QA-fix synthesis uses a stable D3-class route"),
    pinned_route("verifier", "workflow.qa-fix", targets.verifier, "high", "QA-fix repair verification uses a stable D3-class route"),
  }
end

local function append_routes(target, extra)
  for _, item in ipairs(extra) do
    target[#target + 1] = item
  end
end

local mixed_targets = {
  coordinator = "pi/openai-codex/gpt-5.6-terra",
  scout = "pi/opencode-go/mimo-v2.5",
  planner = "pi/openai-codex/gpt-5.6-terra",
  architect = "pi/openai-codex/gpt-5.6",
  implementer = "pi/opencode-go/kimi-k2.7-code",
  tester = "pi/opencode-go/kimi-k2.6",
  verifier = "pi/openai-codex/gpt-5.6-terra",
  critic = "pi/openai-codex/gpt-5.6-terra",
  finalizer = "pi/opencode-go/qwen3.7-plus",
  qa_synthesizer = "pi/openai-codex/gpt-5.6-terra",
  fallback = "pi/opencode-go/qwen3.7-plus",
}
local mixed_routes = {}
append_routes(mixed_routes, qa_pins(mixed_targets))
append_routes(mixed_routes, {
  route("coordinator", "*", mixed_targets.coordinator, "Coordination route"),
  route("scout", "*", mixed_targets.scout, "Fast evidence route"),
  route("planner", "*", mixed_targets.planner, "Planning route"),
  route("architect", "*", mixed_targets.architect, "Architecture route"),
  route("implementer", "*", mixed_targets.implementer, "Code route"),
  route("tester", "*", mixed_targets.tester, "Testing route"),
  route("verifier", "*", mixed_targets.verifier, "Verification route"),
  route("critic", "*", mixed_targets.critic, "Independent review route"),
  route("finalizer", "*", mixed_targets.finalizer, "Finalization route"),
  route("qa-synthesizer", "*", mixed_targets.qa_synthesizer, "QA synthesis route"),
  route("*", "*", mixed_targets.fallback, "Fallback route"),
})
define_routing_table({
  id = "router.mixed",
  title = "Phenix mixed routing",
  routes = mixed_routes,
})

local opencode_targets = {
  coordinator = "pi/opencode-go/glm-5.1",
  scout = "pi/opencode-go/mimo-v2.5",
  planner = "pi/opencode-go/glm-5.1",
  architect = "pi/opencode-go/glm-5.2",
  implementer = "pi/opencode-go/kimi-k2.7-code",
  tester = "pi/opencode-go/kimi-k2.6",
  verifier = "pi/opencode-go/qwen3.7-max",
  critic = "pi/opencode-go/qwen3.7-max",
  finalizer = "pi/opencode-go/qwen3.7-plus",
  qa_synthesizer = "pi/opencode-go/qwen3.7-max",
  fallback = "pi/opencode-go/qwen3.7-plus",
}
local opencode_routes = {}
append_routes(opencode_routes, qa_pins(opencode_targets))
append_routes(opencode_routes, {
  route("coordinator", "*", opencode_targets.coordinator, "Coordination route"),
  route("scout", "*", opencode_targets.scout, "Fast evidence route"),
  route("planner", "*", opencode_targets.planner, "Planning route"),
  route("architect", "*", opencode_targets.architect, "Architecture route"),
  route("implementer", "*", opencode_targets.implementer, "Code route"),
  route("tester", "*", opencode_targets.tester, "Testing route"),
  route("verifier", "*", opencode_targets.verifier, "Verification route"),
  route("critic", "*", opencode_targets.critic, "Independent review route"),
  route("finalizer", "*", opencode_targets.finalizer, "Finalization route"),
  route("qa-synthesizer", "*", opencode_targets.qa_synthesizer, "QA synthesis route"),
  route("*", "*", opencode_targets.fallback, "Fallback route"),
})
define_routing_table({
  id = "router.opencode-go",
  title = "Phenix OpenCode Go routing",
  routes = opencode_routes,
})

local chatgpt_targets = {
  coordinator = "pi/openai-codex/gpt-5.6-terra",
  scout = "pi/openai-codex/gpt-5.6-luna",
  planner = "pi/openai-codex/gpt-5.6-terra",
  architect = "pi/openai-codex/gpt-5.6",
  implementer = "pi/openai-codex/gpt-5.6-terra",
  tester = "pi/openai-codex/gpt-5.6-luna",
  verifier = "pi/openai-codex/gpt-5.6-terra",
  critic = "pi/openai-codex/gpt-5.6-terra",
  finalizer = "pi/openai-codex/gpt-5.6-terra",
  qa_synthesizer = "pi/openai-codex/gpt-5.6-terra",
  fallback = "pi/openai-codex/gpt-5.6-terra",
}
local chatgpt_routes = {}
append_routes(chatgpt_routes, qa_pins(chatgpt_targets))
append_routes(chatgpt_routes, {
  route("coordinator", "*", chatgpt_targets.coordinator, "Coordination route"),
  route("scout", "*", chatgpt_targets.scout, "Fast evidence route"),
  route("planner", "*", chatgpt_targets.planner, "Planning route"),
  route("architect", "*", chatgpt_targets.architect, "Architecture route"),
  route("implementer", "*", chatgpt_targets.implementer, "Code route"),
  route("tester", "*", chatgpt_targets.tester, "Testing route"),
  route("verifier", "*", chatgpt_targets.verifier, "Verification route"),
  route("critic", "*", chatgpt_targets.critic, "Independent review route"),
  route("finalizer", "*", chatgpt_targets.finalizer, "Finalization route"),
  route("qa-synthesizer", "*", chatgpt_targets.qa_synthesizer, "QA synthesis route"),
  route("*", "*", chatgpt_targets.fallback, "Fallback route"),
})
define_routing_table({
  id = "router.chatgpt-plus",
  title = "Phenix ChatGPT Plus routing",
  routes = chatgpt_routes,
})

local free_targets = {
  coordinator = "pi/opencode/deepseek-v4-flash-free",
  scout = "pi/opencode/deepseek-v4-flash-free",
  planner = "pi/opencode/deepseek-v4-flash-free",
  architect = "pi/opencode/deepseek-v4-flash-free",
  implementer = "pi/opencode/deepseek-v4-flash-free",
  tester = "pi/opencode/deepseek-v4-flash-free",
  verifier = "pi/opencode/deepseek-v4-flash-free",
  critic = "pi/opencode/deepseek-v4-flash-free",
  finalizer = "pi/opencode/deepseek-v4-flash-free",
  qa_synthesizer = "pi/opencode/deepseek-v4-flash-free",
  fallback = "pi/opencode/deepseek-v4-flash-free",
}
local free_routes = {}
append_routes(free_routes, qa_pins(free_targets))
append_routes(free_routes, {
  route("coordinator", "*", free_targets.coordinator, "Coordination route"),
  route("scout", "*", free_targets.scout, "Fast evidence route"),
  route("planner", "*", free_targets.planner, "Planning route"),
  route("architect", "*", free_targets.architect, "Architecture route"),
  route("implementer", "*", free_targets.implementer, "Code route"),
  route("tester", "*", free_targets.tester, "Testing route"),
  route("verifier", "*", free_targets.verifier, "Verification route"),
  route("critic", "*", free_targets.critic, "Independent review route"),
  route("finalizer", "*", free_targets.finalizer, "Finalization route"),
  route("qa-synthesizer", "*", free_targets.qa_synthesizer, "QA synthesis route"),
  route("*", "*", free_targets.fallback, "Fallback route"),
})
define_routing_table({
  id = "router.free",
  title = "Phenix free routing",
  routes = free_routes,
})
