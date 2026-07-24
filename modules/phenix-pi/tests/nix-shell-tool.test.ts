import assert from "node:assert/strict";
import test from "node:test";

import {
  createNixShellTool,
  normalizeBinaryName,
  normalizeNixInstallable,
  selectBinaryInstallable,
} from "../adapters/pi-sdk/nix-shell-tool.ts";

test("nix shell normalizes bare packages and preserves explicit installables", () => {
  assert.equal(normalizeNixInstallable("jq"), "nixpkgs#jq");
  assert.equal(
    normalizeNixInstallable("python312Packages.black"),
    "nixpkgs#python312Packages.black",
  );
  assert.equal(normalizeNixInstallable("nixpkgs#ripgrep"), "nixpkgs#ripgrep");
  assert.equal(
    normalizeNixInstallable("github:NixOS/nixpkgs/nixos-unstable#fd"),
    "github:NixOS/nixpkgs/nixos-unstable#fd",
  );
});

test("nix shell validates executable basenames", () => {
  assert.equal(normalizeBinaryName("rg"), "rg");
  assert.equal(normalizeBinaryName("clang++"), "clang++");
  assert.throws(() => normalizeBinaryName("bin/rg"), /Invalid binary name/);
  assert.throws(() => normalizeBinaryName("--option"), /Invalid binary name/);
  assert.throws(() => normalizeBinaryName("rg fd"), /Invalid binary name/);
});

test("nix-index output resolves one package and rejects ambiguity", () => {
  assert.equal(selectBinaryInstallable("rg", "ripgrep.out\n"), "nixpkgs#ripgrep.out");
  assert.equal(
    selectBinaryInstallable("black", "python312Packages.black\npython312Packages.black\n"),
    "nixpkgs#python312Packages.black",
  );
  assert.throws(() => selectBinaryInstallable("missing", "\n"), /found no nixpkgs package/);
  assert.throws(
    () => selectBinaryInstallable("awk", "gawk.out\nmawk.out\n"),
    /Select one explicitly through packages/,
  );
});

test("nix shell rejects values that could be interpreted as nix options", () => {
  assert.throws(() => normalizeNixInstallable("--impure"), /Invalid Nix installable/);
  assert.throws(() => normalizeNixInstallable("jq ripgrep"), /Invalid Nix installable/);
  assert.throws(() => normalizeNixInstallable(""), /Invalid Nix installable/);
});

test("nix shell tool describes binary resolution and ephemeral execution", () => {
  const tool = createNixShellTool(process.cwd());
  assert.equal(tool.name, "nix_shell");
  assert.match(tool.description, /binary names resolved through nix-index/i);
  assert.match(tool.description, /never installs packages into a profile/i);
  assert.match(tool.description, /same command-execution authority as bash/i);
});
