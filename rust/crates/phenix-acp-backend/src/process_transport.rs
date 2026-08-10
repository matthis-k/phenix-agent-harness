use blocking::Unblock;
use phenix_acp::acp::{AcpAgent, AcpAgentConfig, Agent, ByteStreams, Client, ConnectTo};
use std::collections::VecDeque;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, ChildStderr, Command, ExitStatus, Stdio};
use std::str::FromStr;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

const STDERR_CAPTURE_LIMIT: usize = 64 * 1024;
const STDERR_READ_BUFFER_SIZE: usize = 8 * 1024;
const CHILD_SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_secs(1);
const STDERR_SHUTDOWN_GRACE_PERIOD: Duration = Duration::from_millis(100);
const CHILD_WAIT_POLL_PERIOD: Duration = Duration::from_millis(10);

/// ACP subprocess transport backed by blocking file-descriptor reads.
///
/// `agent-client-protocol` 2.0.0's `AcpAgent` transport uses `async-process`
/// pipes. With the current `futures` release, `FuturesUnordered` can present a
/// different waker identity on successive polls, causing `async-io` to
/// synchronously re-wake an otherwise idle pipe reader. On Linux that spins a
/// complete CPU core per ACP subprocess connection.
///
/// Keep the SDK's parser and protocol transport, but put the child pipes behind
/// `blocking::Unblock`, like the SDK's own `Stdio` transport. The blocking read
/// thread parks in the OS while the child is idle, so work once again scales
/// with actual bytes received rather than poll frequency.
pub(crate) struct BlockingAcpAgent {
    launch: AcpAgentConfig,
}

impl BlockingAcpAgent {
    pub(crate) fn from_command(
        command: &str,
        _session_cwd: PathBuf,
    ) -> Result<Self, phenix_acp::acp::Error> {
        let launch = AcpAgent::from_str(command)?.into_config();
        Ok(Self { launch })
    }
}

impl ConnectTo<Client> for BlockingAcpAgent {
    async fn connect_to(
        self,
        client: impl ConnectTo<Agent>,
    ) -> Result<(), phenix_acp::acp::Error> {
        let mut command = Command::new(self.launch.command());
        command
            .args(self.launch.arguments())
            .envs(self.launch.environment())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn().map_err(acp_io_error)?;
        let child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| acp_internal_error("failed to open ACP child stdin"))?;
        let child_stdout = child
            .stdout
            .take()
            .ok_or_else(|| acp_internal_error("failed to open ACP child stdout"))?;
        let child_stderr = child
            .stderr
            .take()
            .ok_or_else(|| acp_internal_error("failed to open ACP child stderr"))?;
        let stderr = capture_stderr(child_stderr)?;

        let protocol_result = ConnectTo::<Client>::connect_to(
            ByteStreams::new(Unblock::new(child_stdin), Unblock::new(child_stdout)),
            client,
        )
        .await;

        let child_exit = finish_child(&mut child).map_err(acp_io_error)?;
        let stderr = stderr
            .recv_timeout(STDERR_SHUTDOWN_GRACE_PERIOD)
            .unwrap_or_default();

        if let Err(error) = protocol_result {
            return if stderr.is_empty() {
                Err(error)
            } else {
                Err(acp_internal_error(format!("{error}; child stderr: {stderr}")))
            };
        }

        if !child_exit.forced && !child_exit.status.success() {
            let message = if stderr.is_empty() {
                format!("ACP child exited with {}", child_exit.status)
            } else {
                format!("ACP child exited with {}: {stderr}", child_exit.status)
            };
            return Err(acp_internal_error(message));
        }

        Ok(())
    }
}

struct ChildExit {
    status: ExitStatus,
    forced: bool,
}

fn finish_child(child: &mut Child) -> std::io::Result<ChildExit> {
    let deadline = Instant::now() + CHILD_SHUTDOWN_GRACE_PERIOD;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(ChildExit {
                status,
                forced: false,
            });
        }
        if Instant::now() >= deadline {
            child.kill()?;
            return child.wait().map(|status| ChildExit {
                status,
                forced: true,
            });
        }
        thread::sleep(CHILD_WAIT_POLL_PERIOD);
    }
}

fn capture_stderr(stderr: ChildStderr) -> Result<Receiver<String>, phenix_acp::acp::Error> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("phenix-acp-child-stderr".to_owned())
        .spawn(move || {
            let captured = read_stderr_tail(stderr);
            let _ = sender.send(captured);
        })
        .map_err(acp_io_error)?;
    Ok(receiver)
}

fn read_stderr_tail(mut stderr: ChildStderr) -> String {
    let mut tail = VecDeque::with_capacity(STDERR_CAPTURE_LIMIT);
    let mut buffer = [0_u8; STDERR_READ_BUFFER_SIZE];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                for byte in &buffer[..read] {
                    if tail.len() == STDERR_CAPTURE_LIMIT {
                        tail.pop_front();
                    }
                    tail.push_back(*byte);
                }
            }
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&tail.into_iter().collect::<Vec<_>>()).into_owned()
}

fn acp_io_error(error: std::io::Error) -> phenix_acp::acp::Error {
    acp_internal_error(error.to_string())
}

fn acp_internal_error(message: impl Into<String>) -> phenix_acp::acp::Error {
    phenix_acp::acp::Error::internal_error().data(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_parser_keeps_sdk_launch_semantics() {
        let agent = BlockingAcpAgent::from_command(
            "RUST_LOG=debug sh -c 'exit 0'",
            PathBuf::from("ignored-session-cwd"),
        )
        .expect("parse command");
        assert_eq!(agent.launch.command().to_string_lossy(), "sh");
        assert_eq!(agent.launch.arguments(), &["-c", "exit 0"]);
        assert_eq!(
            agent.launch.environment().get("RUST_LOG"),
            Some(&"debug".to_owned())
        );
    }
}
