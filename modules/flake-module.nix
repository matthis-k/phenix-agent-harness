{ inputs, ... }: {
  perSystem = { system, ... }: {
    phenixWrapped.opencode = inputs.phenix-agent-harness.packages.${system}.opencode;
    phenixWrapped.pi = inputs.phenix-agent-harness.packages.${system}.pi;
  };
}
