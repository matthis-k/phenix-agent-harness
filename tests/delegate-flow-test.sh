#!/usr/bin/env bash
# =============================================================================
# Phenix Delegate Flow Test
# =============================================================================
#
# Tests multi-step delegation: planner -> implementer -> critic
# Requires: PI_SUBAGENT_PI_BINARY set to a pi binary
#
# Usage:
#   export PI_SUBAGENT_PI_BINARY=/path/to/pi
#   PI_SUBAGENT_PI_BINARY=/home/matthisk/phenix/repos/phenix-agent-harness/result/bin/pi \
#     nix develop . --command pi -p "$(cat tests/delegate-flow-test.sh)"
#
# Or from outside pi with the wrapper:
#   export PI_SUBAGENT_PI_BINARY=/home/matthisk/phenix/repos/phenix-agent-harness/result/bin/pi
#   pi -p "$(cat tests/delegate-flow-test.sh)"
# =============================================================================

echo "=== Phenix Delegate Flow Test ==="
echo "Testing: Planner -> Implementer -> Critic handoff chain"
echo "Task: Deeply Silly Greeting Protocol (children know this is a toy)"
echo ""

# Step 1: Planner designs the spec
echo "--- Step 1: Planner ---"
echo "Asking planner to design the Deeply Silly Greeting Protocol..."

# The actual delegate calls happen via phenix_delegate tool
# This script is a demonstration — run it inside pi with delegates available
echo ""
echo "This test must be run INSIDE a pi session with phenix_delegate"
echo "available and PI_SUBAGENT_PI_BINARY set."
echo ""
echo "To run:"
echo "  1. Set PI_SUBAGENT_PI_BINARY to the pi binary path"
echo "  2. Start pi from this repo's dev shell"
echo "  3. Run the delegate commands (or use this as a prompt)"
echo ""
echo "Example launcher: ~/bin/phenix-pi"
echo "Or directly: PI_SUBAGENT_PI_BINARY=result/bin/pi result/bin/pi"
