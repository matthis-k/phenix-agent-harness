mod connection;
mod projection;

use crate::{AcpAgentBackend, AcpBackendConfig};
use connection::{SessionBinding, TreeConnection};
use phenix_acp::{
    AcpSession, AcpSessionFactory, AcpSessionId, GatewayError, SessionCommand, SessionEvent,
    SessionOpenRequest, SessionTreeId,
};
use phenix_runtime_api::{BackendCommand, DialogId};
use projection::{
    parse_thinking_level, runtime_images, runtime_interaction_response, runtime_model,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

type TreeRegistry = Arc<Mutex<BTreeMap<SessionTreeId, Arc<Mutex<TreeConnection>>>>>;

impl AcpAgentBackend {
    pub fn gateway_factory(
        config: AcpBackendConfig,
        channel_capacity: usize,
    ) -> impl AcpSessionFactory {
        GatewaySessionFactory {
            config,
            channel_capacity,
            trees: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
}

#[derive(Clone)]
struct GatewaySessionFactory {
    config: AcpBackendConfig,
    channel_capacity: usize,
    trees: TreeRegistry,
}

impl AcpSessionFactory for GatewaySessionFactory {
    fn open(&self, request: SessionOpenRequest) -> Result<Box<dyn AcpSession>, GatewayError> {
        if self.channel_capacity == 0 {
            return Err(GatewayError::session(
                "ACP gateway channel capacity must be positive",
            ));
        }

        let (connection, created) = {
            let mut trees = self
                .trees
                .lock()
                .map_err(|_| GatewayError::session("ACP tree registry lock poisoned"))?;
            if let Some(connection) = trees.get(&request.tree_id) {
                (Arc::clone(connection), false)
            } else {
                let connection = Arc::new(Mutex::new(TreeConnection::start(
                    self.config.clone(),
                    self.channel_capacity,
                )?));
                trees.insert(request.tree_id.clone(), Arc::clone(&connection));
                (connection, true)
            }
        };

        let binding_result = (|| -> Result<SessionBinding, GatewayError> {
            let mut connection_guard = connection
                .lock()
                .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?;
            let binding = connection_guard.open(&request, created)?;
            if let Some(model) = &request.model {
                if let Err(error) = connection_guard.submit(BackendCommand::ModelSelect {
                    run_id: binding.run_id.clone(),
                    model: runtime_model(model),
                }) {
                    let _ = connection_guard.release(&binding.session_id);
                    return Err(error);
                }
            }
            Ok(binding)
        })();

        let binding = match binding_result {
            Ok(binding) => binding,
            Err(error) => {
                if created {
                    let mut trees = self
                        .trees
                        .lock()
                        .map_err(|_| GatewayError::session("ACP tree registry lock poisoned"))?;
                    if trees
                        .get(&request.tree_id)
                        .is_some_and(|candidate| Arc::ptr_eq(candidate, &connection))
                    {
                        trees.remove(&request.tree_id);
                    }
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
        let remove_tree = {
            let mut connection = self
                .connection
                .lock()
                .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?;
            connection.release(&self.session_id)?
        };
        if remove_tree {
            let mut trees = self
                .registry
                .lock()
                .map_err(|_| GatewayError::session("ACP tree registry lock poisoned"))?;
            if trees
                .get(&self.tree_id)
                .is_some_and(|connection| Arc::ptr_eq(connection, &self.connection))
            {
                trees.remove(&self.tree_id);
            }
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
                connection.submit(BackendCommand::PromptSubmit {
                    run_id: self.run_id.clone(),
                    text,
                    images: runtime_images(images),
                    streaming_behavior: None,
                })?;
            }
            SessionCommand::Steer { text, images } => {
                connection.submit(BackendCommand::PromptSteer {
                    run_id: self.run_id.clone(),
                    text,
                    images: runtime_images(images),
                })?;
            }
            SessionCommand::FollowUp { text, images } => {
                connection.submit(BackendCommand::PromptFollowUp {
                    run_id: self.run_id.clone(),
                    text,
                    images: runtime_images(images),
                })?;
            }
            SessionCommand::Compact { instructions } => {
                connection.submit(BackendCommand::CompactionStart {
                    run_id: self.run_id.clone(),
                    instructions,
                })?;
                connection.push(self.run_id.clone(), SessionEvent::Compacted);
            }
            SessionCommand::Poll => connection.drain_available()?,
            SessionCommand::Cancel => {
                connection.submit(BackendCommand::ExecutionAbort {
                    run_id: Some(self.run_id.clone()),
                })?;
            }
            SessionCommand::Rename { name } => {
                connection.submit(BackendCommand::SessionRename {
                    session_id: self.session_id.clone(),
                    name,
                })?;
            }
            SessionCommand::SetModel { model } => {
                connection.submit(BackendCommand::ModelSelect {
                    run_id: self.run_id.clone(),
                    model: runtime_model(&model),
                })?;
            }
            SessionCommand::SetMode { mode_id } => {
                connection.submit(BackendCommand::SessionModeSelect {
                    run_id: self.run_id.clone(),
                    mode_id,
                })?;
            }
            SessionCommand::SetThinking { level } => {
                connection.submit(BackendCommand::ThinkingSelect {
                    run_id: self.run_id.clone(),
                    level: parse_thinking_level(&level)?,
                })?;
            }
            SessionCommand::Invoke { name, arguments } => {
                connection.submit(BackendCommand::CommandInvoke {
                    run_id: self.run_id.clone(),
                    name,
                    arguments,
                })?;
            }
            SessionCommand::RespondInteraction {
                request_id,
                response,
            } => {
                let dialog_id = DialogId::parse(request_id)
                    .map_err(|error| GatewayError::session(error.to_string()))?;
                connection.submit(BackendCommand::ExtensionUiRespond {
                    dialog_id,
                    response: runtime_interaction_response(response),
                })?;
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
