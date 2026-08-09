#![forbid(unsafe_code)]

mod consumers;
mod fabric;
mod frontend;
mod mailbox;
mod runtime;
#[cfg(test)]
mod testing;

pub use consumers::install_core_consumers;
pub use fabric::{
    BusReaction, ContentEvent, EventConsumer, EventRouter, InputEdit, Propagation, ReactionBatch,
    RouterError, UiEvent, ViewMutation,
};
pub use frontend::{install_frontend_provider, FrontendProviderConsumer};
pub use mailbox::{UiIngressError, UiMailbox, UiMessage};
pub use runtime::{UiRenderer, UiRuntime, UiRuntimeError};
