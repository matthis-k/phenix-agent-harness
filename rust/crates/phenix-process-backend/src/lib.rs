#![forbid(unsafe_code)]

mod wire;

use phenix_runtime_api::{
    AgentBackend, BackendError, BackendEvent, BackendOutputSender, BackendRequest,
    NotificationLevel, RequestId,
};
use std::collections::{BTreeMap, HashMap};
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;
use wire::{decode_event, decode_reply, encode_request, PendingReply, WireOutboundFrame};

const DEFAULT_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const CHILD_POLL_PERIOD: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessBackendConfig {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
    pub max_frame_bytes: usize,
}

impl ProcessBackendConfig {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            arguments: Vec::new(),
            environment: BTreeMap::new(),
            cwd: None,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
        }
    }

    pub fn validate(&self) -> Result<(), BackendError> {
        if self.program.as_os_str().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "process backend program must not be empty".to_owned(),
            ));
        }
        if self.max_frame_bytes == 0 {
            return Err(BackendError::InvalidConfiguration(
                "process backend frame limit must be positive".to_owned(),
            ));
        }
        Ok(())
    }
}

pub struct ProcessAgentBackend {
    config: ProcessBackendConfig,
}

impl ProcessAgentBackend {
    pub fn new(config: ProcessBackendConfig) -> Result<Self, BackendError> {
        config.validate()?;
        Ok(Self { config })
    }
}

impl AgentBackend for ProcessAgentBackend {
    fn run(
        self: Box<Self>,
        requests: Receiver<BackendRequest>,
        outputs: BackendOutputSender,
    ) -> Result<(), BackendError> {
        let mut child = spawn_child(&self.config)?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            BackendError::Start("headless runtime stdin was not captured".to_owned())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            BackendError::Start("headless runtime stdout was not captured".to_owned())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            BackendError::Start("headless runtime stderr was not captured".to_owned())
        })?;

        let (driver_sender, driver_inputs) = mpsc::channel();
        spawn_request_forwarder(requests, driver_sender.clone())?;
        spawn_stdout_reader(stdout, self.config.max_frame_bytes, driver_sender.clone())?;
        spawn_stderr_reader(stderr, driver_sender)?;

        let mut pending = HashMap::<RequestId, PendingReply>::new();
        loop {
            match driver_inputs.recv_timeout(CHILD_POLL_PERIOD) {
                Ok(DriverInput::Request(request)) => {
                    let reply_kind = PendingReply::for_command(&request.command);
                    write_json_line(&mut stdin, &encode_request(&request)?)?;
                    pending.insert(request.id, reply_kind);
                }
                Ok(DriverInput::RequestsClosed) => {
                    let _ = child.kill();
                }
                Ok(DriverInput::Frame(WireOutboundFrame::Response { id, result })) => {
                    let request_id = RequestId::parse(id)
                        .map_err(|error| BackendError::Protocol(error.to_string()))?;
                    let reply_kind = pending.remove(&request_id).ok_or_else(|| {
                        BackendError::Protocol(format!(
                            "runtime replied to unknown request {request_id}"
                        ))
                    })?;
                    let reply = if result.ok {
                        decode_reply(reply_kind, result.reply.unwrap_or_default())
                    } else {
                        let error = result.error.ok_or_else(|| {
                            BackendError::Protocol(
                                "failed runtime reply did not contain an error".to_owned(),
                            )
                        })?;
                        Err(BackendError::Protocol(format!(
                            "{}: {}",
                            error.code, error.message
                        )))
                    };
                    outputs.reply(request_id, reply)?;
                }
                Ok(DriverInput::Frame(WireOutboundFrame::Event { event })) => {
                    if let Some(event) = decode_event(event)? {
                        outputs.event(event)?;
                    }
                }
                Ok(DriverInput::ProtocolFailure(message)) => {
                    return fail_process(
                        &mut child,
                        &outputs,
                        &mut pending,
                        BackendError::Protocol(message),
                    );
                }
                Ok(DriverInput::StdoutClosed) => {
                    let status = child
                        .wait()
                        .map_err(|error| BackendError::Transport(error.to_string()))?;
                    return finish_child(status, &outputs, &mut pending);
                }
                Ok(DriverInput::Stderr(line)) => {
                    outputs.event(BackendEvent::Notification {
                        level: NotificationLevel::Warning,
                        message: format!("Pi runtime: {line}"),
                    })?;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    let _ = child.kill();
                    let status = child
                        .wait()
                        .map_err(|error| BackendError::Transport(error.to_string()))?;
                    return finish_child(status, &outputs, &mut pending);
                }
            }

            if let Some(status) = child
                .try_wait()
                .map_err(|error| BackendError::Transport(error.to_string()))?
            {
                return finish_child(status, &outputs, &mut pending);
            }
        }
    }
}

fn spawn_child(config: &ProcessBackendConfig) -> Result<Child, BackendError> {
    let mut command = Command::new(&config.program);
    command
        .args(&config.arguments)
        .envs(&config.environment)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &config.cwd {
        command.current_dir(cwd);
    }
    command
        .spawn()
        .map_err(|error| BackendError::Start(error.to_string()))
}

#[derive(Debug)]
enum DriverInput {
    Request(BackendRequest),
    RequestsClosed,
    Frame(WireOutboundFrame),
    ProtocolFailure(String),
    StdoutClosed,
    Stderr(String),
}

fn spawn_request_forwarder(
    requests: Receiver<BackendRequest>,
    sender: Sender<DriverInput>,
) -> Result<(), BackendError> {
    thread::Builder::new()
        .name("phenix-process-requests".to_owned())
        .spawn(move || {
            for request in requests {
                if sender.send(DriverInput::Request(request)).is_err() {
                    return;
                }
            }
            let _ = sender.send(DriverInput::RequestsClosed);
        })
        .map(|_| ())
        .map_err(|error| BackendError::Start(error.to_string()))
}

fn spawn_stdout_reader(
    stdout: ChildStdout,
    max_frame_bytes: usize,
    sender: Sender<DriverInput>,
) -> Result<(), BackendError> {
    thread::Builder::new()
        .name("phenix-process-stdout".to_owned())
        .spawn(move || read_stdout(stdout, max_frame_bytes, sender))
        .map(|_| ())
        .map_err(|error| BackendError::Start(error.to_string()))
}

fn read_stdout(stdout: ChildStdout, max_frame_bytes: usize, sender: Sender<DriverInput>) {
    let mut reader = BufReader::new(stdout);
    let mut frame = Vec::new();
    loop {
        frame.clear();
        match read_limited_line(&mut reader, &mut frame, max_frame_bytes) {
            Ok(false) => {
                let _ = sender.send(DriverInput::StdoutClosed);
                return;
            }
            Ok(true) if frame.is_empty() => continue,
            Ok(true) => match serde_json::from_slice::<WireOutboundFrame>(&frame) {
                Ok(decoded) => {
                    if sender.send(DriverInput::Frame(decoded)).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(DriverInput::ProtocolFailure(error.to_string()));
                    return;
                }
            },
            Err(error) => {
                let _ = sender.send(DriverInput::ProtocolFailure(error.to_string()));
                return;
            }
        }
    }
}

fn read_limited_line(
    reader: &mut impl BufRead,
    output: &mut Vec<u8>,
    max_bytes: usize,
) -> io::Result<bool> {
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(!output.is_empty());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content_end = newline.unwrap_or(available.len());
        if output.len().saturating_add(content_end) > max_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("runtime JSONL frame exceeds {max_bytes} bytes"),
            ));
        }
        output.extend_from_slice(&available[..content_end]);
        reader.consume(consumed);
        if newline.is_some() {
            if output.last() == Some(&b'\r') {
                output.pop();
            }
            return Ok(true);
        }
    }
}

fn spawn_stderr_reader(stderr: ChildStderr, sender: Sender<DriverInput>) -> Result<(), BackendError> {
    thread::Builder::new()
        .name("phenix-process-stderr".to_owned())
        .spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(error) => {
                        let _ = sender.send(DriverInput::Stderr(error.to_string()));
                        return;
                    }
                };
                if sender.send(DriverInput::Stderr(line)).is_err() {
                    return;
                }
            }
        })
        .map(|_| ())
        .map_err(|error| BackendError::Start(error.to_string()))
}

fn write_json_line(writer: &mut impl Write, frame: &serde_json::Value) -> Result<(), BackendError> {
    serde_json::to_writer(&mut *writer, frame)
        .map_err(|error| BackendError::Protocol(error.to_string()))?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|error| BackendError::Transport(error.to_string()))
}

fn finish_child(
    status: ExitStatus,
    outputs: &BackendOutputSender,
    pending: &mut HashMap<RequestId, PendingReply>,
) -> Result<(), BackendError> {
    if status.success() {
        fail_pending(outputs, pending, BackendError::Disconnected)?;
        return Ok(());
    }
    let error = BackendError::Transport(format!("headless runtime exited with {status}"));
    fail_pending(outputs, pending, error.clone())?;
    Err(error)
}

fn fail_process(
    child: &mut Child,
    outputs: &BackendOutputSender,
    pending: &mut HashMap<RequestId, PendingReply>,
    error: BackendError,
) -> Result<(), BackendError> {
    let _ = child.kill();
    fail_pending(outputs, pending, error.clone())?;
    Err(error)
}

fn fail_pending(
    outputs: &BackendOutputSender,
    pending: &mut HashMap<RequestId, PendingReply>,
    error: BackendError,
) -> Result<(), BackendError> {
    for request_id in pending.drain().map(|(request_id, _)| request_id) {
        outputs.reply(request_id, Err(error.clone()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn line_reader_bounds_one_frame_without_rejecting_aggregate_input() {
        let mut reader = Cursor::new(b"{\"a\":1}\n{\"b\":2}\n".to_vec());
        let mut frame = Vec::new();
        assert!(read_limited_line(&mut reader, &mut frame, 8).expect("first frame"));
        assert_eq!(frame, b"{\"a\":1}");
        frame.clear();
        assert!(read_limited_line(&mut reader, &mut frame, 8).expect("second frame"));
        assert_eq!(frame, b"{\"b\":2}");
    }

    #[test]
    fn line_reader_rejects_unbounded_partial_frames() {
        let mut reader = Cursor::new(b"0123456789".to_vec());
        let mut frame = Vec::new();
        let error = read_limited_line(&mut reader, &mut frame, 8).expect_err("oversized frame");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
