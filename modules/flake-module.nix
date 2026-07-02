{ inputs, ... }: {
  perSystem = { system, ... }: {
    phenixWrapped = {
      opencode = inputs.phenix-agent-harness.packages.${system}.opencode;
      pi = inputs.phenix-agent-harness.packages.${system}.pi;
      agentComm = inputs.phenix-agent-harness.packages.${system}.agent-comm;
    };
  };
}
