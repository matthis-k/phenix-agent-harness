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
  id = "Phenix",
  command = "phenix-conductor runtime",
})

-- Shared base agents. Native Phenix workflows and Matt-inspired procedures use
-- the same role vocabulary. Procedures add graph structure, not another agent
-- taxonomy or embedded model policy.
local agents = {
  coordinator = {
    role = "coordinator",
    contract = "Coordinate bounded specialist work and preserve explicit decisions without editing the codebase.",
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
    contract = "Own bounded code, test, and instrumentation mutations needed to satisfy the settled objective.",
  },
  tester = {
    role = "tester",
    contract = "Act as a read-only evidence analyst: run existing feedback, reproduce behavior, and distinguish observations from hypotheses without editing files.",
  },
  critic = {
    role = "critic",
    contract = "Challenge engineering quality, architecture, and evidence independently without editing the codebase.",
  },
  verifier = {
    role = "verifier",
    contract = "Verify conformance to requested behavior and acceptance evidence independently without editing the codebase.",
  },
  finalizer = {
    role = "finalizer",
    contract = "Synthesize established evidence without inventing new findings or editing implementation files.",
  },
  qa_synthesizer = {
    role = "qa-synthesizer",
    contract = "Synthesize independent QA evidence while preserving provenance and disagreement without editing implementation files.",
  },
}

local function step(key, parent, agent, task)
  return {
    key = key,
    parent = parent,
    role = agent.role,
    objective = agent.contract .. " " .. task .. " for {objective}",
  }
end

local function workflow(id, title, steps)
  phenix.acp.workflow({
    id = id,
    title = title,
    steps = steps,
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

-- Native Phenix workflow library. These are the current first-class versions
-- of the pre-ACP workflow catalog, expressed through the Lua authoring API.
workflow("workflow.implement", "Phenix implementation", {
  step("plan", nil, agents.planner, "Produce the minimum executable plan appropriate to the selected difficulty"),
  step("implement", "plan", agents.implementer, "Apply the plan using existing abstractions and keep the change bounded"),
  step("verify", "implement", agents.verifier, "Independently verify requested behavior, deterministic checks, and relevant regressions"),
})

workflow("workflow.qa", "Phenix QA", qa_review_steps())

local qa_fix_steps = qa_review_steps()
qa_fix_steps[#qa_fix_steps + 1] = step(
  "repair-plan",
  "synthesize",
  agents.planner,
  "Turn actionable QA findings into a bounded repair plan and keep the plan empty when there is nothing to fix"
)
qa_fix_steps[#qa_fix_steps + 1] = step(
  "repair",
  "repair-plan",
  agents.implementer,
  "Apply only actionable repairs justified by the QA report"
)
qa_fix_steps[#qa_fix_steps + 1] = step(
  "verify-repair",
  "repair",
  agents.verifier,
  "Verify repaired findings independently and guard against regressions"
)
qa_fix_steps[#qa_fix_steps + 1] = step(
  "finalize",
  "verify-repair",
  agents.finalizer,
  "Produce the final QA-and-fix handoff with evidence and unresolved findings"
)
workflow("workflow.qa-fix", "Phenix QA and fix", qa_fix_steps)

workflow("workflow.design", "Phenix design", {
  step("inspect", nil, agents.scout, "Inspect requirements, constraints, and reusable mechanisms"),
  step("alternatives", "inspect", agents.planner, "Develop viable alternatives and an executable decision plan"),
  step("architecture", "alternatives", agents.architect, "Evaluate ownership, interfaces, data flow, and invariants"),
  step("critique", "architecture", agents.critic, "Challenge assumptions, tradeoffs, and failure modes"),
  step("finalize", "critique", agents.finalizer, "Produce the decision-oriented design handoff"),
})

workflow("workflow.migrate", "Phenix migration", {
  step("inventory", nil, agents.scout, "Inventory contracts, providers, consumers, and compatibility surfaces affected by the migration"),
  step("plan", "inventory", agents.planner, "Produce an ordered migration plan with explicit expand-migrate-contract boundaries where required"),
  step("implement", "plan", agents.implementer, "Execute the migration and remove superseded paths when consumers have moved"),
  step("audit", "implement", agents.critic, "Audit migrated consumers, obsolete interfaces, duplication, and migration containment"),
  step("finalize", "audit", agents.finalizer, "Produce the migration handoff and remaining follow-ups"),
})

workflow("workflow.refactor", "Phenix refactor", {
  step("characterize", nil, agents.scout, "Capture public behavior, invariants, existing tests, and dependency shape before structural change"),
  step("architecture", "characterize", agents.architect, "Define intended ownership, module boundaries, and dependency direction"),
  step("implement", "architecture", agents.implementer, "Apply the behavior-preserving refactor and remove obsolete duplication"),
  step("review", "implement", agents.critic, "Review architecture, semantic preservation, and whether the refactor actually reduces complexity"),
  step("finalize", "review", agents.finalizer, "Produce the refactor handoff with behavioral evidence"),
})

workflow("workflow.security", "Phenix security review", {
  step("surface", nil, agents.scout, "Map entry points, assets, privilege boundaries, and externally controlled data"),
  step("threat-model", "surface", agents.architect, "Model ownership, trust boundaries, abuse paths, and security invariants"),
  step("adversarial", "threat-model", agents.critic, "Validate concrete security risks adversarially and reject speculative findings without evidence"),
  step("finalize", "adversarial", agents.finalizer, "Produce the evidence-backed security handoff"),
})

workflow("workflow.ui-change", "Phenix UI change", {
  step("inspect", nil, agents.scout, "Inspect interaction, rendering, focus, input, and state-update paths"),
  step("design", "inspect", agents.architect, "Specify layout, focus, input, feedback, and update invariants before implementation"),
  step("implement", "design", agents.implementer, "Implement the UI change using the highest appropriate existing UI abstractions"),
  step("scenarios", "implement", agents.tester, "Exercise existing framework-appropriate UI scenarios and interaction regressions"),
  step("critique", "scenarios", agents.critic, "Review interaction quality, predictability, hierarchy, and state consistency"),
  step("finalize", "critique", agents.finalizer, "Produce the UI change handoff with scenario evidence"),
})

-- Overlapping native workflows use the strongest structures from Matt Pocock's
-- skills while retaining Phenix roles, routing, and workflow ownership.
workflow("workflow.debug", "Evidence-driven diagnosis", {
  step("reproduce", nil, agents.tester, "Reproduce the failure with the narrowest existing feedback path and capture the exact observable evidence"),
  step("minimize", "reproduce", agents.tester, "Derive the smallest reproducing scenario without editing production or test files"),
  step("hypothesize", "minimize", agents.critic, "Rank falsifiable root-cause hypotheses and state the evidence that would discriminate them"),
  step("instrument-plan", "hypothesize", agents.tester, "Design the narrowest diagnostic experiment or instrumentation needed to discriminate the leading hypotheses"),
  step("instrument", "instrument-plan", agents.implementer, "Add only the bounded diagnostic instrumentation or harness change required by the experiment"),
  step("evidence", "instrument", agents.tester, "Run the diagnostic experiment and determine which hypotheses the resulting evidence supports or rejects"),
  step("fix", "evidence", agents.implementer, "Remove temporary diagnostics as appropriate and apply the smallest root-cause repair justified by the evidence"),
  step("regression", "fix", agents.verifier, "Re-run the reproducer and relevant regressions and verify durable regression coverage exists where appropriate"),
  step("finalize", "regression", agents.finalizer, "Summarize reproduction, causal evidence, repair, and residual uncertainty"),
})

workflow("workflow.review", "Independent code review", {
  step("standards", nil, agents.critic, "Review only engineering quality, architecture, maintainability, correctness risks, tests, and duplication"),
  step("spec", nil, agents.verifier, "Review only conformance to the stated request, specification, and acceptance criteria"),
})

workflow("workflow.research", "Source-oriented research", {
  step("repository", nil, agents.scout, "Investigate repository code, tests, documentation, and history"),
  step("ecosystem", nil, agents.scout, "Investigate authoritative upstream documentation, specifications, releases, and prior art"),
  step("constraints", nil, agents.scout, "Investigate risks, constraints, edge cases, and counterexamples"),
  step("challenge", "constraints", agents.critic, "Challenge contradictions, source quality, unsupported conclusions, and missing counterevidence"),
  step("finalize", "challenge", agents.finalizer, "Produce a source-oriented handoff separating facts, inferences, disagreement, and uncertainty"),
})

-- Additional Matt-inspired procedures. They add useful engineering structure
-- without creating workflow-specific agents.
workflow("workflow.grill", "Alignment grilling", {
  step("inspect", nil, agents.scout, "Resolve questions already answered by code, tests, documentation, and existing decisions"),
  step("grill", "inspect", agents.coordinator, "Stress-test one unresolved decision at a time and keep prerequisite decisions ordered"),
  step("model", "grill", agents.architect, "Normalize settled vocabulary and identify only durable architectural decisions"),
  step("record", "model", agents.finalizer, "Produce the durable decision and context handoff without implementing the feature"),
})

workflow("workflow.spec", "Specification synthesis", {
  step("context", nil, agents.scout, "Recover settled intent, project vocabulary, constraints, and existing behavior"),
  step("seams", "context", agents.architect, "Identify the highest stable implementation and acceptance seams"),
  step("spec", "seams", agents.planner, "Write an implementation-independent specification with invariants, acceptance criteria, and non-goals"),
  step("verify", "spec", agents.verifier, "Verify the specification is grounded, testable, and free of invented product decisions"),
})

workflow("workflow.tickets", "Tracer-bullet decomposition", {
  step("prefactor", nil, agents.architect, "Identify prerequisite structural changes that make the implementation easy before making the easy change"),
  step("slice", "prefactor", agents.planner, "Decompose work into independently verifiable vertical slices with explicit blocking edges"),
  step("challenge", "slice", agents.critic, "Reject needless fragmentation, oversized tickets, and horizontal slicing unless migration requires it"),
  step("publish", "challenge", agents.finalizer, "Produce the blocker-first ticket frontier with acceptance evidence and dependencies"),
})

workflow("workflow.tdd", "Test-driven development", {
  step("red-plan", nil, agents.tester, "Identify the smallest durable test seam, expected assertion, and intended failing reason without editing files"),
  step("red", "red-plan", agents.implementer, "Add the focused regression test and prove it fails for the intended missing behavior before changing production behavior"),
  step("green", "red", agents.implementer, "Make the smallest coherent production change that turns the focused test green without weakening the test"),
  step("refactor", "green", agents.implementer, "Improve boundaries and remove duplication while keeping focused feedback green"),
  step("verify", "refactor", agents.verifier, "Run focused and surrounding validation and verify requested behavior without regression"),
})

workflow("workflow.architecture", "Architecture deepening", {
  step("inspect", nil, agents.scout, "Map concrete code paths, abstractions, duplicated knowledge, naming, and dependency direction"),
  step("model", "inspect", agents.architect, "Find opportunities to deepen modules, reduce exposed concepts, and reuse stronger existing abstractions"),
  step("challenge", "model", agents.critic, "Challenge migration cost, accidental abstraction, coupling, and whether the proposal actually simplifies the system"),
  step("plan", "challenge", agents.planner, "Produce a prioritized architecture plan with tradeoffs, migration containment, and validation seams"),
})

workflow("workflow.domain-model", "Domain modeling", {
  step("discover", nil, agents.scout, "Collect terminology, entities, operations, invariants, and contradictory names from code and documentation"),
  step("model", "discover", agents.architect, "Choose canonical terms and define their semantic boundaries and relationships"),
  step("challenge", "model", agents.critic, "Reject aliases, overloaded terms, and abstractions that do not reduce conceptual ambiguity"),
  step("publish", "challenge", agents.finalizer, "Produce settled domain vocabulary and unresolved semantic conflicts"),
})

workflow("workflow.wayfinder", "Long-horizon wayfinding", {
  step("recon", nil, agents.scout, "Identify constraints, unknowns, irreversible decisions, dependencies, and available evidence"),
  step("map", "recon", agents.planner, "Build a compact decision and investigation map and identify the current frontier"),
  step("resolve", "map", agents.architect, "Resolve the highest-leverage architecture and domain decisions that evidence can settle"),
  step("verify", "resolve", agents.verifier, "Verify the frontier names remaining uncertainty and is ready for specification and decomposition"),
})

-- Difficulty is first-class routing input. Generic role routes use the requested
-- D0-D4 level; workflow-specific QA rows restore the older Phenix policy of
-- keeping independent review branches on deliberately capable routes.
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

local function append(target, items)
  for _, item in ipairs(items) do
    target[#target + 1] = item
  end
end

local function routing_table(id, title, targets)
  local routes = {}
  append(routes, qa_pins(targets))
  append(routes, {
    route("coordinator", "*", targets.coordinator, "Coordination route"),
    route("scout", "*", targets.scout, "Fast evidence route"),
    route("planner", "*", targets.planner, "Planning route"),
    route("architect", "*", targets.architect, "Architecture route"),
    route("implementer", "*", targets.implementer, "Code route"),
    route("tester", "*", targets.tester, "Testing route"),
    route("verifier", "*", targets.verifier, "Verification route"),
    route("critic", "*", targets.critic, "Independent review route"),
    route("finalizer", "*", targets.finalizer, "Finalization route"),
    route("qa-synthesizer", "*", targets.qa_synthesizer, "QA synthesis route"),
    route("*", "*", targets.fallback, "Fallback route"),
  })
  phenix.acp.routing_table({
    id = id,
    title = title,
    routes = routes,
  })
end

routing_table("router.mixed", "Phenix mixed routing", {
  coordinator = "Phenix/openai-responses/gpt-5.6-terra",
  scout = "Phenix/opencode-go/mimo-v2.5",
  planner = "Phenix/openai-responses/gpt-5.6-terra",
  architect = "Phenix/openai-responses/gpt-5.6",
  implementer = "Phenix/opencode-go/kimi-k2.7-code",
  tester = "Phenix/opencode-go/kimi-k2.6",
  verifier = "Phenix/openai-responses/gpt-5.6-terra",
  critic = "Phenix/openai-responses/gpt-5.6-terra",
  finalizer = "Phenix/opencode-go/qwen3.7-plus",
  qa_synthesizer = "Phenix/openai-responses/gpt-5.6-terra",
  fallback = "Phenix/opencode-go/qwen3.7-plus",
})

routing_table("router.opencode-go", "Phenix OpenCode Go routing", {
  coordinator = "Phenix/opencode-go/glm-5.1",
  scout = "Phenix/opencode-go/mimo-v2.5",
  planner = "Phenix/opencode-go/glm-5.1",
  architect = "Phenix/opencode-go/glm-5.2",
  implementer = "Phenix/opencode-go/kimi-k2.7-code",
  tester = "Phenix/opencode-go/kimi-k2.6",
  verifier = "Phenix/opencode-go/qwen3.7-max",
  critic = "Phenix/opencode-go/qwen3.7-max",
  finalizer = "Phenix/opencode-go/qwen3.7-plus",
  qa_synthesizer = "Phenix/opencode-go/qwen3.7-max",
  fallback = "Phenix/opencode-go/qwen3.7-plus",
})

routing_table("router.chatgpt-plus", "Phenix ChatGPT Plus routing", {
  coordinator = "Phenix/openai-codex/gpt-5.6-terra",
  scout = "Phenix/openai-codex/gpt-5.6-luna",
  planner = "Phenix/openai-codex/gpt-5.6-terra",
  architect = "Phenix/openai-codex/gpt-5.6",
  implementer = "Phenix/openai-codex/gpt-5.6-terra",
  tester = "Phenix/openai-codex/gpt-5.6-luna",
  verifier = "Phenix/openai-codex/gpt-5.6-terra",
  critic = "Phenix/openai-codex/gpt-5.6-terra",
  finalizer = "Phenix/openai-codex/gpt-5.6-terra",
  qa_synthesizer = "Phenix/openai-codex/gpt-5.6-terra",
  fallback = "Phenix/openai-codex/gpt-5.6-terra",
})

routing_table("router.free", "Phenix free routing", {
  coordinator = "Phenix/opencode/deepseek-v4-flash-free",
  scout = "Phenix/opencode/deepseek-v4-flash-free",
  planner = "Phenix/opencode/deepseek-v4-flash-free",
  architect = "Phenix/opencode/deepseek-v4-flash-free",
  implementer = "Phenix/opencode/deepseek-v4-flash-free",
  tester = "Phenix/opencode/deepseek-v4-flash-free",
  verifier = "Phenix/opencode/deepseek-v4-flash-free",
  critic = "Phenix/opencode/deepseek-v4-flash-free",
  finalizer = "Phenix/opencode/deepseek-v4-flash-free",
  qa_synthesizer = "Phenix/opencode/deepseek-v4-flash-free",
  fallback = "Phenix/opencode/deepseek-v4-flash-free",
})
