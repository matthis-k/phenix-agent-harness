{ inputs, ... }:
{
  perSystem =
    { system, ... }:
    {
      phenixWrapped = {
        pi = inputs.phenix-agent-harness.packages.${system}.pi;
        agentComm = inputs.phenix-agent-harness.packages.${system}.agent-comm;
      };
    };
}
