use phenix_acp::acp::schema::v1::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, TerminalExitStatus, TerminalId,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};
use phenix_acp::acp::Error as AcpError;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const WAIT_POLL_PERIOD: Duration = Duration::from_millis(25);
const DEFAULT_OUTPUT_LIMIT: usize = 1_048_576;

#[derive(Clone, Debug)]
pub(crate) enum TerminalEvent {
    Started {
        session_id: String,
        terminal_id: String,
        command: String,
    },
    Finished {
        session_id: String,
        terminal_id: String,
        exit_code: Option<u32>,
    },
}

#[derive(Clone)]
pub(crate) struct TerminalManager {
    inner: Arc<TerminalManagerInner>,
}

struct TerminalManagerInner {
    terminals: Mutex<HashMap<String, Arc<TerminalRecord>>>,
    next_id: AtomicU64,
    event_tx: futures::channel::mpsc::UnboundedSender<TerminalEvent>,
}

struct TerminalRecord {
    session_id: String,
    terminal_id: String,
    child: Mutex<Option<Child>>,
    output: Mutex<OutputBuffer>,
    exit_status: Mutex<Option<TerminalExitStatus>>,
    finished_notified: AtomicBool,
    event_tx: futures::channel::mpsc::UnboundedSender<TerminalEvent>,
}

struct OutputBuffer {
    text: String,
    limit: usize,
    truncated: bool,
}

impl OutputBuffer {
    fn new(limit: usize) -> Self {
        Self {
            text: String::new(),
            limit: limit.max(1),
            truncated: false,
        }
    }

    fn append(&mut self, text: &str) {
        self.text.push_str(text);
        if self.text.len() <= self.limit {
            return;
        }
        let mut start = self.text.len().saturating_sub(self.limit);
        while start < self.text.len() && !self.text.is_char_boundary(start) {
            start += 1;
        }
        self.text.drain(..start);
        self.truncated = true;
    }
}

impl TerminalManager {
    pub fn new(event_tx: futures::channel::mpsc::UnboundedSender<TerminalEvent>) -> Self {
        Self {
            inner: Arc::new(TerminalManagerInner {
                terminals: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                event_tx,
            }),
        }
    }

    pub async fn create(
        &self,
        request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, AcpError> {
        let manager = self.clone();
        blocking::unblock(move || manager.create_blocking(request)).await
    }

    pub async fn output(
        &self,
        request: TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse, AcpError> {
        let record = self.record(&request.terminal_id)?;
        refresh_exit_status(&record)?;
        let output = record
            .output
            .lock()
            .map_err(|_| internal_error("terminal output lock poisoned"))?;
        let status = record
            .exit_status
            .lock()
            .map_err(|_| internal_error("terminal status lock poisoned"))?
            .clone();
        Ok(TerminalOutputResponse::new(output.text.clone(), output.truncated).exit_status(status))
    }

    pub async fn wait(
        &self,
        request: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, AcpError> {
        let manager = self.clone();
        blocking::unblock(move || manager.wait_blocking(request)).await
    }

    pub async fn kill(
        &self,
        request: KillTerminalRequest,
    ) -> Result<KillTerminalResponse, AcpError> {
        let record = self.record(&request.terminal_id)?;
        let mut child = record
            .child
            .lock()
            .map_err(|_| internal_error("terminal process lock poisoned"))?;
        if let Some(child) = child.as_mut() {
            child
                .kill()
                .map_err(|error| internal_error(format!("failed to kill terminal: {error}")))?;
        }
        Ok(KillTerminalResponse::new())
    }

    pub async fn release(
        &self,
        request: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, AcpError> {
        let key = request.terminal_id.to_string();
        let record = self
            .inner
            .terminals
            .lock()
            .map_err(|_| internal_error("terminal registry lock poisoned"))?
            .remove(&key)
            .ok_or_else(|| invalid_terminal(&request.terminal_id))?;
        let mut child = record
            .child
            .lock()
            .map_err(|_| internal_error("terminal process lock poisoned"))?;
        if let Some(child) = child.as_mut() {
            if child
                .try_wait()
                .map_err(|error| internal_error(format!("failed to inspect terminal: {error}")))?
                .is_none()
            {
                let _ = child.kill();
            }
        }
        Ok(ReleaseTerminalResponse::new())
    }

    fn create_blocking(
        &self,
        request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, AcpError> {
        let sequence = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let terminal_id = format!("phenix-terminal-{sequence}");
        let mut command = Command::new(&request.command);
        command
            .args(&request.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &request.cwd {
            command.current_dir(cwd);
        }
        for variable in &request.env {
            command.env(&variable.name, &variable.value);
        }
        let mut child = command.spawn().map_err(|error| {
            internal_error(format!(
                "failed to start terminal command `{}`: {error}",
                request.command
            ))
        })?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let limit = request
            .output_byte_limit
            .and_then(|limit| usize::try_from(limit).ok())
            .unwrap_or(DEFAULT_OUTPUT_LIMIT);
        let record = Arc::new(TerminalRecord {
            session_id: request.session_id.to_string(),
            terminal_id: terminal_id.clone(),
            child: Mutex::new(Some(child)),
            output: Mutex::new(OutputBuffer::new(limit)),
            exit_status: Mutex::new(None),
            finished_notified: AtomicBool::new(false),
            event_tx: self.inner.event_tx.clone(),
        });
        if let Some(stdout) = stdout {
            spawn_reader(Arc::clone(&record), stdout, "phenix-acp-terminal-stdout")?;
        }
        if let Some(stderr) = stderr {
            spawn_reader(Arc::clone(&record), stderr, "phenix-acp-terminal-stderr")?;
        }
        self.inner
            .terminals
            .lock()
            .map_err(|_| internal_error("terminal registry lock poisoned"))?
            .insert(terminal_id.clone(), record);
        self.inner
            .event_tx
            .unbounded_send(TerminalEvent::Started {
                session_id: request.session_id.to_string(),
                terminal_id: terminal_id.clone(),
                command: std::iter::once(request.command)
                    .chain(request.args)
                    .collect::<Vec<_>>()
                    .join(" "),
            })
            .map_err(|_| internal_error("ACP backend event channel closed"))?;
        Ok(CreateTerminalResponse::new(terminal_id))
    }

    fn wait_blocking(
        &self,
        request: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, AcpError> {
        let record = self.record(&request.terminal_id)?;
        loop {
            refresh_exit_status(&record)?;
            if let Some(status) = record
                .exit_status
                .lock()
                .map_err(|_| internal_error("terminal status lock poisoned"))?
                .clone()
            {
                return Ok(WaitForTerminalExitResponse::new(status));
            }
            thread::sleep(WAIT_POLL_PERIOD);
        }
    }

    fn record(&self, terminal_id: &TerminalId) -> Result<Arc<TerminalRecord>, AcpError> {
        self.inner
            .terminals
            .lock()
            .map_err(|_| internal_error("terminal registry lock poisoned"))?
            .get(&terminal_id.to_string())
            .cloned()
            .ok_or_else(|| invalid_terminal(terminal_id))
    }
}

fn refresh_exit_status(record: &TerminalRecord) -> Result<(), AcpError> {
    if record
        .exit_status
        .lock()
        .map_err(|_| internal_error("terminal status lock poisoned"))?
        .is_some()
    {
        return Ok(());
    }
    let mut child_guard = record
        .child
        .lock()
        .map_err(|_| internal_error("terminal process lock poisoned"))?;
    let Some(child) = child_guard.as_mut() else {
        return Ok(());
    };
    let Some(status) = child
        .try_wait()
        .map_err(|error| internal_error(format!("failed to inspect terminal: {error}")))?
    else {
        return Ok(());
    };
    let projected = project_exit_status(status);
    *record
        .exit_status
        .lock()
        .map_err(|_| internal_error("terminal status lock poisoned"))? = Some(projected.clone());
    *child_guard = None;
    if !record.finished_notified.swap(true, Ordering::AcqRel) {
        record
            .event_tx
            .unbounded_send(TerminalEvent::Finished {
                session_id: record.session_id.clone(),
                terminal_id: record.terminal_id.clone(),
                exit_code: status.code().and_then(|code| u32::try_from(code).ok()),
            })
            .map_err(|_| internal_error("ACP backend event channel closed"))?;
    }
    Ok(())
}

fn project_exit_status(status: ExitStatus) -> TerminalExitStatus {
    status
        .code()
        .and_then(|code| u32::try_from(code).ok())
        .map_or_else(
            || TerminalExitStatus::new().signal("terminated by signal"),
            |code| TerminalExitStatus::new().exit_code(code),
        )
}

fn spawn_reader(
    record: Arc<TerminalRecord>,
    mut reader: impl Read + Send + 'static,
    thread_name: &str,
) -> Result<(), AcpError> {
    thread::Builder::new()
        .name(thread_name.to_owned())
        .spawn(move || {
            let mut bytes = [0_u8; 8_192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => return,
                    Ok(count) => {
                        let text = String::from_utf8_lossy(&bytes[..count]);
                        if let Ok(mut output) = record.output.lock() {
                            output.append(&text);
                        }
                    }
                    Err(_) => return,
                }
            }
        })
        .map(|_| ())
        .map_err(|error| internal_error(format!("failed to start terminal reader: {error}")))
}

fn invalid_terminal(terminal_id: &TerminalId) -> AcpError {
    AcpError::invalid_params().data(format!("unknown terminal `{terminal_id}`"))
}

fn internal_error(message: impl Into<String>) -> AcpError {
    AcpError::internal_error().data(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_buffer_truncates_at_utf8_boundaries() {
        let mut output = OutputBuffer::new(5);
        output.append("abé中");
        assert!(output.text.is_char_boundary(0));
        assert!(output.text.len() <= 5);
        assert!(output.truncated);
    }
}
