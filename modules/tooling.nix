{ pkgs }:

let
  quality = with pkgs; [
    actionlint
    biome
    coreutils
    diffutils
    git
    gnugrep
    nixfmt
    shellcheck
    shfmt
    statix
  ];

  agentRuntime = with pkgs; [
    bash
    coreutils
    diffutils
    file
    findutils
    gawk
    git
    gh
    gnugrep
    gnused
    jq
    patch
    ripgrep
    fd
    ast-grep
    tree
    which

    nix
    nixd

    cargo
    rustc
    clippy
    rust-analyzer

    lua-language-server

    nodejs
    typescript
    typescript-language-server
    vscode-langservers-extracted

    taplo
    yaml-language-server
    basedpyright
  ];

  # Runtime composition and repository maintenance are separate boundaries.
  # Maintenance scripts inject quality tools only for their own checks.
  harnessRuntime = agentRuntime;
in
{
  inherit agentRuntime harnessRuntime quality;
}
