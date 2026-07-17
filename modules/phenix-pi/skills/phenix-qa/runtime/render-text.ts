/**
 * Phenix QA — Text rendering.
 *
 * Produces human-readable QA report output.
 */

import type { QaEvidence, QaFinding, QaReport, RiskAssessment } from "../contracts/contracts.ts";

export function renderTextReport(report: QaReport): string {
  const lines: string[] = [];

  lines.push("=".repeat(72));
  lines.push("  Phenix QA Report");
  lines.push("=".repeat(72));
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Scope: ${report.scope.kind} — ${report.scope.description}`);
  if (report.scope.baseRevision) {
    lines.push(`Base: ${report.scope.baseRevision}`);
  }
  lines.push("");

  // ── Executive Summary ────────────────────────────────────────────────────
  lines.push("─".repeat(72));
  lines.push("  Executive Summary");
  lines.push("─".repeat(72));
  lines.push("");
  lines.push(`Overall Result: ${report.executiveSummary.overallResult}`);

  if (report.executiveSummary.highestRiskLevel) {
    lines.push(`Highest Risk Level: ${report.executiveSummary.highestRiskLevel}`);
  }
  lines.push(`Architecture: ${report.executiveSummary.architectureAssessment}`);
  lines.push(
    `Current Change Increases Debt: ${report.executiveSummary.currentChangeIncreasesDebt}`,
  );

  if (report.executiveSummary.blockingIssues.length > 0) {
    lines.push(`Blocking Issues: ${report.executiveSummary.blockingIssues.length}`);
    for (const id of report.executiveSummary.blockingIssues) {
      const finding = report.findings.find((f) => f.id === id);
      if (finding) {
        lines.push(`  - [${finding.id}] ${finding.title}`);
      }
    }
  }

  lines.push("");
  lines.push(`Analysis Coverage:`);
  const cov = report.executiveSummary.analysisCoverage;
  lines.push(`  Completed: ${cov.completedAnalyzers.join(", ") || "none"}`);
  lines.push(`  Unavailable: ${cov.unavailableAnalyzers.join(", ") || "none"}`);
  lines.push(`  Failed: ${cov.failedAnalyzers.join(", ") || "none"}`);
  lines.push(`  Files: ${cov.coveredFiles}/${cov.totalScopedFiles}`);
  lines.push(`  Languages: ${cov.coveredLanguages.join(", ") || "none"}`);

  // ── Quality Gates ────────────────────────────────────────────────────────
  lines.push("");
  lines.push("─".repeat(72));
  lines.push("  Quality Gates");
  lines.push("─".repeat(72));
  lines.push("");

  const gates = report.qualityGates;
  const gateEntries = [
    gates.correctness,
    gates.changeSafety,
    gates.designConsistency,
    gates.architecture,
    gates.productionReadiness,
  ];

  for (const gate of gateEntries) {
    const icon =
      gate.result === "PASS"
        ? "✓"
        : gate.result === "FAIL"
          ? "✗"
          : gate.result === "REVIEW"
            ? "?"
            : "-";
    lines.push(`  [${icon}] ${gate.name}: ${gate.result}`);
    if (gate.notes) {
      lines.push(`      ${gate.notes}`);
    }
  }

  // ── Findings ─────────────────────────────────────────────────────────────
  lines.push("");
  lines.push("─".repeat(72));
  lines.push("  Findings");
  lines.push("─".repeat(72));
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("  No findings.");
  } else {
    const byLevel = groupBy(report.findings, (f) => f.level);

    for (const [level, findings] of Object.entries(byLevel)) {
      lines.push(`  ${level} (${findings.length} findings)`);
      lines.push(`  ${"~".repeat(60)}`);

      for (const f of findings) {
        const severityIcon =
          f.severity === "critical"
            ? "🔴"
            : f.severity === "high"
              ? "🟠"
              : f.severity === "medium"
                ? "🟡"
                : f.severity === "low"
                  ? "🔵"
                  : "⚪";
        const newTag = f.introducedByCurrentChange === true ? " [NEW]" : "";

        lines.push(`    ${severityIcon} ${f.id}: ${f.title}${newTag}`);
        lines.push(
          `       Severity: ${f.severity} | Confidence: ${f.confidence} | Scope: ${f.remediationScope}`,
        );
        if (f.blocking) {
          lines.push(`       ⚠ BLOCKING`);
        }
        lines.push(`       ${f.explanation}`);
        if (f.impact) {
          lines.push(`       Impact: ${f.impact}`);
        }
        if (f.recommendation) {
          lines.push(`       Recommendation: ${f.recommendation}`);
        }
        if (f.locations.length > 0) {
          for (const loc of f.locations.slice(0, 3)) {
            const lineStr = loc.startLine ? `${loc.path}:${loc.startLine}` : loc.path;
            lines.push(`       Location: ${lineStr}`);
          }
        }
        lines.push("");
      }
    }
  }

  // ── Risk Assessment ──────────────────────────────────────────────────────
  lines.push("─".repeat(72));
  lines.push("  Risk Assessment");
  lines.push("─".repeat(72));
  lines.push("");

  const riskEntries = [
    { label: "Local Complexity", score: report.riskAssessment.complexityRisk },
    { label: "Readability", score: report.riskAssessment.readabilityRisk },
    { label: "Pattern Consistency", score: report.riskAssessment.patternConsistencyRisk },
    { label: "Architecture", score: report.riskAssessment.architectureRisk },
    { label: "System Integration", score: report.riskAssessment.integrationRisk },
    { label: "Operational", score: report.riskAssessment.operationalRisk },
    { label: "Security", score: report.riskAssessment.securityRisk },
    { label: "Change", score: report.riskAssessment.changeRisk },
  ];

  for (const { label, score } of riskEntries) {
    const bar = riskBar(score.value);
    const conf = score.confidence.toUpperCase();
    lines.push(`  ${label.padEnd(22)} ${bar} ${String(score.value).padStart(3)}/100 (${conf})`);
  }

  lines.push("");
  lines.push(`  Composite Score: ${report.riskAssessment.compositeScore}/100`);
  lines.push("");

  // ── Positive Observations ────────────────────────────────────────────────
  if (report.positiveObservations.length > 0) {
    lines.push("─".repeat(72));
    lines.push("  Positive Observations");
    lines.push("─".repeat(72));
    lines.push("");
    for (const obs of report.positiveObservations) {
      lines.push(`  ✓ ${obs}`);
    }
    lines.push("");
  }

  // ── Remediation Plan ─────────────────────────────────────────────────────
  if (report.remediationPlan.length > 0) {
    lines.push("─".repeat(72));
    lines.push("  Remediation Plan");
    lines.push("─".repeat(72));
    lines.push("");

    const sorted = [...report.remediationPlan].sort((a, b) => a.priority - b.priority);
    for (const item of sorted) {
      lines.push(`  ${item.priority}. [${item.category}] ${item.description}`);
      if (item.findingIds.length > 0) {
        lines.push(`     Resolves: ${item.findingIds.join(", ")}`);
      }
    }
    lines.push("");
  }

  // ── Artifacts ────────────────────────────────────────────────────────────
  if (report.rawArtifacts.length > 0) {
    lines.push("─".repeat(72));
    lines.push("  Raw Artifacts");
    lines.push("─".repeat(72));
    lines.push("");
    for (const artifact of report.rawArtifacts) {
      lines.push(`  ${artifact}`);
    }
    lines.push("");
  }

  lines.push("=".repeat(72));
  lines.push("  End of QA Report");
  lines.push("=".repeat(72));

  return lines.join("\n");
}

function riskBar(value: number): string {
  const segments = 10;
  const filled = Math.round((value / 100) * segments);
  return `[${"█".repeat(filled)}${"░".repeat(segments - filled)}]`;
}

function groupBy<T, K extends string>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key]!.push(item);
  }
  return result;
}
