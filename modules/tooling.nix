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
in
{
  inherit agentRuntime quality;

  tendRuntime = pkgs.lib.unique (
    quality
    ++ (with pkgs; [
      ast-grep
      bash
      git
      nix
      nodejs
      typescript
    ])
  );
}
