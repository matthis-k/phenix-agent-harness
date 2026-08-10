#![forbid(unsafe_code)]

mod completion;
mod input;
mod reducer;
mod rich_text;
mod routing;
mod state;
mod transcript;
mod view;

pub use completion::{
    command_completions, selected_command_completion, CommandCompletion, MAX_COMMAND_COMPLETIONS,
};
pub use input::{KeyCode, KeyInput, KeyModifiers, MouseAction, MouseButton, MouseInput, UiInput};
pub use reducer::{reduce, AppEffect, AppEvent, UserIntent};
pub use rich_text::{
    parse_inline, parse_markdown, RichBlock, RichBlockView, RichCodeBlock, RichDocument, RichImage,
    RichSpan, RichTable, RichText,
};
pub use routing::{
    ElementId, EventEnvelope, FocusDirection, InvalidElementId, LayoutAxis, ResizeRequest,
    RouteTarget,
};
pub use state::{
    transcript_item_id, transcript_turn_id, AppState, AuthFlowState, DialogState, InputState,
    RuntimeConnectionState, ToolCallView, TranscriptState, VisibleRun,
};
pub use transcript::{
    group_transcript_turns, TranscriptTurn, TranscriptTurnItem, TranscriptTurnItemKind,
};
pub use view::{
    FocusTarget, InputEditor, OverlayState, PaneViewState, RichBlockViewport, ScrollState,
    SidebarSection, TerminalSize, ViewState, VimMode,
};
