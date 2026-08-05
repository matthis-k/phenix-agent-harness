mod gateway;
mod host;
mod model;

pub use gateway::{PhenixAcpGateway, PhenixAcpGatewayBuilder};
pub use host::{GatewayCommand, GatewayEnvelope, GatewayFailure, GatewayReply};
pub(crate) use model::objective_terminal_state;

pub use model::{
    AcpSession, AcpSessionFactory, FirstAvailableRouter, FixedRouter, GatewayError, GatewayEvent,
    InteractionResponse, RoutingDecision, RoutingRequest, SessionCommand, SessionEvent,
    SessionImage, SessionOpenKind, SessionOpenRequest, SessionRouter, SessionTranscriptRole,
    StaticWorkflow, TreeStartResult, Workflow, WorkflowPlan, WorkflowPlanBuilder, WorkflowRequest,
    WorkflowStep,
};

#[cfg(test)]
mod tests;
