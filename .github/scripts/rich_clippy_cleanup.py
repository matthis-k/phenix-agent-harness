from pathlib import Path


def replace(path: str, old: str, new: str, count: int = -1) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"expected text not found in {path}: {old[:100]!r}")
    file.write_text(text.replace(old, new, count))


replace(
    "rust/crates/phenix-tui/src/rich_document.rs",
    '"─".repeat(width.min(48).max(3))',
    '"─".repeat(width.clamp(3, 48))',
    1,
)

replace(
    "rust/crates/phenix-tui/src/syntax_highlight.rs",
    '''        "field" | "property" | "parameter" | "variable" | "embedded" | "label" | _ => {
            theme_style(theme, "Normal")
        }
''',
    '''        "field" | "property" | "parameter" | "variable" | "embedded" | "label" => {
            theme_style(theme, "Normal")
        }
        _ => theme_style(theme, "Normal"),
''',
    1,
)

transcript = Path("rust/crates/phenix-tui/src/transcript.rs")
text = transcript.read_text()
old_call = '''        render_turn(
            &mut lines,
            &mut media,
            turn,
            selected_turn == Some(index)
                && state.view.focus == phenix_ui_core::FocusTarget::Transcript,
            state.view.transcript_turn_is_expanded(&turn.id),
            width,
            state,
            theme,
        );
'''
new_call = '''        render_turn(
            &mut lines,
            &mut media,
            turn,
            TurnRenderContext {
                selected: selected_turn == Some(index)
                    && state.view.focus == phenix_ui_core::FocusTarget::Transcript,
                expanded: state.view.transcript_turn_is_expanded(&turn.id),
                width,
                state,
                theme,
            },
        );
'''
if old_call not in text:
    raise SystemExit("render_turn call not found")
text = text.replace(old_call, new_call, 1)
old_fn = '''fn render_turn(
    lines: &mut Vec<Line<'static>>,
    media: &mut Vec<TranscriptMediaAnchor>,
    turn: &TranscriptTurn,
    selected: bool,
    expanded: bool,
    width: u16,
    state: &AppState,
    theme: &ThemeConfig,
) {
'''
new_fn = '''struct TurnRenderContext<'a> {
    selected: bool,
    expanded: bool,
    width: u16,
    state: &'a AppState,
    theme: &'a ThemeConfig,
}

fn render_turn(
    lines: &mut Vec<Line<'static>>,
    media: &mut Vec<TranscriptMediaAnchor>,
    turn: &TranscriptTurn,
    context: TurnRenderContext<'_>,
) {
    let TurnRenderContext {
        selected,
        expanded,
        width,
        state,
        theme,
    } = context;
'''
if old_fn not in text:
    raise SystemExit("render_turn definition not found")
text = text.replace(old_fn, new_fn, 1)
old_init = '''        let mut state = AppState::default();
        state.root_run = Some(run_id.clone());
        state.selected_run = Some(run_id.clone());
'''
new_init = '''        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
'''
if text.count(old_init) < 3:
    raise SystemExit(f"expected at least three transcript test initializers, found {text.count(old_init)}")
text = text.replace(old_init, new_init)
transcript.write_text(text)

replace(
    "rust/crates/phenix-tui/src/renderer.rs",
    '''        let mut state = AppState::default();
        state.root_run = Some(run_id.clone());
        state.selected_run = Some(run_id.clone());
''',
    '''        let mut state = AppState {
            root_run: Some(run_id.clone()),
            selected_run: Some(run_id.clone()),
            ..AppState::default()
        };
''',
    1,
)
