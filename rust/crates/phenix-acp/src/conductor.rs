use crate::{
    AcpMethod, EmptyResult, GatewayError, NodeAttachResult, NodeCancel, NodeDelegate, NodeExecute,
    NodeExecuteResult, NodeFork, NodeLoad, NodeResume, ObjectiveMark, PhenixAcpGateway, RoleId,
    RoutingExplain, RoutingExplainParams, SessionTreeClose, SessionTreeCreate,
    SessionTreeCreateResult, SessionTreeGet, SessionTreeList, WorkflowStart,
};
use agent_client_protocol::schema::v1::{ExtRequest, ExtResponse};
use serde::Serialize;
use serde_json::value::to_raw_value;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::Arc;

/// Owns the aggregate Phenix state and translates typed Phenix ACP extensions
/// into operations over ordinary downstream ACP sessions.
pub struct PhenixConductor {
    gateway: PhenixAcpGateway,
}

impl PhenixConductor {
    pub fn new(gateway: PhenixAcpGateway) -> Self {
        Self { gateway }
    }

    pub fn gateway(&self) -> &PhenixAcpGateway {
        &self.gateway
    }

    pub fn gateway_mut(&mut self) -> &mut PhenixAcpGateway {
        &mut self.gateway
    }

    pub fn into_gateway(self) -> PhenixAcpGateway {
        self.gateway
    }

    pub fn handle_extension(&mut self, request: ExtRequest) -> Result<ExtResponse, ConductorError> {
        match request.method.as_ref() {
            SessionTreeCreate::METHOD => {
                self.dispatch::<SessionTreeCreate, _>(&request, |gateway, params| {
                    let started = match params.tree_id {
                        Some(tree_id) => gateway.create_tree_with_id(
                            tree_id,
                            &params.definition_id,
                            params.root_role,
                            params.difficulty,
                            params.objective,
                        )?,
                        None => gateway.create_tree(
                            &params.definition_id,
                            params.root_role,
                            params.difficulty,
                            params.objective,
                        )?,
                    };
                    Ok(SessionTreeCreateResult {
                        tree_id: started.tree_id,
                        objective_id: started.objective_id,
                        root_node_id: started.root_node_id,
                    })
                })
            }
            SessionTreeGet::METHOD => self
                .dispatch::<SessionTreeGet, _>(&request, |gateway, params| {
                    gateway.snapshot(&params.tree_id)
                }),
            SessionTreeList::METHOD => self
                .dispatch::<SessionTreeList, _>(&request, |gateway, _params| {
                    Ok(gateway.list_trees())
                }),
            SessionTreeClose::METHOD => {
                self.dispatch::<SessionTreeClose, _>(&request, |gateway, params| {
                    gateway.close_tree(&params.tree_id)?;
                    Ok(EmptyResult {})
                })
            }
            WorkflowStart::METHOD => {
                self.dispatch::<WorkflowStart, _>(&request, |gateway, params| {
                    gateway.start_workflow(
                        &params.tree_id,
                        &params.workflow,
                        params.difficulty,
                        params.objective,
                    )
                })
            }
            NodeDelegate::METHOD => {
                self.dispatch::<NodeDelegate, _>(&request, |gateway, params| {
                    let node_id = gateway.delegate(
                        &params.tree_id,
                        &params.parent_node,
                        params.role,
                        params.difficulty,
                        params.objective,
                    )?;
                    Ok(NodeAttachResult { node_id })
                })
            }
            NodeLoad::METHOD => self.dispatch::<NodeLoad, _>(&request, |gateway, params| {
                let node_id = gateway.load_session(
                    &params.tree_id,
                    &params.parent_node,
                    params.role,
                    params.difficulty,
                    params.objective,
                    params.session_id,
                )?;
                Ok(NodeAttachResult { node_id })
            }),
            NodeResume::METHOD => self.dispatch::<NodeResume, _>(&request, |gateway, params| {
                let node_id = gateway.resume_session(
                    &params.tree_id,
                    &params.parent_node,
                    params.role,
                    params.difficulty,
                    params.objective,
                    params.session_id,
                )?;
                Ok(NodeAttachResult { node_id })
            }),
            NodeFork::METHOD => self.dispatch::<NodeFork, _>(&request, |gateway, params| {
                let node_id =
                    gateway.fork_node(&params.tree_id, &params.node_id, params.objective)?;
                Ok(NodeAttachResult { node_id })
            }),
            NodeExecute::METHOD => self.dispatch::<NodeExecute, _>(&request, |gateway, params| {
                let events = gateway.execute(&params.tree_id, &params.node_id, params.command)?;
                Ok(NodeExecuteResult { events })
            }),
            NodeCancel::METHOD => self.dispatch::<NodeCancel, _>(&request, |gateway, params| {
                let events = gateway.cancel_subtree(&params.tree_id, &params.node_id)?;
                Ok(NodeExecuteResult { events })
            }),
            ObjectiveMark::METHOD => {
                self.dispatch::<ObjectiveMark, _>(&request, |gateway, params| {
                    gateway.mark_objective(&params.tree_id, &params.objective_id, params.state)?;
                    Ok(EmptyResult {})
                })
            }
            RoutingExplain::METHOD => {
                self.dispatch::<RoutingExplain, _>(&request, |gateway, params| {
                    let role = route_role(gateway, &params)?;
                    gateway.explain_route(
                        &params.tree_id,
                        params.objective,
                        role,
                        params.difficulty,
                    )
                })
            }
            method => Err(ConductorError::UnknownMethod(method.to_owned())),
        }
    }

    fn dispatch<M, F>(
        &mut self,
        request: &ExtRequest,
        handler: F,
    ) -> Result<ExtResponse, ConductorError>
    where
        M: AcpMethod,
        F: FnOnce(&mut PhenixAcpGateway, M::Params) -> Result<M::Result, GatewayError>,
    {
        let params = serde_json::from_str::<M::Params>(request.params.get()).map_err(|source| {
            ConductorError::Decode {
                method: M::METHOD,
                source,
            }
        })?;
        let result = handler(&mut self.gateway, params)?;
        encode_result(M::METHOD, &result)
    }
}

fn route_role(
    gateway: &PhenixAcpGateway,
    params: &RoutingExplainParams,
) -> Result<RoleId, GatewayError> {
    if let Some(role) = &params.required_role {
        return Ok(role.clone());
    }
    let snapshot = gateway.snapshot(&params.tree_id)?;
    snapshot
        .nodes
        .into_iter()
        .find(|node| node.id == snapshot.root)
        .map(|node| node.role)
        .ok_or_else(|| GatewayError::Invariant("session tree root node is missing".to_owned()))
}

fn encode_result<T: Serialize>(
    method: &'static str,
    result: &T,
) -> Result<ExtResponse, ConductorError> {
    let result =
        to_raw_value(result).map_err(|source| ConductorError::Encode { method, source })?;
    Ok(ExtResponse::new(Arc::from(result)))
}

#[derive(Debug)]
pub enum ConductorError {
    UnknownMethod(String),
    Decode {
        method: &'static str,
        source: serde_json::Error,
    },
    Encode {
        method: &'static str,
        source: serde_json::Error,
    },
    Gateway(GatewayError),
}

impl From<GatewayError> for ConductorError {
    fn from(error: GatewayError) -> Self {
        Self::Gateway(error)
    }
}

impl Display for ConductorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownMethod(method) => write!(formatter, "unknown Phenix ACP method {method}"),
            Self::Decode { method, source } => {
                write!(
                    formatter,
                    "invalid parameters for Phenix ACP method {method}: {source}"
                )
            }
            Self::Encode { method, source } => {
                write!(
                    formatter,
                    "failed to encode Phenix ACP result for {method}: {source}"
                )
            }
            Self::Gateway(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for ConductorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Decode { source, .. } | Self::Encode { source, .. } => Some(source),
            Self::Gateway(error) => Some(error),
            Self::UnknownMethod(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        decode_extension_response, encode_extension_request, AcpEndpoint, AcpSession,
        AcpSessionFactory, AcpSessionId, BackendDefinition, BackendId, DefinitionId, Difficulty,
        FixedRouter, ModelConfig, ModelId, NodeExecuteParams, ProviderId, RoleId, RouterId,
        SessionCommand, SessionEvent, SessionOpenRequest, SessionTreeCreateParams,
        SessionTreeDefinition, ThinkingLevel,
    };
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    #[derive(Clone, Default)]
    struct TestFactory {
        next: Arc<AtomicU64>,
    }

    impl AcpSessionFactory for TestFactory {
        fn open(&self, _request: SessionOpenRequest) -> Result<Box<dyn AcpSession>, GatewayError> {
            let sequence = self.next.fetch_add(1, Ordering::Relaxed) + 1;
            Ok(Box::new(TestSession {
                id: AcpSessionId::parse(format!("session-{sequence}"))
                    .map_err(|error| GatewayError::session(error.to_string()))?,
            }))
        }
    }

    struct TestSession {
        id: AcpSessionId,
    }

    impl AcpSession for TestSession {
        fn id(&self) -> &AcpSessionId {
            &self.id
        }

        fn execute(&mut self, command: SessionCommand) -> Result<Vec<SessionEvent>, GatewayError> {
            Ok(match command {
                SessionCommand::Prompt { text, .. } => {
                    vec![SessionEvent::Text { text }, SessionEvent::Completed]
                }
                SessionCommand::Cancel => vec![SessionEvent::Cancelled {
                    reason: "cancelled by test".to_owned(),
                }],
                _ => Vec::new(),
            })
        }
    }

    fn conductor() -> PhenixConductor {
        let backend = BackendId::parse("test").expect("backend");
        let router = RouterId::parse("test.router").expect("router");
        let definition_id = DefinitionId::parse("test.definition").expect("definition");
        let definition = SessionTreeDefinition::builder(definition_id, router.clone())
            .backend(BackendDefinition::new(
                backend.clone(),
                AcpEndpoint::stdio("test-agent", Vec::new(), BTreeMap::new()).expect("endpoint"),
            ))
            .expect("backend definition")
            .build()
            .expect("tree definition");
        let model = ModelConfig {
            backend: backend.clone(),
            provider: ProviderId::parse("test-provider").expect("provider"),
            model: ModelId::parse("test-model").expect("model"),
            thinking: ThinkingLevel::Low,
        };
        let gateway = PhenixAcpGateway::builder()
            .definition(definition)
            .expect("definition")
            .router(router, FixedRouter::new(model))
            .expect("router")
            .backend(backend, TestFactory::default())
            .expect("backend")
            .build()
            .expect("gateway");
        PhenixConductor::new(gateway)
    }

    #[test]
    fn typed_extension_requests_drive_the_same_gateway_used_for_downstream_acp() {
        let mut conductor = conductor();
        let create = encode_extension_request::<SessionTreeCreate>(&SessionTreeCreateParams {
            tree_id: None,
            definition_id: DefinitionId::parse("test.definition").expect("definition"),
            root_role: RoleId::parse("coordinator").expect("role"),
            difficulty: Difficulty::D1,
            objective: "coordinate the test".to_owned(),
        })
        .expect("create request");
        let created = decode_extension_response::<SessionTreeCreate>(
            conductor.handle_extension(create).expect("create response"),
        )
        .expect("create result");

        let execute = encode_extension_request::<NodeExecute>(&NodeExecuteParams {
            tree_id: created.tree_id.clone(),
            node_id: created.root_node_id,
            command: SessionCommand::Prompt {
                text: "hello".to_owned(),
                images: Vec::new(),
            },
        })
        .expect("execute request");
        let executed = decode_extension_response::<NodeExecute>(
            conductor
                .handle_extension(execute)
                .expect("execute response"),
        )
        .expect("execute result");

        assert_eq!(executed.events.len(), 2);
        assert_eq!(conductor.gateway().list_trees().trees.len(), 1);
    }
}
