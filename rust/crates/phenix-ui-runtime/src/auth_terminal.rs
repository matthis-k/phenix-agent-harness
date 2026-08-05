use crate::UiMailbox;
use phenix_runtime_api::{AuthFlowId, AuthTerminalRequest};
use phenix_ui_core::{AppEvent, TerminalSize};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLUMNS: u16 = 80;
const SCROLLBACK_ROWS: usize = 2_000;

pub trait AuthTerminalHost {
    fn start(
        &mut self,
        flow_id: AuthFlowId,
        request: AuthTerminalRequest,
        size: TerminalSize,
        mailbox: UiMailbox,
    ) -> Result<(), String>;

    fn write(&mut self, flow_id: &AuthFlowId, bytes: &[u8]) -> Result<(), String>;

    fn resize(&mut self, flow_id: &AuthFlowId, size: TerminalSize) -> Result<(), String>;

    fn cancel(&mut self, flow_id: &AuthFlowId) -> Result<(), String>;

    fn release(&mut self, flow_id: &AuthFlowId);
}

#[derive(Default)]
pub struct NativeAuthTerminalHost {
    sessions: BTreeMap<AuthFlowId, NativeAuthTerminalSession>,
}

struct NativeAuthTerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    parser: Arc<Mutex<vt100::Parser>>,
}

impl AuthTerminalHost for NativeAuthTerminalHost {
    fn start(
        &mut self,
        flow_id: AuthFlowId,
        request: AuthTerminalRequest,
        size: TerminalSize,
        mailbox: UiMailbox,
    ) -> Result<(), String> {
        self.release(&flow_id);
        let size = normalized_size(size);
        let pair = native_pty_system()
            .openpty(pty_size(size))
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new(request.program);
        command.args(request.arguments);
        for (name, value) in request.environment {
            command.env(name, value);
        }
        if let Some(cwd) = request.cwd {
            command.cwd(PathBuf::from(cwd));
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let killer = child.clone_killer();
        let parser = Arc::new(Mutex::new(vt100::Parser::new(
            size.height,
            size.width,
            SCROLLBACK_ROWS,
        )));

        let reader_parser = Arc::clone(&parser);
        let reader_flow = flow_id.clone();
        let reader_mailbox = mailbox.clone();
        thread::Builder::new()
            .name(format!("phenix-auth-terminal-reader-{flow_id}"))
            .spawn(move || {
                let mut bytes = [0_u8; 8_192];
                loop {
                    let count = match reader.read(&mut bytes) {
                        Ok(0) | Err(_) => return,
                        Ok(count) => count,
                    };
                    let frame = {
                        let Ok(mut parser) = reader_parser.lock() else {
                            return;
                        };
                        parser.process(&bytes[..count]);
                        let screen = parser.screen();
                        let (cursor_row, cursor_column) = screen.cursor_position();
                        (screen.contents(), cursor_row, cursor_column)
                    };
                    if reader_mailbox
                        .send_app(AppEvent::AuthenticationTerminalFrame {
                            flow_id: reader_flow.clone(),
                            screen: frame.0,
                            cursor_row: frame.1,
                            cursor_column: frame.2,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        let waiter_flow = flow_id.clone();
        thread::Builder::new()
            .name(format!("phenix-auth-terminal-waiter-{flow_id}"))
            .spawn(move || {
                let (success, message) = match child.wait() {
                    Ok(status) => (
                        status.success(),
                        (!status.success())
                            .then(|| format!("authentication process exited: {status:?}")),
                    ),
                    Err(error) => (
                        false,
                        Some(format!("authentication process wait failed: {error}")),
                    ),
                };
                let _ = mailbox.send_app(AppEvent::AuthenticationTerminalExited {
                    flow_id: waiter_flow,
                    success,
                    message,
                });
            })
            .map_err(|error| error.to_string())?;

        self.sessions.insert(
            flow_id,
            NativeAuthTerminalSession {
                master: pair.master,
                writer,
                killer,
                parser,
            },
        );
        Ok(())
    }

    fn write(&mut self, flow_id: &AuthFlowId, bytes: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(flow_id)
            .ok_or_else(|| format!("unknown authentication terminal {flow_id}"))?;
        session
            .writer
            .write_all(bytes)
            .map_err(|error| error.to_string())?;
        session.writer.flush().map_err(|error| error.to_string())
    }

    fn resize(&mut self, flow_id: &AuthFlowId, size: TerminalSize) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(flow_id)
            .ok_or_else(|| format!("unknown authentication terminal {flow_id}"))?;
        let size = normalized_size(size);
        session
            .master
            .resize(pty_size(size))
            .map_err(|error| error.to_string())?;
        session
            .parser
            .lock()
            .map_err(|_| "authentication terminal parser lock poisoned".to_owned())?
            .screen_mut()
            .set_size(size.height, size.width);
        Ok(())
    }

    fn cancel(&mut self, flow_id: &AuthFlowId) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(flow_id)
            .ok_or_else(|| format!("unknown authentication terminal {flow_id}"))?;
        session.killer.kill().map_err(|error| error.to_string())
    }

    fn release(&mut self, flow_id: &AuthFlowId) {
        self.sessions.remove(flow_id);
    }
}

fn normalized_size(size: TerminalSize) -> TerminalSize {
    TerminalSize {
        width: if size.width == 0 {
            DEFAULT_COLUMNS
        } else {
            size.width
        },
        height: if size.height == 0 {
            DEFAULT_ROWS
        } else {
            size.height
        },
    }
}

fn pty_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.height,
        cols: size.width,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_terminal_dimensions_use_usable_defaults() {
        assert_eq!(
            normalized_size(TerminalSize::default()),
            TerminalSize {
                width: DEFAULT_COLUMNS,
                height: DEFAULT_ROWS,
            }
        );
    }
}
