use phenix_conductor::ConductorServer;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{
    mpsc::{self, Receiver},
    Arc, Mutex,
};
use std::thread;

/// Runs one long-lived conductor protocol stream behind reconnectable Unix
/// socket frontend connections. The conductor worker/event subscription lives
/// for the service process rather than for any individual frontend socket.
pub fn serve_unix_socket(
    mut server: ConductorServer,
    socket_path: impl Into<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let socket_path = socket_path.into();
    prepare_socket_parent(&socket_path)?;
    let listener = UnixListener::bind(&socket_path)?;
    let _socket_guard = SocketGuard(socket_path);

    let (input_sender, input_receiver) = mpsc::channel::<Vec<u8>>();
    let active_output = Arc::new(Mutex::new(None::<UnixStream>));
    let conductor_output = SwitchingWriter {
        active: active_output.clone(),
    };

    thread::scope(|scope| -> Result<(), Box<dyn std::error::Error>> {
        let conductor = scope.spawn(move || {
            server.serve_ndjson(BufReader::new(ChannelReader::new(input_receiver)), conductor_output)
        });

        for incoming in listener.incoming() {
            let stream = incoming?;
            let writer = stream.try_clone()?;
            *active_output
                .lock()
                .map_err(|_| io::Error::other("local service output lock poisoned"))? = Some(writer);

            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            loop {
                line.clear();
                let read = reader.read_line(&mut line)?;
                if read == 0 {
                    break;
                }
                if input_sender.send(line.as_bytes().to_vec()).is_err() {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "conductor protocol worker stopped",
                    )
                    .into());
                }
            }

            *active_output
                .lock()
                .map_err(|_| io::Error::other("local service output lock poisoned"))? = None;
        }

        drop(input_sender);
        conductor
            .join()
            .map_err(|_| io::Error::other("conductor protocol worker panicked"))??;
        Ok(())
    })
}

fn prepare_socket_parent(socket_path: &Path) -> io::Result<()> {
    if let Some(parent) = socket_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

struct SocketGuard(PathBuf);

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct ChannelReader {
    receiver: Receiver<Vec<u8>>,
    current: io::Cursor<Vec<u8>>,
}

impl ChannelReader {
    fn new(receiver: Receiver<Vec<u8>>) -> Self {
        Self {
            receiver,
            current: io::Cursor::new(Vec::new()),
        }
    }
}

impl Read for ChannelReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            let read = self.current.read(buffer)?;
            if read > 0 {
                return Ok(read);
            }
            let next = match self.receiver.recv() {
                Ok(next) => next,
                Err(_) => return Ok(0),
            };
            self.current = io::Cursor::new(next);
        }
    }
}

/// Output is connection-ephemeral by design. If a frontend disconnects while
/// execution continues, writes are discarded; reconnecting frontends recover
/// the authoritative state and missed canonical events with Initialize(cursor).
struct SwitchingWriter {
    active: Arc<Mutex<Option<UnixStream>>>,
}

impl Write for SwitchingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| io::Error::other("local service output lock poisoned"))?;
        if let Some(stream) = active.as_mut() {
            if stream.write_all(buffer).is_err() {
                *active = None;
            }
        }
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| io::Error::other("local service output lock poisoned"))?;
        if let Some(stream) = active.as_mut() {
            if stream.flush().is_err() {
                *active = None;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_reader_spans_frontend_chunks_without_eof() {
        let (sender, receiver) = mpsc::channel();
        sender.send(b"first\n".to_vec()).unwrap();
        sender.send(b"second\n".to_vec()).unwrap();
        drop(sender);

        let mut reader = BufReader::new(ChannelReader::new(receiver));
        let mut first = String::new();
        let mut second = String::new();
        assert_eq!(reader.read_line(&mut first).unwrap(), 6);
        assert_eq!(reader.read_line(&mut second).unwrap(), 7);
        assert_eq!(first, "first\n");
        assert_eq!(second, "second\n");
        let mut end = String::new();
        assert_eq!(reader.read_line(&mut end).unwrap(), 0);
    }
}
