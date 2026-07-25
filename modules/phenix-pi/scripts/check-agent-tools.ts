import {
  formatToolAvailabilityIssues,
  inspectToolAvailability,
} from "../adapters/pi-sdk/tool-preflight.ts";
import { agentDefinitions } from "../definitions/agents.ts";

const customTools = [
  "phenix_run",
  "phenix_handle",
  "phenix_present",
  "phenix_tasks",
  "phenix_return",
  "phenix_fail",
  "phenix_progress",
].map((name) => ({ name }));

const failures = agentDefinitions.flatMap((definition) => {
  const issues = inspectToolAvailability({
    tools: definition.tools.allow,
    customTools,
  });
  return issues.length === 0
    ? []
    : [
        {
          definitionId: definition.id,
          message: formatToolAvailabilityIssues(definition.id, issues),
          issues,
        },
      ];
});

if (failures.length > 0) {
  console.error("Agent tool preflight failed:");
  for (const failure of failures) {
    console.error(`- ${failure.message}`);
    console.error(JSON.stringify(failure.issues, null, 2));
  }
  process.exitCode = 1;
} else {
  console.log(`Agent tool preflight passed for ${agentDefinitions.length} definitions.`);
}
