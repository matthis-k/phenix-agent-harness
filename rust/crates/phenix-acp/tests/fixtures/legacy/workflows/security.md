# Legacy security workflow

```phenix-workflow
id: workflow.security
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `surface` | | `scout` | Map entry points, assets, and privilege boundaries for {objective} |
| `threat-model` | `surface` | `threat-modeler` | Model ownership, trust boundaries, and attack paths for {objective} |
| `adversarial` | `threat-model` | `critic` | Validate concrete security risks adversarially for {objective} |
| `finalize` | `adversarial` | `finalizer` | Produce the evidence-backed security handoff for {objective} |
