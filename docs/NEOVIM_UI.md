# Neovim-native frontend interaction model

The native Phenix frontend treats the harness as an editor-like workspace over typed runtime objects. Vim-shaped keys are not an independent UI language: they map familiar Neovim concepts onto existing Phenix session, run, transcript, pane, and picker state.

## Object model

| Neovim concept | Phenix object | Meaning |
| --- | --- | --- |
| tabpage | persisted session | durable top-level work context |
| buffer | run | one root, agent, or workflow execution and its transcript |
| window | pane | viewport onto transcript, run tree, composer, inspector, or specialized surface |
| cursor | selected semantic object | run-tree cursor, transcript turn, or rich block |
| fold | run subtree / transcript details | frontend-only presentation state |
| picker | overlay | transient model, session, authentication, or command selection |
| insert buffer | composer | owned, embedded, or external prompt editor |

These identities are deliberately separate. Switching a run changes the active transcript without changing pane focus. Moving the run-tree cursor does not activate a run until an explicit open action. Persisted sessions are not collapsed into runs.

## Modal invariant

The composer owns Normal/Insert state. Global multi-key mappings are Normal-mode navigation and must not consume Insert-mode text editing. In particular, while inserting, Space remains text, `g` remains text, and `<C-w>` remains the owned editor's delete-previous-word operation.

`Esc` is never a runtime abort action:

- Insert -> Normal
- pending key sequence -> cancel prefix
- picker/dialog -> cancel the transient UI where supported
- Normal navigation -> no destructive action

`<C-c>` is the explicit selected-run interrupt action.

## Key sequence resolution

Mappings may contain multiple strokes, for example:

```text
<C-w>h
<C-w><lt>
gg
za
[b
]b
gt
<leader>fm
```

Space is the default `<leader>`. Pane-local mappings have precedence over global mappings. Incomplete prefixes have a bounded timeout. If a prefix fails, its final key is retried as a fresh key so an accidental prefix does not swallow the following command.

## Windows

Canonical window navigation follows Neovim:

| Mapping | Action |
| --- | --- |
| `<C-w>h/j/k/l` | focus directional pane |
| `<C-w>w` | next pane |
| `<C-w>W` | previous pane |
| `<C-w>>` / `<C-w><lt>` | widen / narrow pane |
| `<C-w>+` / `<C-w>-` | increase / decrease pane height |

Alt-hjkl remains a compatibility alias, not the primary vocabulary.

## Runs as buffers

The sidebar projects `RunSummary.parent` into a hierarchy. Collapse state and browsing cursor are frontend-local; neither mutates runtime orchestration.

| Mapping | Action |
| --- | --- |
| `j` / `k` | next / previous visible run |
| `h` | collapse expanded run, otherwise select parent |
| `l` | expand collapsed run, otherwise select first child |
| `za` | toggle current run subtree |
| `gg` / `G` | first / last visible run |
| `<CR>` | activate cursor run |
| `o` | activate cursor run and focus transcript |
| `[b` / `]b` | previous / next visible run buffer |
| `[r` / `]r` | aliases for previous / next visible run |

The renderer distinguishes the browsing cursor from the active run. A malformed backend projection must not silently hide runs: missing-parent nodes are surfaced as roots and traversal guards against cycles.

## Sessions as tabpages

| Mapping | Action |
| --- | --- |
| `gt` | next persisted session |
| `gT` | previous persisted session |
| `<leader>fs` | session picker |
| `<leader>sn` | new session |

Session switching continues through the typed backend command path; frontend navigation does not synthesize session state.

## Transcript

Conversation-turn selection is independent from viewport scrolling.

| Mapping | Action |
| --- | --- |
| `j` / `k` | next / previous conversation turn |
| `}` / `{` | next / previous conversation turn |
| `<C-n>` / `<C-p>` | aliases for turn movement |
| `gg` / `G` | first / latest turn |
| `za` / `<CR>` | toggle selected turn details |
| `<C-e>` / `<C-y>` | scroll viewport one line |
| `<C-d>` / `<C-u>` | scroll viewport by a larger increment |
| `<C-f>` / `<C-b>` | scroll viewport by a page-like increment |

Rich transcript blocks retain independent selection, representation, and viewport state. Current block-local controls are:

| Mapping | Action |
| --- | --- |
| `[` / `]` | previous / next interactive rich block |
| `v` / `V` | next / previous representation |
| `H` / `L` | horizontal block viewport |
| `J` / `K` | vertical block viewport |

Tables, Mermaid/code blocks, and images therefore change representation locally rather than forcing the complete transcript into a different mode.

## Composer

The owned and embedded editors retain their native modal behavior. Normal-mode window/run/session sequences are ineligible while the composer is in Insert mode.

Important input actions:

- Enter: submit from the owned editor
- Shift-Enter: newline in the owned editor
- Ctrl-Enter: steer from the owned editor; submit from the embedded editor
- Alt-Enter: queue follow-up
- Ctrl-G: open configured external editor
- Ctrl-W / Ctrl-U / Ctrl-K: shell-style owned-editor deletion while inserting

Backend support remains capability-driven; a frontend mapping must not imply that the selected backend supports a runtime operation.

## Pickers

All selection overlays use one interaction contract:

| Mapping | Action |
| --- | --- |
| `j`, `<C-n>`, Down | next item |
| `k`, `<C-p>`, Up | previous item |
| `<CR>`, `<C-y>` | accept |
| `<Esc>`, `<C-c>` | cancel |

Leader entry points currently include:

- `<leader>fm`: model picker
- `<leader>fs`: session picker
- `<leader>fa`: authentication providers
- `<leader>fb`: show/focus run navigation
- `<leader>tb`: toggle operational sidebar

## Architecture rule

All keyboard and Lua interactions must resolve through the renderer-neutral typed action path:

```text
key / Lua callback
  -> FrontendCommand or UiCommand
  -> ViewMutation or UserIntent
  -> BackendCommand only when runtime work is required
```

The Ratatui renderer presents state. Lua defines mappings and presentation configuration. Neither layer owns routing, workflows, sessions, or backend orchestration.

## Planned extensions

The same model should be extended rather than introducing a second interaction system:

- jumplist with `<C-o>` / `<C-i>` over session/run/turn/block addresses
- Ex-style `:` frontend command line distinct from ACP `/commands`
- attention/quickfix projection for failures, blocked objectives, dialogs, and auth requests
- session fork/clone/rename/export UX
- thinking-level and session-mode pickers
- marks
- composer undo/redo and more complete operator semantics

Those features are orthogonal to the navigation substrate and should use the same typed action layer.
