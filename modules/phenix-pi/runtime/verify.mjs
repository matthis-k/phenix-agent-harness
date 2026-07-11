#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 24_000;

function parseArgs(argv) {
  let cwd = process.cwd();
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--cwd") {
      const value = argv[index + 1];
      if (!value) throw new Error("--cwd requires a value");
      cwd = path.resolve(value);
      index++;
    }
  }
  return { cwd };
}

function executable(name) {
  const probe = spawnSync(name, ["--version"], {
    encoding: "utf-8",
    stdio: "ignore",
    timeout: 5_000,
  });
  return probe.error?.code !== "ENOENT";
}

function trimOutput(value) {
  const text = (value ?? "").trim();
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... output truncated by Phenix runtime ...`;
}

function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    command: [command, ...args].join(" "),
    status: result.error?.code === "ETIMEDOUT" ? "timed-out" : result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    durationMs: Date.now() - started,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr || result.error?.message),
  };
}

function gitRoot(cwd) {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 10_000 });
  return result.status === "passed" && result.stdout ? path.resolve(result.stdout) : undefined;
}

function nullSeparated(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "buffer",
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .toString("utf-8")
    .split("\0")
    .filter(Boolean);
}

function changedFiles(root) {
  const files = new Set([
    ...nullSeparated("git", ["diff", "--name-only", "-z", "--diff-filter=ACMR"], root),
    ...nullSeparated("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], root),
    ...nullSeparated("git", ["ls-files", "--others", "--exclude-standard", "-z"], root),
  ]);
  return [...files].filter((file) => fs.existsSync(path.join(root, file))).sort();
}

function hasExtension(files, extensions) {
  return files.some((file) => extensions.has(path.extname(file).toLowerCase()));
}

function existing(root, candidate) {
  const resolved = path.join(root, candidate);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function pushCommand(checks, command, args, root, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!executable(command)) {
    checks.push({
      command: [command, ...args].join(" "),
      status: "failed",
      exitCode: null,
      durationMs: 0,
      stdout: "",
      stderr: `required runtime executable not found: ${command}`,
    });
    return;
  }
  checks.push(run(command, args, { cwd: root, timeoutMs }));
}

function validateJson(root, files, checks) {
  const jsonFiles = files.filter((file) => path.extname(file).toLowerCase() === ".json");
  const failures = [];
  for (const file of jsonFiles) {
    try {
      JSON.parse(fs.readFileSync(path.join(root, file), "utf-8"));
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  checks.push({
    command: "runtime JSON parse",
    status: failures.length === 0 ? "passed" : "failed",
    exitCode: failures.length === 0 ? 0 : 1,
    durationMs: 0,
    stdout: failures.length === 0 ? `${jsonFiles.length} JSON file(s) parsed` : "",
    stderr: failures.join("\n"),
  });
}

function main() {
  const { cwd } = parseArgs(process.argv.slice(2));
  const root = gitRoot(cwd) ?? cwd;
  const files = changedFiles(root);
  const checks = [];

  if (fs.existsSync(path.join(root, ".git"))) {
    pushCommand(checks, "git", ["diff", "--check"], root, 30_000);
    pushCommand(checks, "git", ["diff", "--cached", "--check"], root, 30_000);
  }

  if (files.some((file) => path.extname(file).toLowerCase() === ".json")) {
    validateJson(root, files, checks);
  }

  const tomlFiles = files.filter((file) => path.extname(file).toLowerCase() === ".toml");
  if (tomlFiles.length > 0) {
    pushCommand(checks, "taplo", ["check", ...tomlFiles], root);
  }

  if (
    hasExtension(files, new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"])) &&
    existing(root, "tsconfig.json")
  ) {
    pushCommand(checks, "tsc", ["--noEmit", "-p", path.join(root, "tsconfig.json")], root);
  }

  if (hasExtension(files, new Set([".rs"])) && existing(root, "Cargo.toml")) {
    pushCommand(checks, "cargo", ["check", "--workspace", "--all-targets"], root, 180_000);
    pushCommand(checks, "cargo", ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], root, 240_000);
  }

  if (hasExtension(files, new Set([".nix"])) && existing(root, "flake.nix")) {
    pushCommand(checks, "nix", ["flake", "check", "--no-build"], root, 240_000);
  }

  if (
    hasExtension(files, new Set([".py", ".pyi"])) &&
    (existing(root, "pyproject.toml") || existing(root, "basedpyrightconfig.json"))
  ) {
    pushCommand(checks, "basedpyright", [root], root, 180_000);
  }

  if (checks.length === 0) {
    checks.push({
      command: "phenix runtime verifier",
      status: "passed",
      exitCode: 0,
      durationMs: 0,
      stdout: files.length === 0 ? "no changed files" : "no language-specific runtime check was required",
      stderr: "",
    });
  }

  const failed = checks.filter((check) => check.status !== "passed");
  const report = {
    version: 1,
    root,
    changedFiles: files,
    status: failed.length === 0 ? "passed" : "failed",
    checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
