# Legacy research workflow

```phenix-workflow
id: workflow.research
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `fanout` | | `coordinator` | Coordinate independent research branches for {objective} |
| `repository` | `fanout` | `researcher` | Investigate repository and implementation evidence for {objective} |
| `ecosystem` | `fanout` | `researcher` | Investigate upstream documentation and prior art for {objective} |
| `constraints` | `fanout` | `researcher` | Investigate constraints, risks, and counterexamples for {objective} |
| `challenge` | `fanout` | `critic` | Challenge contradictions and unsupported conclusions for {objective} |
| `finalize` | `challenge` | `finalizer` | Produce the source-oriented research handoff for {objective} |
