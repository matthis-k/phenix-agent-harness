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

  # Local workflow operations are runtime behavior, not maintenance-only tooling.
  # Keep their executables in the packaged wrapper closure so discovery and execution agree.
  localOperationRuntime = with pkgs; [
    devenv
  ];

  # Runtime composition and repository maintenance remain separate boundaries.
  # Maintenance scripts inject quality tools only for their own checks.
  harnessRuntime = agentRuntime ++ localOperationRuntime;
in
{
  inherit
    agentRuntime
    harnessRuntime
    localOperationRuntime
    quality
    ;
}
