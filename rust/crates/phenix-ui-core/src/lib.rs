#![forbid(unsafe_code)]

mod input;
mod reducer;
mod state;

pub use input::{
    KeyCode, KeyInput, KeyModifiers, MouseAction, MouseButton, MouseInput, UiInput,
};
pub use reducer::{reduce, AppEffect, AppEvent, UserIntent};
pub use state::{AppState, DialogState, InputState, RuntimeConnectionState, TranscriptState};
