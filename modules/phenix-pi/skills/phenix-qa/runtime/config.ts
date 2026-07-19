/**
 * Phenix QA runtime configuration.
 */

import type { QaConfig } from "./types.ts";

export const DEFAULT_QA_CONFIG: QaConfig = {
  enabledAnalyzers: [
    "project-native",
    "metrics",
    "structural",
    "duplication",
    "security",
    "git-history",
  ],

  requiredAnalyzers: ["project-native"],

  timeouts: {
    defaultMs: 120_000,
    byAnalyzer: {
      "project-native": 300_000,
      "git-history": 60_000,
    },
  },

  ignore: {
    paths: [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
      ".nuxt",
      "__pycache__",
      "target",
      ".direnv",
      ".devenv",
      "result",
      "vendor",
    ],
    generatedPaths: ["*.generated.*", "*.gen.*", "*-lock.*", ".git"],
    vendorPaths: ["vendor/", "third_party/"],
  },

  thresholds: {
    cyclomaticComplexity: 20,
    cognitiveComplexity: 25,
    maximumNesting: 4,
    functionLogicalLines: 80,
    fileLogicalLines: 400,
    booleanTerms: 8,
    duplicationPercent: 10,
  },

  structuralRuleDirectories: [],

  output: {
    artifactDirectory: ".phenix-qa",
    writeJson: true,
    writeText: true,
  },
};

/** Merge a partial repository configuration over the supplied defaults. */
export function mergeConfig(defaults: QaConfig, overrides?: Partial<QaConfig>): QaConfig {
  if (!overrides) return defaults;

  return {
    ...defaults,
    ...overrides,
    timeouts: {
      ...defaults.timeouts,
      ...overrides.timeouts,
      byAnalyzer: {
        ...defaults.timeouts.byAnalyzer,
        ...overrides.timeouts?.byAnalyzer,
      },
    },
    ignore: {
      ...defaults.ignore,
      ...overrides.ignore,
    },
    thresholds: {
      ...defaults.thresholds,
      ...overrides.thresholds,
    },
    output: {
      ...defaults.output,
      ...overrides.output,
    },
  };
}

/**
 * Discover repository-local QA configuration.
 *
 * Supported locations, in precedence order:
 * - .phenix-qa.json
 * - .phenix-qa/config.json
 * - the `phenixQa` key in package.json
 */
export async function discoverRepoConfig(
  cwd: string,
  readFile: (path: string) => Promise<string>,
  fileExists: (path: string) => Promise<boolean>,
): Promise<Partial<QaConfig> | undefined> {
  const pathModule = await import("node:path");

  const candidates = [
    pathModule.join(cwd, ".phenix-qa.json"),
    pathModule.join(cwd, ".phenix-qa", "config.json"),
  ];

  for (const candidate of candidates) {
    try {
      if (!(await fileExists(candidate))) continue;
      const raw = await readFile(candidate);
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Continue to the next supported location.
    }
  }

  try {
    const pkgPath = pathModule.join(cwd, "package.json");
    if (!(await fileExists(pkgPath))) return undefined;
    const raw = await readFile(pkgPath);
    const pkg = JSON.parse(raw);
    if (pkg?.phenixQa && typeof pkg.phenixQa === "object") {
      return pkg.phenixQa;
    }
  } catch {
    // No valid package-level configuration.
  }

  return undefined;
}
