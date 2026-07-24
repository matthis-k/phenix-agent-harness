import assert from "node:assert/strict";
import test from "node:test";

import { createNixShellTool, normalizeNixInstallable } from "../adapters/pi-sdk/nix-shell-tool.ts";

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

test("nix shell rejects values that could be interpreted as nix options", () => {
  assert.throws(() => normalizeNixInstallable("--impure"), /Invalid Nix installable/);
  assert.throws(() => normalizeNixInstallable("jq ripgrep"), /Invalid Nix installable/);
  assert.throws(() => normalizeNixInstallable(""), /Invalid Nix installable/);
});

test("nix shell tool is explicitly described as ephemeral command execution", () => {
  const tool = createNixShellTool(process.cwd());
  assert.equal(tool.name, "nix_shell");
  assert.match(tool.description, /never installs packages into a profile/i);
  assert.match(tool.description, /same command-execution authority as bash/i);
});
