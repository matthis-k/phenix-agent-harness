/**
 * Phenix QA — Evidence normalization.
 *
 * Converts analyzer-specific findings to normalized QaEvidence items.
 */

import type {
  QaEvidence,
  QaLevel,
  EvidenceSource,
  SourceLocation,
  FindingSeverity,
  FindingConfidence,
  RemediationScope,
  QaFinding,
} from "../contracts/contracts.ts";

let nextId = 0;

export function resetIdCounter(start = 0): void {
  nextId = start;
}

export function nextEvidenceId(prefix: string): string {
  return `${prefix}-evidence-${String(++nextId).padStart(4, "0")}`;
}

export function nextFindingId(prefix: string): string {
  return `${prefix}-finding-${String(++nextId).padStart(4, "0")}`;
}

// ── Evidence builders ────────────────────────────────────────────────────────

export function makeEvidence(params: {
  level: QaLevel;
  source: EvidenceSource;
  category: string;
  message: string;
  locations?: readonly SourceLocation[];
  tool?: string;
  ruleId?: string;
  metric?: { name: string; value: number; threshold?: number; unit?: string };
  rawReference?: string;
}): QaEvidence {
  return {
    id: nextEvidenceId(params.source),
    level: params.level,
    source: params.source,
    category: params.category,
    message: params.message,
    locations: params.locations ?? [],
    tool: params.tool,
    ruleId: params.ruleId,
    metric: params.metric,
    rawReference: params.rawReference,
  };
}

// ── Finding builders ─────────────────────────────────────────────────────────

export function makeFinding(params: {
  level: QaLevel;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  explanation: string;
  evidenceIds: readonly string[];
  locations?: readonly SourceLocation[];
  impact: string;
  recommendation: string;
  remediationScope: RemediationScope;
  introducedByCurrentChange?: boolean | "unknown";
  blocking?: boolean;
}): QaFinding {
  return {
    id: nextFindingId("qa"),
    level: params.level,
    severity: params.severity,
    confidence: params.confidence,
    title: params.title,
    explanation: params.explanation,
    evidenceIds: [...params.evidenceIds],
    locations: params.locations ?? [],
    impact: params.impact,
    recommendation: params.recommendation,
    remediationScope: params.remediationScope,
    introducedByCurrentChange: params.introducedByCurrentChange ?? false,
    blocking: params.blocking ?? false,
  };
}

// ── Severity Mapping ─────────────────────────────────────────────────────────

/**
 * Map generic analyzer severity labels to FindingSeverity.
 */
export function mapSeverity(raw: string): FindingSeverity {
  const lower = raw.toLowerCase().trim();
  if (lower === "error" || lower === "critical" || lower === "fatal") return "critical";
  if (lower === "warning" || lower === "high") return "high";
  if (lower === "note" || lower === "medium" || lower === "moderate") return "medium";
  if (lower === "low" || lower === "minor") return "low";
  if (lower === "info" || lower === "information") return "info";
  return "medium";
}

/**
 * Map a metric value to severity based on thresholds.
 */
export function mapMetricToSeverity(
  value: number,
  threshold: number | undefined,
): FindingSeverity {
  if (threshold === undefined) return "info";
  const ratio = value / threshold;
  if (ratio >= 3.0) return "critical";
  if (ratio >= 2.0) return "high";
  if (ratio >= 1.5) return "medium";
  if (ratio >= 1.0) return "low";
  return "info";
}

// ── Location helpers ─────────────────────────────────────────────────────────

export function fileLocation(
  path: string,
  startLine?: number,
  endLine?: number,
  symbol?: string,
): SourceLocation {
  return { path, startLine, endLine, symbol };
}

// ── SARIF normalization ──────────────────────────────────────────────────────

export interface SarifRun {
  tool?: { driver?: { name?: string; version?: string } };
  results?: SarifResult[];
  artifacts?: SarifArtifact[];
}

export interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
}

export interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string; index?: number };
    region?: { startLine?: number; endLine?: number; startColumn?: number };
  };
}

export interface SarifArtifact {
  location?: { uri?: string };
  index?: number;
}

/**
 * Normalize a SARIF run into QaEvidence items.
 */
export function normalizeSarif(
  sarif: SarifRun,
  toolName: string,
  evidenceSource: EvidenceSource,
  evidenceLevel: QaLevel,
): QaEvidence[] {
  const evidence: QaEvidence[] = [];
  const toolVersion = sarif.tool?.driver?.version;
  const artifacts = sarif.artifacts ?? [];

  function resolveUri(index: number): string {
    const artifact = artifacts.find((a) => a.index === index);
    return artifact?.location?.uri ?? "unknown";
  }

  for (const result of sarif.results ?? []) {
    const locations: SourceLocation[] = [];
    for (const loc of result.locations ?? []) {
      const phys = loc.physicalLocation;
      if (!phys) continue;
      const uri =
        phys.artifactLocation?.uri ??
        (phys.artifactLocation?.index !== undefined
          ? resolveUri(phys.artifactLocation.index)
          : "unknown");
      locations.push({
        path: uri,
        startLine: phys.region?.startLine,
        endLine: phys.region?.endLine,
      });
    }

    evidence.push({
      id: nextEvidenceId(evidenceSource),
      level: evidenceLevel,
      source: evidenceSource,
      tool: toolName,
      ruleId: result.ruleId,
      category: result.ruleId ?? "unknown",
      message: result.message?.text ?? "No message",
      locations,
      rawReference: toolVersion,
    });
  }

  return evidence;
}
