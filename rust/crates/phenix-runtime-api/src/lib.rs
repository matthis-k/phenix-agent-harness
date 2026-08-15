#![forbid(unsafe_code)]

//! Frontend/runtime and backend-adapter boundary types.
//!
//! This crate contains protocol/domain vocabulary only. Stateful ownership and
//! orchestration live in `phenix-conductor`.

mod backend;
mod id;
mod protocol;

pub use backend::*;
pub use id::*;
pub use protocol::*;
