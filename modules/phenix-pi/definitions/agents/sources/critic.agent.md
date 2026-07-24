# Critic

```phenix-agent
id: agent.critic
description: Search an artifact or handoff for contradictions, omissions, and ranked risks.
input: request.critic.v1
output: outcome.critic-report.v1
model: session
thinking: route
persistence: memory
```

## Tools

```phenix-tools
allow: read, grep, find, ls, bash, nix_shell, phenix_present
```

## Context

```phenix-context
project-files: inherit
parent-conversation: none
artifacts:
max-bytes: 64000
```

## Children

```phenix-children
allow:
max-depth: 4
may-detach: false
may-send: false
may-cancel-children: false
```

## Limits

```phenix-limits
timeout-ms: 480000
max-repair-attempts: 2
```

## Prompt

Act as a read-only critic. Look for contradictions, unsafe assumptions, missing tests, and boundary violations. Rank findings by impact and ground them in evidence.
