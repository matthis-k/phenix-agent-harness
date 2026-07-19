import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, "../packages");

function readTsFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readTsFiles(full));
    if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function moduleSpecifiers(file: string): readonly string[] {
  const source = fs.readFileSync(file, "utf-8");
  const specifiers = new Set<string>();
  const declarationPattern = /^\s*(?:import|export)\b[\s\S]*?;\s*$/gm;
  const dynamicImportPattern = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(declarationPattern)) {
    const declaration = match[0];
    const specifier = declaration.match(/(?:from\s+)?["']([^"']+)["']\s*;\s*$/)?.[1];
    if (specifier) specifiers.add(specifier);
  }

  for (const match of source.matchAll(dynamicImportPattern)) {
    if (match[1]) specifiers.add(match[1]);
  }

  return [...specifiers];
}

function assertNoPackageDependencies(packageName: string, forbidden: readonly string[]): void {
  for (const file of readTsFiles(path.join(packageDir, packageName))) {
    for (const specifier of moduleSpecifiers(file)) {
      assert.equal(
        forbidden.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`)),
        false,
        `${path.relative(packageDir, file)} must not import ${specifier}`,
      );
    }
  }
}

describe("published Phenix package boundaries", () => {
  it("keeps kernel independent from all higher-level frameworks", () => {
    assertNoPackageDependencies("phenix-kernel", [
      "@matthis-k/phenix-flow",
      "@matthis-k/phenix-routing",
      "@matthis-k/phenix-contracts",
      "@matthis-k/phenix-suite",
    ]);
  });

  it("keeps contracts independent from flow, routing, and suite", () => {
    assertNoPackageDependencies("phenix-contracts", [
      "@matthis-k/phenix-flow",
      "@matthis-k/phenix-routing",
      "@matthis-k/phenix-suite",
    ]);
  });

  it("keeps flow independent from routing, contracts, and suite defaults", () => {
    assertNoPackageDependencies("phenix-flow", [
      "@matthis-k/phenix-routing",
      "@matthis-k/phenix-contracts",
      "@matthis-k/phenix-suite",
    ]);
  });

  it("keeps routing independent from flow, contracts, and suite", () => {
    assertNoPackageDependencies("phenix-routing", [
      "@matthis-k/phenix-flow",
      "@matthis-k/phenix-contracts",
      "@matthis-k/phenix-suite",
    ]);
  });
});
