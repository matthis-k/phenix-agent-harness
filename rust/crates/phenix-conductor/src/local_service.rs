use phenix_conductor::{ConductorServer, ConductorService};
use std::fs;
use std::io::{self, BufReader};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::thread;

/// Runs one shared conductor service with one independent protocol stream per
/// frontend connection.
pub fn serve_unix_socket(
    server: ConductorServer,
    socket_path: impl Into<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let socket_path = socket_path.into();
    prepare_socket_parent(&socket_path)?;
    let listener = UnixListener::bind(&socket_path)?;
    let _socket_guard = SocketGuard(socket_path);

    let service = ConductorService::new(server)?;
    for incoming in listener.incoming() {
        let stream = incoming?;
        let writer = stream.try_clone()?;
        let service = service.clone();
        thread::spawn(move || {
            let _ = service.serve_connection(BufReader::new(stream), writer);
        });
    }
    Ok(())
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
