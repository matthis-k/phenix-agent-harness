mod connection;
mod projection;

use crate::{AcpAgentBackend, AcpBackendConfig};
use connection::{SessionBinding, TreeConnection};
use phenix_acp::{
    AcpSession, AcpSessionFactory, AcpSessionId, GatewayError, SessionCommand, SessionEvent,
    SessionOpenRequest, SessionTreeId,
};
use phenix_runtime_api::{BackendCommand, BackendEvent, BackendReply, DialogId, RuntimeSnapshot};
use projection::{
    parse_thinking_level, runtime_images, runtime_interaction_response, runtime_model,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

type TreeRegistry = Arc<Mutex<BTreeMap<SessionTreeId, Arc<Mutex<TreeConnection>>>>>;

impl AcpAgentBackend {
    pub fn gateway_transport(
        config: AcpBackendConfig,
        channel_capacity: usize,
    ) -> Result<AcpGatewayTransport, GatewayError> {
        AcpGatewayTransport::new(config, channel_capacity)
    }
}

#[derive(Clone)]
pub struct AcpGatewayTransport {
    config: AcpBackendConfig,
    channel_capacity: usize,
    trees: TreeRegistry,
}

impl AcpGatewayTransport {
    fn new(config: AcpBackendConfig, channel_capacity: usize) -> Result<Self, GatewayError> {
        if channel_capacity == 0 {
            return Err(GatewayError::session(
                "ACP gateway channel capacity must be positive",
            ));
        }
        Ok(Self {
            config,
            channel_capacity,
            trees: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }

    pub fn control(&self, tree_id: SessionTreeId) -> Result<AcpTreeControl, GatewayError> {
        let (connection, _) = self.connection(&tree_id)?;
        connection
            .lock()
            .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?
            .retain_control()?;
        Ok(AcpTreeControl {
            tree_id,
            connection,
            registry: Arc::clone(&self.trees),
            released: false,
        })
    }

    fn connection(
        &self,
        tree_id: &SessionTreeId,
    ) -> Result<(Arc<Mutex<TreeConnection>>, bool), GatewayError> {
        let mut trees = self
            .trees
            .lock()
            .map_err(|_| GatewayError::session("ACP tree registry lock poisoned"))?;
        if let Some(connection) = trees.get(tree_id) {
            return Ok((Arc::clone(connection), false));
        }
        let connection = Arc::new(Mutex::new(TreeConnection::start(
            self.config.clone(),
            self.channel_capacity,
        )?));
        trees.insert(tree_id.clone(), Arc::clone(&connection));
        Ok((connection, true))
    }
}

impl AcpSessionFactory for AcpGatewayTransport {
    fn open(&self, request: SessionOpenRequest) -> Result<Box<dyn AcpSession>, GatewayError> {
        let (connection, created) = self.connection(&request.tree_id)?;
        let binding_result = (|| -> Result<SessionBinding, GatewayError> {
            let mut connection_guard = connection
                .lock()
                .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?;
            let binding = connection_guard.open(&request, created)?;
            let selection = request.model.selection();
            if let Err(error) = connection_guard.submit(BackendCommand::ModelSelect {
                run_id: binding.run_id.clone(),
                model: runtime_model(&selection),
            }) {
                let _ = connection_guard.release(&binding.session_id);
                return Err(error);
            }
            if let Err(error) = connection_guard.submit(BackendCommand::ThinkingSelect {
                run_id: binding.run_id.clone(),
                level: parse_thinking_level(&request.model.thinking.to_string())?,
            }) {
                let _ = connection_guard.release(&binding.session_id);
                return Err(error);
            }
            Ok(binding)
        })();

        let binding = match binding_result {
            Ok(binding) => binding,
            Err(error) => {
                if created {
                    remove_registered_connection(&self.trees, &request.tree_id, &connection)?;
                }
                return Err(error);
            }
        };

        Ok(Box::new(GatewayAcpSession {
            id: binding.acp_id,
            session_id: binding.session_id,
            run_id: binding.run_id,
            tree_id: request.tree_id,
            connection,
            registry: Arc::clone(&self.trees),
            closed: false,
        }))
    }
}

pub struct AcpTreeControl {
    tree_id: SessionTreeId,
    connection: Arc<Mutex<TreeConnection>>,
    registry: TreeRegistry,
    released: bool,
}

impl AcpTreeControl {
    pub fn submit(&mut self, command: BackendCommand) -> Result<BackendReply, GatewayError> {
        self.connection
            .lock()
            .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?
            .submit(command)
    }

    pub fn snapshot(&mut self) -> Result<RuntimeSnapshot, GatewayError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?;
        connection.drain_available()?;
        Ok(connection.snapshot())
    }

    pub fn drain_events(&mut self) -> Result<Vec<BackendEvent>, GatewayError> {
        self.connection
            .lock()
            .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?
            .drain_control_events()
    }

    pub fn release(mut self) -> Result<(), GatewayError> {
        self.release_inner()
    }

    fn release_inner(&mut self) -> Result<(), GatewayError> {
        if self.released {
            return Ok(());
        }
        self.released = true;
        let remove_tree = self
            .connection
            .lock()
            .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?
            .release_control()?;
        if remove_tree {
            remove_registered_connection(&self.registry, &self.tree_id, &self.connection)?;
        }
        Ok(())
    }
}

impl Drop for AcpTreeControl {
    fn drop(&mut self) {
        let _ = self.release_inner();
    }
}

struct GatewayAcpSession {
    id: AcpSessionId,
    session_id: phenix_runtime_api::SessionId,
    run_id: phenix_runtime_api::RunId,
    tree_id: SessionTreeId,
    connection: Arc<Mutex<TreeConnection>>,
    registry: TreeRegistry,
    closed: bool,
}

impl GatewayAcpSession {
    fn close(&mut self) -> Result<(), GatewayError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let remove_tree = self
            .connection
            .lock()
            .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?
            .release(&self.session_id)?;
        if remove_tree {
            remove_registered_connection(&self.registry, &self.tree_id, &self.connection)?;
        }
        Ok(())
    }
}

impl AcpSession for GatewayAcpSession {
    fn id(&self) -> &AcpSessionId {
        &self.id
    }

    fn execute(&mut self, command: SessionCommand) -> Result<Vec<SessionEvent>, GatewayError> {
        if matches!(&command, SessionCommand::Close) {
            self.close()?;
            return Ok(Vec::new());
        }
        if self.closed {
            return Err(GatewayError::session(format!(
                "ACP session {} is closed",
                self.id
            )));
        }

        let mut connection = self
            .connection
            .lock()
            .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?;
        match command {
            SessionCommand::Prompt { text, images } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::PromptSubmit {
                        run_id: self.run_id.clone(),
                        text,
                        images: runtime_images(images),
                        streaming_behavior: None,
                    },
                )?;
            }
            SessionCommand::Steer { text, images } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::PromptSteer {
                        run_id: self.run_id.clone(),
                        text,
                        images: runtime_images(images),
                    },
                )?;
            }
            SessionCommand::FollowUp { text, images } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::PromptFollowUp {
                        run_id: self.run_id.clone(),
                        text,
                        images: runtime_images(images),
                    },
                )?;
            }
            SessionCommand::Compact { instructions } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::CompactionStart {
                        run_id: self.run_id.clone(),
                        instructions,
                    },
                )?;
                connection.push(self.run_id.clone(), SessionEvent::Compacted);
            }
            SessionCommand::Poll => connection.drain_available()?,
            SessionCommand::Cancel => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::ExecutionAbort {
                        run_id: Some(self.run_id.clone()),
                    },
                )?;
            }
            SessionCommand::Rename { name } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::SessionRename {
                        session_id: self.session_id.clone(),
                        name,
                    },
                )?;
            }
            SessionCommand::SetModel { model } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::ModelSelect {
                        run_id: self.run_id.clone(),
                        model: runtime_model(&model),
                    },
                )?;
            }
            SessionCommand::SetMode { mode_id } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::SessionModeSelect {
                        run_id: self.run_id.clone(),
                        mode_id,
                    },
                )?;
            }
            SessionCommand::SetThinking { level } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::ThinkingSelect {
                        run_id: self.run_id.clone(),
                        level: parse_thinking_level(&level.to_string())?,
                    },
                )?;
            }
            SessionCommand::Invoke { name, arguments } => {
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::CommandInvoke {
                        run_id: self.run_id.clone(),
                        name,
                        arguments,
                    },
                )?;
            }
            SessionCommand::RespondInteraction {
                request_id,
                response,
            } => {
                let dialog_id = DialogId::parse(request_id)
                    .map_err(|error| GatewayError::session(error.to_string()))?;
                connection.submit_deferred(
                    &self.run_id,
                    BackendCommand::ExtensionUiRespond {
                        dialog_id,
                        response: runtime_interaction_response(response),
                    },
                )?;
            }
            SessionCommand::Close => unreachable!("close handled before connection lock"),
        }
        connection.drain_events(&self.run_id)
    }
}

impl Drop for GatewayAcpSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn remove_registered_connection(
    registry: &TreeRegistry,
    tree_id: &SessionTreeId,
    connection: &Arc<Mutex<TreeConnection>>,
) -> Result<(), GatewayError> {
    let mut trees = registry
        .lock()
        .map_err(|_| GatewayError::session("ACP tree registry lock poisoned"))?;
    if trees
        .get(tree_id)
        .is_some_and(|candidate| Arc::ptr_eq(candidate, connection))
    {
        trees.remove(tree_id);
    }
    Ok(())
}
