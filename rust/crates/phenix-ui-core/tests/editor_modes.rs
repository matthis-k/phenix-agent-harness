use phenix_ui_core::{ElementId, InputEditor, ViewState, VimMode};

#[test]
fn editor_backends_share_a_single_typed_view_state() {
    let mut view = ViewState::default();
    view.terminal.height = 45;

    assert_eq!(view.input_editor, InputEditor::Owned);
    assert_eq!(view.vim_mode, VimMode::Insert);
    assert_eq!(view.pane(&ElementId::input()).height, Some(5));

    view.set_input_editor(InputEditor::Embedded);
    assert_eq!(view.input_editor, InputEditor::Embedded);
    assert_eq!(view.vim_mode, VimMode::Normal);
    assert_eq!(view.pane(&ElementId::input()).height, Some(15));

    view.set_input_editor(InputEditor::External);
    assert_eq!(view.input_editor, InputEditor::External);
    assert_eq!(view.vim_mode, VimMode::Normal);
    assert_eq!(view.pane(&ElementId::input()).height, Some(5));
}

#[test]
fn editor_cycle_is_exhaustive_and_stable() {
    assert_eq!(InputEditor::Owned.next(), InputEditor::Embedded);
    assert_eq!(InputEditor::Embedded.next(), InputEditor::External);
    assert_eq!(InputEditor::External.next(), InputEditor::Owned);
}
