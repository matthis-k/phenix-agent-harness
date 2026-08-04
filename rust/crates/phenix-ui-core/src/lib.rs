#![forbid(unsafe_code)]

mod reducer;
mod state;

pub use reducer::{reduce, AppEffect, AppEvent, UserIntent};
pub use state::{AppState, DialogState, InputState, RuntimeConnectionState, TranscriptState};
