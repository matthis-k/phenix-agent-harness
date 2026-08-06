#![forbid(unsafe_code)]

mod completion;
mod input;
mod reducer;
mod routing;
mod state;
mod view;

pub use completion::{
    command_completions, selected_command_completion, CommandCompletion, MAX_COMMAND_COMPLETIONS,
};
pub use input::{KeyCode, KeyInput, KeyModifiers, MouseAction, MouseButton, MouseInput, UiInput};
pub use reducer::{reduce, AppEffect, AppEvent, UserIntent};
pub use routing::{
    ElementId, EventEnvelope, FocusDirection, InvalidElementId, LayoutAxis, ResizeRequest,
    RouteTarget,
};
pub use state::{
    AppState, AuthFlowState, DialogState, InputState, RuntimeConnectionState, TranscriptState,
};
pub use view::{
    FocusTarget, OverlayState, PaneViewState, ScrollState, SidebarSection, TerminalSize, ViewState,
};
