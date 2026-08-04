#![forbid(unsafe_code)]

mod input;
mod reducer;
mod state;
mod view;

pub use input::{
    KeyCode, KeyInput, KeyModifiers, MouseAction, MouseButton, MouseInput, UiInput,
};
pub use reducer::{reduce, AppEffect, AppEvent, UserIntent};
pub use state::{
    AppState, AuthFlowState, DialogState, InputState, RuntimeConnectionState, TranscriptState,
};
pub use view::{
    FocusTarget, OverlayState, ScrollState, SidebarSection, TerminalSize, ViewState,
};
