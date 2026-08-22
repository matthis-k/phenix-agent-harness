use phenix_core::{ExecutionAuthority, NetworkAuthority, RepositoryAuthority};
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

static NEXT_SANDBOX_STATE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(crate) struct ExecutionSandboxState {
    root: PathBuf,
    home: PathBuf,
}

impl ExecutionSandboxState {
    pub(crate) fn create() -> io::Result<Arc<Self>> {
        let base = env::temp_dir();
        for _ in 0..32 {
            let sequence = NEXT_SANDBOX_STATE.fetch_add(1, Ordering::Relaxed);
            let root = base.join(format!(
                "phenix-execution-state-{}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&root) {
                Ok(()) => {
                    let home = root.join("home");
                    for path in [
                        home.clone(),
                        home.join(".config"),
                        home.join(".cache"),
                        home.join(".local/state"),
                        home.join(".local/share"),
                    ] {
                        fs::create_dir_all(path)?;
                    }
                    return Ok(Arc::new(Self { root, home }));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "failed to allocate private execution state",
        ))
    }

    fn home(&self) -> &Path {
        &self.home
    }
}

impl Drop for ExecutionSandboxState {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub(crate) enum WorkspaceMount<'a> {
    ReadOnly,
    Overlay { upper: &'a Path, work: &'a Path },
}

pub(crate) struct ExecutionSandbox<'a> {
    authority: &'a ExecutionAuthority,
    state: &'a ExecutionSandboxState,
}

impl<'a> ExecutionSandbox<'a> {
    pub(crate) fn new(authority: &'a ExecutionAuthority, state: &'a ExecutionSandboxState) -> Self {
        Self { authority, state }
    }

    pub(crate) fn configure_bwrap(
        &self,
        process: &mut Command,
        workspace: &Path,
        scratch_mounts: &[(PathBuf, PathBuf)],
        mount: WorkspaceMount<'_>,
    ) -> Result<(), String> {
        self.configure_environment(process)?;
        process
            .arg("--die-with-parent")
            .arg("--unshare-pid")
            .arg("--unshare-ipc")
            .arg("--ro-bind")
            .arg("/")
            .arg("/")
            .arg("--dev-bind")
            .arg("/dev")
            .arg("/dev")
            .arg("--proc")
            .arg("/proc")
            .arg("--tmpfs")
            .arg("/tmp")
            .arg("--tmpfs")
            .arg("/run")
            .arg("--dir")
            .arg("/run/phenix-home")
            .arg("--bind")
            .arg(self.state.home())
            .arg("/run/phenix-home");

        if let Some(host_home) = env::var_os("HOME").map(PathBuf::from) {
            if host_home.is_absolute() && host_home != Path::new("/") {
                process.arg("--tmpfs").arg(host_home);
            }
        }
        if self.authority.network == NetworkAuthority::None {
            process.arg("--unshare-net");
        }
        if let WorkspaceMount::Overlay { upper, work } = mount {
            process
                .arg("--overlay-src")
                .arg(workspace)
                .arg("--overlay")
                .arg(upper)
                .arg(work)
                .arg(workspace);
        }
        for (_, absolute) in scratch_mounts {
            process.arg("--bind").arg(absolute).arg(absolute);
        }
        if self.authority.repository == RepositoryAuthority::Write {
            let git = workspace.join(".git");
            if git.exists() {
                process.arg("--bind").arg(&git).arg(&git);
            }
        }
        self.mount_ipc(process)?;
        process.arg("--chdir").arg(workspace);
        Ok(())
    }

    fn configure_environment(&self, process: &mut Command) -> Result<(), String> {
        let mut environment = BTreeMap::<OsString, OsString>::new();
        environment.insert(
            OsString::from("PATH"),
            env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin")),
        );
        for name in ["LANG", "LC_ALL", "TERM"] {
            if let Some(value) = env::var_os(name) {
                environment.insert(OsString::from(name), value);
            }
        }
        environment.insert(OsString::from("HOME"), OsString::from("/run/phenix-home"));
        environment.insert(
            OsString::from("XDG_CONFIG_HOME"),
            OsString::from("/run/phenix-home/.config"),
        );
        environment.insert(
            OsString::from("XDG_CACHE_HOME"),
            OsString::from("/run/phenix-home/.cache"),
        );
        environment.insert(
            OsString::from("XDG_STATE_HOME"),
            OsString::from("/run/phenix-home/.local/state"),
        );
        environment.insert(
            OsString::from("XDG_DATA_HOME"),
            OsString::from("/run/phenix-home/.local/share"),
        );
        environment.insert(OsString::from("TMPDIR"), OsString::from("/tmp"));

        for secret in &self.authority.secrets {
            validate_environment_name(secret)?;
            let value = env::var_os(secret)
                .ok_or_else(|| format!("granted secret {secret} is unavailable"))?;
            environment.insert(OsString::from(secret), value);
        }
        if let Some(socket) = env::var_os("SSH_AUTH_SOCK") {
            let socket_path = PathBuf::from(&socket);
            if self
                .authority
                .ipc
                .iter()
                .any(|endpoint| Path::new(endpoint) == socket_path)
            {
                environment.insert(OsString::from("SSH_AUTH_SOCK"), socket);
            }
        }

        process.env_clear();
        process.envs(environment);
        Ok(())
    }

    fn mount_ipc(&self, process: &mut Command) -> Result<(), String> {
        for endpoint in &self.authority.ipc {
            let endpoint = Path::new(endpoint);
            if !endpoint.is_absolute() {
                return Err(format!(
                    "IPC endpoint must be absolute: {}",
                    endpoint.display()
                ));
            }
            let metadata = fs::symlink_metadata(endpoint).map_err(|error| {
                format!(
                    "granted IPC endpoint {} is unavailable: {error}",
                    endpoint.display()
                )
            })?;
            if !(metadata.file_type().is_socket() || metadata.is_file()) {
                return Err(format!(
                    "granted IPC endpoint is not a socket or file: {}",
                    endpoint.display()
                ));
            }
            if let Some(parent) = endpoint.parent().filter(|parent| *parent != Path::new("/")) {
                process.arg("--dir").arg(parent);
            }
            process.arg("--ro-bind").arg(endpoint).arg(endpoint);
        }
        Ok(())
    }
}

fn validate_environment_name(name: &str) -> Result<(), String> {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return Err("secret grant name must not be empty".to_owned());
    };
    if !(first == '_' || first.is_ascii_alphabetic())
        || !characters.all(|character| character == '_' || character.is_ascii_alphanumeric())
    {
        return Err(format!(
            "secret grant {name:?} must be a valid environment variable name"
        ));
    }
    Ok(())
}

trait FileTypeSocket {
    fn is_socket(&self) -> bool;
}

#[cfg(unix)]
impl FileTypeSocket for fs::FileType {
    fn is_socket(&self) -> bool {
        std::os::unix::fs::FileTypeExt::is_socket(self)
    }
}

#[cfg(not(unix))]
impl FileTypeSocket for fs::FileType {
    fn is_socket(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{FilesystemAuthority, RepositoryAuthority};
    use std::collections::BTreeSet;

    fn authority() -> ExecutionAuthority {
        ExecutionAuthority {
            filesystem: FilesystemAuthority::ReadOnly,
            network: NetworkAuthority::None,
            repository: RepositoryAuthority::Read,
            ipc: BTreeSet::new(),
            secrets: BTreeSet::new(),
            callables: BTreeSet::new(),
        }
    }

    #[test]
    fn sandbox_command_clears_ambient_credentials_and_isolates_network_and_home() {
        let state = ExecutionSandboxState::create().unwrap();
        let authority = authority();
        let sandbox = ExecutionSandbox::new(&authority, &state);
        let mut command = Command::new("bwrap");
        sandbox
            .configure_bwrap(
                &mut command,
                Path::new("/repo"),
                &[],
                WorkspaceMount::ReadOnly,
            )
            .unwrap();
        let debug = format!("{command:?}");

        assert!(debug.contains("--unshare-net"));
        assert!(debug.contains("/run/phenix-home"));
        assert!(!debug.contains("OPENAI_API_KEY"));
    }

    #[test]
    fn repository_write_is_an_explicit_git_metadata_bind() {
        let root = env::temp_dir().join(format!(
            "phenix-sandbox-repository-{}",
            NEXT_SANDBOX_STATE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join(".git")).unwrap();
        let state = ExecutionSandboxState::create().unwrap();
        let mut authority = authority();
        authority.repository = RepositoryAuthority::Write;
        let sandbox = ExecutionSandbox::new(&authority, &state);
        let mut command = Command::new("bwrap");
        sandbox
            .configure_bwrap(&mut command, &root, &[], WorkspaceMount::ReadOnly)
            .unwrap();
        let debug = format!("{command:?}");

        assert!(debug.contains(root.join(".git").to_string_lossy().as_ref()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn outbound_network_omits_network_namespace_isolation() {
        let state = ExecutionSandboxState::create().unwrap();
        let mut authority = authority();
        authority.network = NetworkAuthority::Outbound;
        let mut command = Command::new("bwrap");
        ExecutionSandbox::new(&authority, &state)
            .configure_bwrap(
                &mut command,
                Path::new("/repo"),
                &[],
                WorkspaceMount::ReadOnly,
            )
            .unwrap();
        assert!(!command
            .get_args()
            .any(|argument| argument == "--unshare-net"));
    }

    #[test]
    fn only_granted_secret_and_ipc_are_injected() {
        let socket_root = env::temp_dir().join(format!(
            "phenix-sandbox-ipc-{}-{}",
            std::process::id(),
            NEXT_SANDBOX_STATE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&socket_root).unwrap();
        let granted_socket = socket_root.join("granted.sock");
        let ungranted_socket = socket_root.join("ungranted.sock");
        fs::write(&granted_socket, "granted endpoint").unwrap();
        fs::write(&ungranted_socket, "ungranted endpoint").unwrap();
        let secret_name = "PHENIX_SANDBOX_TEST_SECRET";
        env::set_var(secret_name, "explicit-value");
        let state = ExecutionSandboxState::create().unwrap();
        let mut authority = authority();
        authority.secrets.insert(secret_name.to_owned());
        authority
            .ipc
            .insert(granted_socket.to_string_lossy().into_owned());
        let mut command = Command::new("bwrap");
        ExecutionSandbox::new(&authority, &state)
            .configure_bwrap(
                &mut command,
                Path::new("/repo"),
                &[],
                WorkspaceMount::ReadOnly,
            )
            .unwrap();
        let environment = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let arguments = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            environment.get(secret_name),
            Some(&Some("explicit-value".to_owned()))
        );
        assert!(!environment.contains_key("OPENAI_API_KEY"));
        assert!(arguments.contains(&granted_socket.to_string_lossy().into_owned()));
        assert!(!arguments.contains(&ungranted_socket.to_string_lossy().into_owned()));
        env::remove_var(secret_name);
        fs::remove_dir_all(socket_root).unwrap();
    }
}
