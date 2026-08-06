# Phenix Conductor parity

This matrix tracks functional parity with the former Pi-owned Phenix integration. A capability is complete only when it is reachable through the conductor wire boundary and covered by a protocol-level test; an internal gateway enum alone is not sufficient.

## Functional through the conductor

| Area | Northbound surface | Southbound realization |
|---|---|---|
| Aggregate lifecycle | `_phenix/session_tree/create`, `get`, `list`, `close` | one immutable tree containing standard ACP sessions |
| Ordinary root session | standard `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/close` | root Phenix node mapped to one downstream ACP session |
| Delegation | `_phenix/node/delegate` | downstream `session/new` through the selected route |
| Persistent node attachment | `_phenix/node/load`, `resume`, `fork` | downstream ACP load/resume/fork operations |
| Workflows | `_phenix/workflow/start` | typed workflow plan creates and relates routed ACP nodes |
| Objectives | tree snapshots and `_phenix/objective/mark` | conductor-owned objective state |
| Routing | `_phenix/routing/explain` | immutable router chooses backend/provider/model |
| Prompting | `_phenix/node/execute` and standard `session/prompt` | standard downstream ACP prompt |
| Steering and follow-ups | `_phenix/node/execute` | standard downstream ACP steering/follow-up support through the adapter |
| Images and embedded context | standard prompt content and `_phenix/node/execute` | downstream ACP image prompt blocks |
| Model, mode, thinking selection | `_phenix/node/execute` | downstream ACP configuration operations |
| Compaction | `_phenix/node/execute` | downstream ACP compaction operation |
| Commands | `_phenix/node/execute` | downstream advertised command invocation |
| Interaction response | `_phenix/node/execute` | typed permission/interaction response routed to the owning node |
| Cancellation | standard `session/cancel` and `_phenix/node/cancel` | subtree cancellation propagated to downstream ACP |
| Transcript/tool projection | standard `session/update` and `GatewayEvent` results | downstream message, thought, and tool lifecycle events |
| Aggregate subscriptions | `_phenix/node/subscribe`, `_phenix/node/unsubscribe`, `_phenix/node/event`, `_phenix/session_tree/updated` | connection-owned polling and coalesced typed notifications |
| Multi-backend definitions | conductor bootstrap | independent downstream ACP transport selected by routing |

## Remaining before Pi parity

| Area | Required work |
|---|---|
| Authentication | expose provider listing, login flows, terminal/device-code/browser flows, and logout through standard ACP where applicable plus typed Phenix aggregate methods |
| Model discovery | expose model/mode/thinking lists per routed backend, not only selection commands |
| Permission forwarding | project downstream ACP permission requests as real upstream ACP requests and correlate responses, rather than degrading them to text for ordinary clients |
| Terminal forwarding | proxy ACP terminal requests and lifecycle bidirectionally instead of reducing terminal output to transcript text |
| Standard session persistence | implement standard `session/list`, `load`, `resume`, `fork`, and delete over Phenix tree roots backed by persisted tree manifests |
| Dynamic definition registration | register immutable definitions through typed `_phenix/definition/*` methods before creating trees |
| Remote frontend adapter | make Ratatui consume standard ACP plus `_phenix/*`; remove its direct `PhenixAcpGateway` ownership |
| Lua binding | convert Lua declarations into the language-neutral conductor bootstrap and typed extension calls |
| Recovery and export | preserve tree/session manifests, logs, copy/export, and restart recovery across conductor process lifetimes |

## Invariants

- Standard ACP and Phenix ACP views address the same tree state; a standard ACP session ID is the corresponding Phenix tree ID.
- Running tree configuration is immutable.
- Downstream agents require only standard ACP.
- The conductor is the sole authority for tree identity, routing, objective state, parentage, cancellation, and lifecycle.
- Language bindings wrap the wire model; they do not define alternate orchestration APIs.
