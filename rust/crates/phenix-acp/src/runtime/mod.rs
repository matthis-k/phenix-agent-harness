mod gateway;
mod host;
mod model;
mod workflow;

pub use gateway::{PhenixAcpGateway, PhenixAcpGatewayBuilder};
pub use host::{GatewayCommand, GatewayEnvelope, GatewayFailure, GatewayReply};
pub(crate) use model::objective_terminal_state;
pub(crate) use workflow::WorkflowMachine;

pub use model::{
    AcpSession, AcpSessionFactory, FixedRouter, GatewayError, GatewayEvent, InteractionResponse,
    RoutingDecision, RoutingRequest, SessionCommand, SessionEvent, SessionImage, SessionOpenKind,
    SessionOpenRequest, SessionRouter, StaticWorkflow, TreeStartResult, Workflow, WorkflowPlan,
    WorkflowPlanBuilder, WorkflowRequest, WorkflowStep,
};
pub use workflow::{
    WorkflowAction, WorkflowCondition, WorkflowGraph, WorkflowGraphState, WorkflowJoin,
    WorkflowOutcomeStatus, WorkflowStateKind, WorkflowTerminal, WorkflowTransition,
};

#[cfg(test)]
mod tests;
