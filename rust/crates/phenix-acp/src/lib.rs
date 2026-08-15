#![forbid(unsafe_code)]

//! ACP interoperability boundary.
//!
//! This crate deliberately contains no Phenix application/runtime semantics.
//! Session trees, executions, routing, workflows, callables, tools, policy and
//! persistence belong to `phenix-conductor` and its domain crates. ACP is only
//! one backend wire protocol.

pub use agent_client_protocol as wire;

/// Stable name used by smoke tests and diagnostics to identify this adapter.
pub const WIRE_PROTOCOL_NAME: &str = "acp";
