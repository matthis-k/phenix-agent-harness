/**
 * Phenix QA — Repository guidance discovery.
 *
 * Discovers project-native commands and guidance documents.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryGuidance } from "./types.ts";

/**
 * Discover repository guidance from well-known locations.
 */
export function discoverGuidance(cwd: string): RepositoryGuidance {
  const guidanceRoot = findProjectRoot(cwd);

  const packageManagers = discoverFileMarkers(guidanceRoot, {
    "package.json": "npm",
    "Cargo.toml": "cargo",
    "pyproject.toml": "python",
    Makefile: "make",
    justfile: "just",
    "flake.nix": "nix",
    "go.mod": "go",
  });

  const buildCommands: string[] = [];
  const testCommands: string[] = [];
  const lintCommands: string[] = [];
  const formatCheckCommands: string[] = [];

  try {
    const pkgPath = join(guidanceRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command !== "string") continue;
        if (/^(build|compile|prepare|prepack)/.test(name)) {
          buildCommands.push(`npm run ${name}`);
        } else if (/^test/.test(name) || name === "spec") {
          testCommands.push(`npm run ${name}`);
        } else if (/^lint/.test(name)) {
          lintCommands.push(`npm run ${name}`);
        } else if (/^format/.test(name) || /check-format/.test(name) || /^prettier/.test(name)) {
          formatCheckCommands.push(`npm run ${name}`);
        }
      }
    }
  } catch {
    // No package.json or unparseable.
  }

  const hasFlake = existsSync(join(guidanceRoot, "flake.nix"));
  const hasDevenvTasks = ["maintenance.nix", "devenv.nix", "devenv.yaml"].some((name) =>
    existsSync(join(guidanceRoot, name)),
  );
  if (hasFlake && hasDevenvTasks) {
    testCommands.push("nix develop -c devenv test");
  }

  const guidanceDocs: string[] = [];
  const architectureDocs: string[] = [];
  const guidanceNames = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "DEVELOPMENT.md",
    "README.md",
  ];

  for (const name of guidanceNames) {
    const candidate = join(guidanceRoot, name);
    if (existsSync(candidate)) {
      guidanceDocs.push(candidate);
    }
  }

  const docsDir = join(guidanceRoot, "docs");
  const archDir = join(guidanceRoot, "docs", "architecture");

  if (existsSync(docsDir)) {
    try {
      for (const entry of readdirSync(docsDir)) {
        const fullPath = join(docsDir, entry);
        if (/architecture|design|adr|decision/i.test(entry)) {
          architectureDocs.push(fullPath);
        }
      }
    } catch {
      // Can't read docs dir.
    }
  }

  if (existsSync(archDir)) {
    try {
      for (const entry of readdirSync(archDir)) {
        architectureDocs.push(join(archDir, entry));
      }
    } catch {
      // Can't read architecture dir.
    }
  }

  return {
    cwd,
    projectRoot: guidanceRoot,
    packageManagers,
    buildCommands: [...new Set(buildCommands)],
    testCommands: [...new Set(testCommands)],
    lintCommands: [...new Set(lintCommands)],
    formatCheckCommands: [...new Set(formatCheckCommands)],
    guidanceDocs,
    architectureDocs,
  };
}

/**
 * Walk up from cwd to find the project root.
 */
export function findProjectRoot(cwd: string): string {
  let current = cwd;

  for (let i = 0; i < 20; i++) {
    if (
      existsSync(join(current, ".git")) ||
      existsSync(join(current, "flake.nix")) ||
      existsSync(join(current, "package.json")) ||
      existsSync(join(current, "Cargo.toml"))
    ) {
      return current;
    }

    const parent = join(current, "..");
    if (parent === current) break;
    current = parent;
  }

  return cwd;
}

function discoverFileMarkers(root: string, markers: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [file, label] of Object.entries(markers)) {
    if (existsSync(join(root, file))) {
      found.push(label);
    }
  }
  return found;
}
