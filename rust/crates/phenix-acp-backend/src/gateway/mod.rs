mod connection;
mod projection;

use crate::{AcpAgentBackend, AcpBackendConfig};
use connection::{SessionBinding, TreeConnection};
use phenix_acp::{
    AcpSession, AcpSessionFactory, AcpSessionId, GatewayError, SessionCommand, SessionEvent,
    SessionNodeId, SessionOpenRequest, SessionTreeId, ToolProvision,
};
use phenix_runtime_api::{BackendCommand, BackendEvent, BackendReply, DialogId, RuntimeSnapshot};
use projection::{
    parse_thinking_level, runtime_images, runtime_interaction_response, runtime_model,
};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

type ConnectionKey = (SessionTreeId, SessionNodeId);
type ConnectionRegistry = Arc<Mutex<BTreeMap<ConnectionKey, Arc<Mutex<TreeConnection>>>>>;
type ControlRegistry = Arc<Mutex<BTreeMap<SessionTreeId, Arc<Mutex<TreeConnection>>>>>;

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
    connections: ConnectionRegistry,
    controls: ControlRegistry,
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
            connections: Arc::new(Mutex::new(BTreeMap::new())),
            controls: Arc::new(Mutex::new(BTreeMap::new())),
        })
    }

    pub fn control(&self, tree_id: SessionTreeId) -> Result<AcpTreeControl, GatewayError> {
        let existing = self
            .connections
            .lock()
            .map_err(|_| GatewayError::session("ACP connection registry lock poisoned"))?
            .iter()
            .find(|((candidate_tree, _), _)| candidate_tree == &tree_id)
            .map(|(key, connection)| (key.clone(), Arc::clone(connection)));
        let (connection, registration) = if let Some((key, connection)) = existing {
            (
                connection,
                ControlRegistration::Session {
                    key,
                    registry: Arc::clone(&self.connections),
                },
            )
        } else {
            let mut controls = self
                .controls
                .lock()
                .map_err(|_| GatewayError::session("ACP control registry lock poisoned"))?;
            let connection = match controls.get(&tree_id) {
                Some(connection) => Arc::clone(connection),
                None => {
                    let connection = Arc::new(Mutex::new(TreeConnection::start(
                        self.config.clone(),
                        self.channel_capacity,
                        None,
                    )?));
                    controls.insert(tree_id.clone(), Arc::clone(&connection));
                    connection
                }
            };
            (
                connection,
                ControlRegistration::Control {
                    tree_id,
                    registry: Arc::clone(&self.controls),
                },
            )
        };
        connection
            .lock()
            .map_err(|_| GatewayError::session("ACP session connection lock poisoned"))?
            .retain_control()?;
        Ok(AcpTreeControl {
            connection,
            registration,
            released: false,
        })
    }

    fn connection(
        &self,
        request: &SessionOpenRequest,
        tools: ToolProvision,
    ) -> Result<(ConnectionKey, Arc<Mutex<TreeConnection>>), GatewayError> {
        let key = (request.tree_id.clone(), request.node_id.clone());
        let mut connections = self
            .connections
            .lock()
            .map_err(|_| GatewayError::session("ACP connection registry lock poisoned"))?;
        if connections.contains_key(&key) {
            return Err(GatewayError::session(format!(
                "session node {} already has a downstream ACP connection",
                request.node_id
            )));
        }
        let connection = Arc::new(Mutex::new(TreeConnection::start(
            self.config.clone(),
            self.channel_capacity,
            Some(tools),
        )?));
        connections.insert(key.clone(), Arc::clone(&connection));
        Ok((key, connection))
    }
}

impl AcpSessionFactory for AcpGatewayTransport {
    fn open(
        &self,
        request: SessionOpenRequest,
        tools: ToolProvision,
    ) -> Result<Box<dyn AcpSession>, GatewayError> {
        let (key, connection) = self.connection(&request, tools)?;
        let binding_result = (|| -> Result<SessionBinding, GatewayError> {
            let mut connection_guard = connection
                .lock()
                .map_err(|_| GatewayError::session("ACP session connection lock poisoned"))?;
            let binding = connection_guard.open(&request)?;
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
                remove_registered_connection(&self.connections, &key, &connection)?;
                return Err(error);
            }
        };

        Ok(Box::new(GatewayAcpSession {
            id: binding.acp_id,
            session_id: binding.session_id,
            run_id: binding.run_id,
            key,
            connection,
            registry: Arc::clone(&self.connections),
            closed: false,
        }))
    }
}

pub struct AcpTreeControl {
    connection: Arc<Mutex<TreeConnection>>,
    registration: ControlRegistration,
    released: bool,
}

enum ControlRegistration {
    Session {
        key: ConnectionKey,
        registry: ConnectionRegistry,
    },
    Control {
        tree_id: SessionTreeId,
        registry: ControlRegistry,
    },
}

impl AcpTreeControl {
    pub fn submit(&mut self, command: BackendCommand) -> Result<BackendReply, GatewayError> {
        self.connection
            .lock()
            .map_err(|_| GatewayError::session("ACP session connection lock poisoned"))?
            .submit(command)
    }

    pub fn snapshot(&mut self) -> Result<RuntimeSnapshot, GatewayError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| GatewayError::session("ACP session connection lock poisoned"))?;
        connection.drain_available()?;
        Ok(connection.snapshot())
    }

    pub fn drain_events(&mut self) -> Result<Vec<BackendEvent>, GatewayError> {
        self.connection
            .lock()
            .map_err(|_| GatewayError::session("ACP session connection lock poisoned"))?
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
            .map_err(|_| GatewayError::session("ACP session connection lock poisoned"))?
            .release_control()?;
        if remove_tree {
            match &self.registration {
                ControlRegistration::Session { key, registry } => {
                    remove_registered_connection(registry, key, &self.connection)?;
                }
                ControlRegistration::Control { tree_id, registry } => {
                    remove_registered_control(registry, tree_id, &self.connection)?;
                }
            }
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
    key: ConnectionKey,
    connection: Arc<Mutex<TreeConnection>>,
    registry: ConnectionRegistry,
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
            .map_err(|_| GatewayError::session("ACP session connection lock poisoned"))?
            .release(&self.session_id)?;
        if remove_tree {
            remove_registered_connection(&self.registry, &self.key, &self.connection)?;
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
            .map_err(|_| GatewayError::session("ACP session connection lock poisoned"))?;
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
                    level: parse_thinking_level(&level.to_string())?,
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

fn remove_registered_connection(
    registry: &ConnectionRegistry,
    key: &ConnectionKey,
    connection: &Arc<Mutex<TreeConnection>>,
) -> Result<(), GatewayError> {
    let mut connections = registry
        .lock()
        .map_err(|_| GatewayError::session("ACP connection registry lock poisoned"))?;
    if connections
        .get(key)
        .is_some_and(|candidate| Arc::ptr_eq(candidate, connection))
    {
        connections.remove(key);
    }
    Ok(())
}

fn remove_registered_control(
    registry: &ControlRegistry,
    tree_id: &SessionTreeId,
    connection: &Arc<Mutex<TreeConnection>>,
) -> Result<(), GatewayError> {
    let mut controls = registry
        .lock()
        .map_err(|_| GatewayError::session("ACP control registry lock poisoned"))?;
    if controls
        .get(tree_id)
        .is_some_and(|candidate| Arc::ptr_eq(candidate, connection))
    {
        controls.remove(tree_id);
    }
    Ok(())
}
