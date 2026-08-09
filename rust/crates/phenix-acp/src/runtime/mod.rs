mod gateway;
mod host;
mod model;

pub use gateway::{PhenixAcpGateway, PhenixAcpGatewayBuilder};
pub use host::{GatewayCommand, GatewayEnvelope, GatewayFailure, GatewayReply};
pub(crate) use model::objective_terminal_state;

pub use model::{
    AcpSession, AcpSessionFactory, FixedRouter, GatewayError, GatewayEvent, InteractionResponse,
    RoutingDecision, RoutingRequest, SessionCommand, SessionEvent, SessionImage, SessionOpenKind,
    SessionOpenRequest, SessionRouter, StaticWorkflow, TreeStartResult, Workflow, WorkflowPlan,
    WorkflowPlanBuilder, WorkflowRequest, WorkflowStep,
};

#[cfg(test)]
mod tests;
