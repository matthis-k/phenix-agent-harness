/**
 * Phenix QA — Analyzer registry.
 *
 * Lists all available analyzer adapters and provides factory functions.
 */

import type { QaAnalyzer } from "./types.ts";

// Analyzer imports
import { PROJECT_NATIVE_ANALYZER } from "./project-native.ts";
import { METRICS_ANALYZER } from "./metrics.ts";
import { STRUCTURAL_ANALYZER } from "./structural.ts";
import { DUPLICATION_ANALYZER } from "./duplication.ts";
import { SECURITY_ANALYZER } from "./security.ts";
import { GIT_HISTORY_ANALYZER } from "./git-history.ts";

/**
 * All registered analyzer adapters.
 */
export const ALL_ANALYZERS: readonly QaAnalyzer[] = [
  PROJECT_NATIVE_ANALYZER,
  METRICS_ANALYZER,
  STRUCTURAL_ANALYZER,
  DUPLICATION_ANALYZER,
  SECURITY_ANALYZER,
  GIT_HISTORY_ANALYZER,
];

/**
 * Get analyzers by IDs, maintaining registration order.
 */
export function getAnalyzers(ids: readonly string[]): QaAnalyzer[] {
  const idSet = new Set(ids);
  return ALL_ANALYZERS.filter((a) => idSet.has(a.id));
}

/**
 * Get a single analyzer by ID.
 */
export function getAnalyzer(id: string): QaAnalyzer | undefined {
  return ALL_ANALYZERS.find((a) => a.id === id);
}

/**
 * List all analyzer IDs.
 */
export function listAnalyzerIds(): readonly string[] {
  return ALL_ANALYZERS.map((a) => a.id);
}

/**
 * List all analyzer categories.
 */
export function listAnalyzerCategories(): readonly string[] {
  return [...new Set(ALL_ANALYZERS.flatMap((a) => [...a.categories]))];
}
