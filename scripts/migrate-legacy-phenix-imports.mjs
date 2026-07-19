import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative } from "node:path";

const root = process.cwd();
const legacyRoot = join(root, "modules", "phenix-pi", "extensions");
const migrationSource = join(root, "scripts", "migrate-legacy-phenix-imports.mjs");
const artifactRoot = "/tmp/phenix-canonical-migration";
const textExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".mts",
  ".nix",
  ".toml",
  ".ts",
  ".yaml",
  ".yml",
]);
const skippedDirectories = new Set([".devenv", ".direnv", ".git", "node_modules", "result"]);

const replacements = [
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-routing\/default-routing\.ts)/g,
    "@matthis-k/phenix-suite/defaults/routing.ts",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-contracts\/default-contracts\.ts)/g,
    "@matthis-k/phenix-suite/defaults/contracts.ts",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-kernel\/)/g,
    "@matthis-k/phenix-kernel/",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-routing\/)/g,
    "@matthis-k/phenix-routing/",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-workflow\/)/g,
    "@matthis-k/phenix-flow/",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-contracts\/)/g,
    "@matthis-k/phenix-contracts/",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-composition\/)/g,
    "@matthis-k/phenix-suite/composition/",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-runtime\/)/g,
    "@matthis-k/phenix-suite/runtime/",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-subagents\/)/g,
    "@matthis-k/phenix-suite/subagents/",
  ],
  [
    /(?:(?:\.\.\/|\.\/)*extensions\/phenix-persistence\/)/g,
    "@matthis-k/phenix-suite/persistence/",
  ],
  [
    /modules\/phenix-pi\/extensions\/phenix-routing\/default-routing\.ts/g,
    "@matthis-k/phenix-suite/defaults/routing.ts",
  ],
  [
    /modules\/phenix-pi\/extensions\/phenix-contracts\/default-contracts\.ts/g,
    "@matthis-k/phenix-suite/defaults/contracts.ts",
  ],
  [/modules\/phenix-pi\/extensions\/phenix-kernel\//g, "@matthis-k/phenix-kernel/"],
  [/modules\/phenix-pi\/extensions\/phenix-routing\//g, "@matthis-k/phenix-routing/"],
  [/modules\/phenix-pi\/extensions\/phenix-workflow\//g, "@matthis-k/phenix-flow/"],
  [/modules\/phenix-pi\/extensions\/phenix-contracts\//g, "@matthis-k/phenix-contracts/"],
  [
    /modules\/phenix-pi\/extensions\/phenix-composition\//g,
    "@matthis-k/phenix-suite/composition/",
  ],
  [/modules\/phenix-pi\/extensions\/phenix-runtime\//g, "@matthis-k/phenix-suite/runtime/"],
  [
    /modules\/phenix-pi\/extensions\/phenix-subagents\//g,
    "@matthis-k/phenix-suite/subagents/",
  ],
  [
    /modules\/phenix-pi\/extensions\/phenix-persistence\//g,
    "@matthis-k/phenix-suite/persistence/",
  ],
];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function isLegacyShim(path) {
  const relativePath = relative(legacyRoot, path).replaceAll("\\", "/");
  return !relativePath.startsWith("../") && relativePath.startsWith("phenix-");
}

function isMigrationSource(path) {
  return path === migrationSource;
}

for (const path of walk(root)) {
  if (isLegacyShim(path) || isMigrationSource(path)) continue;
  const original = readFileSync(path, "utf8");
  const migrated = replacements.reduce(
    (content, [pattern, replacement]) => content.replace(pattern, replacement),
    original,
  );
  if (migrated !== original) writeFileSync(path, migrated);
}

for (const name of readdirSync(legacyRoot)) {
  if (name.startsWith("phenix-")) rmSync(join(legacyRoot, name), { recursive: true, force: true });
}

const leftovers = walk(root).filter((path) => {
  if (isLegacyShim(path) || isMigrationSource(path)) return false;
  return readFileSync(path, "utf8").includes("extensions/phenix-");
});
if (leftovers.length > 0) {
  throw new Error(`Legacy Phenix extension references remain:\n${leftovers.join("\n")}`);
}

execFileSync("git", ["diff", "--check"], { cwd: root, stdio: "inherit" });
const rawStatus = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
  cwd: root,
  encoding: "utf8",
});
const modified = [];
const deleted = [];
for (const record of rawStatus.split("\0")) {
  if (!record) continue;
  const status = record.slice(0, 2);
  const path = record.slice(3);
  if (status.includes("D")) deleted.push(path);
  else modified.push(path);
}

rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(join(artifactRoot, "files"), { recursive: true });
for (const path of modified) {
  const source = join(root, path);
  if (!existsSync(source) || !statSync(source).isFile()) continue;
  const destination = join(artifactRoot, "files", path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
writeFileSync(
  join(artifactRoot, "manifest.json"),
  JSON.stringify({ modified: modified.sort(), deleted: deleted.sort() }, null, 2),
);
console.log(`Prepared ${modified.length} modified and ${deleted.length} deleted paths.`);
