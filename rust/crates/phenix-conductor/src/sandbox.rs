use phenix_core::{ExecutionAuthority, NetworkAuthority, RepositoryAuthority};
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
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

pub(crate) struct SandboxCommand {
    process: Command,
    network: NetworkAuthority,
    state_root: PathBuf,
}

impl SandboxCommand {
    pub(crate) fn arg(&mut self, argument: impl AsRef<std::ffi::OsStr>) -> &mut Self {
        self.process.arg(argument);
        self
    }

    pub(crate) fn output(&mut self) -> Result<Output, String> {
        match self.network {
            NetworkAuthority::None => self
                .process
                .output()
                .map_err(|error| format!("failed to start workspace sandbox: {error}")),
            NetworkAuthority::Outbound => {
                run_with_outbound_network(&self.process, &self.state_root)
            }
        }
    }
}

impl<'a> ExecutionSandbox<'a> {
    pub(crate) fn new(authority: &'a ExecutionAuthority, state: &'a ExecutionSandboxState) -> Self {
        Self { authority, state }
    }

    pub(crate) fn configure_bwrap(
        &self,
        bwrap: &std::ffi::OsStr,
        workspace: &Path,
        scratch_mounts: &[(PathBuf, PathBuf)],
        mount: WorkspaceMount<'_>,
    ) -> Result<SandboxCommand, String> {
        let mut process = Command::new(bwrap);
        self.configure_environment(&mut process)?;
        process
            .arg("--die-with-parent")
            .arg("--unshare-pid")
            .arg("--unshare-ipc")
            .arg("--unshare-net")
            .arg("--dev")
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

        self.mount_runtime(&mut process)?;
        match mount {
            WorkspaceMount::ReadOnly => {
                process.arg("--ro-bind").arg(workspace).arg(workspace);
            }
            WorkspaceMount::Overlay { upper, work } => {
                process
                    .arg("--overlay-src")
                    .arg(workspace)
                    .arg("--overlay")
                    .arg(upper)
                    .arg(work)
                    .arg(workspace);
            }
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
        self.mask_ungranted_sockets(&mut process, workspace, scratch_mounts)?;
        self.mount_ipc(&mut process)?;
        process.arg("--chdir").arg(workspace);
        Ok(SandboxCommand {
            process,
            network: self.authority.network,
            state_root: self.state.root.clone(),
        })
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

    fn mount_runtime(&self, process: &mut Command) -> Result<(), String> {
        for path in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/nix/store"] {
            mount_system_path(process, Path::new(path))?;
        }
        process.arg("--dir").arg("/etc");
        for path in [
            "/etc/hosts",
            "/etc/nsswitch.conf",
            "/etc/gai.conf",
            "/etc/passwd",
            "/etc/group",
            "/etc/resolv.conf",
        ] {
            mount_regular_file(process, Path::new(path), Path::new(path))?;
        }
        for name in ["SSL_CERT_FILE", "NIX_SSL_CERT_FILE"] {
            let Some(destination) = env::var_os(name).map(PathBuf::from) else {
                continue;
            };
            if destination.is_absolute() && !path_is_under_runtime_mount(&destination) {
                mount_regular_file(process, &destination, &destination)?;
            }
        }
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

    fn mask_ungranted_sockets(
        &self,
        process: &mut Command,
        workspace: &Path,
        scratch_mounts: &[(PathBuf, PathBuf)],
    ) -> Result<(), String> {
        let granted = self
            .authority
            .ipc
            .iter()
            .map(PathBuf::from)
            .collect::<std::collections::BTreeSet<_>>();
        for root in std::iter::once(workspace).chain(
            scratch_mounts
                .iter()
                .map(|(_, absolute)| absolute.as_path()),
        ) {
            for socket in filesystem_sockets(root)? {
                if !granted.contains(&socket) {
                    process.arg("--ro-bind").arg("/dev/null").arg(socket);
                }
            }
        }
        Ok(())
    }
}

fn filesystem_sockets(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut sockets = Vec::new();
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "failed to inspect sandbox mount {} for IPC endpoints: {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_socket() {
            sockets.push(path);
        } else if metadata.is_dir() {
            let entries = fs::read_dir(&path).map_err(|error| {
                format!(
                    "failed to inspect sandbox mount {} for IPC endpoints: {error}",
                    path.display()
                )
            })?;
            for entry in entries {
                pending.push(
                    entry
                        .map_err(|error| {
                            format!(
                                "failed to inspect sandbox mount {} for IPC endpoints: {error}",
                                path.display()
                            )
                        })?
                        .path(),
                );
            }
        }
    }
    sockets.sort();
    sockets.dedup();
    Ok(sockets)
}

fn mount_system_path(process: &mut Command, path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(path).map_err(|error| {
            format!("failed to inspect runtime path {}: {error}", path.display())
        })?;
        process.arg("--symlink").arg(target).arg(path);
    } else if metadata.is_dir() || metadata.is_file() {
        process.arg("--ro-bind").arg(path).arg(path);
    } else {
        return Err(format!(
            "runtime path is not a directory, file, or symlink: {}",
            path.display()
        ));
    }
    Ok(())
}

fn mount_regular_file(
    process: &mut Command,
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    let Ok(canonical) = fs::canonicalize(source) else {
        return Ok(());
    };
    let metadata = fs::metadata(&canonical).map_err(|error| {
        format!(
            "failed to inspect runtime file {}: {error}",
            source.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("runtime file is not regular: {}", source.display()));
    }
    process.arg("--ro-bind").arg(canonical).arg(destination);
    Ok(())
}

fn path_is_under_runtime_mount(path: &Path) -> bool {
    ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/nix/store"]
        .iter()
        .any(|root| path.starts_with(root))
}

const OUTBOUND_NETWORK_SCRIPT: &str = r#"
set -u
slirp=$1
bwrap=$2
info=$3
gate=$4
ready_pipe=$5
slirp_error=$6
test_watchdog_seconds=$7
shift 7

exec 8<>"$gate"
exec 9<>"$ready_pipe"

sandbox_stdout="$info.stdout"
sandbox_stderr="$info.stderr"
"$bwrap" --info-fd 3 --block-fd 4 "$@" \
  3>"$info" 4<&8 >"$sandbox_stdout" 2>"$sandbox_stderr" &
sandbox_pid=$!

attempt=0
while [ ! -s "$info" ]; do
  if ! kill -0 "$sandbox_pid" 2>/dev/null; then
    wait "$sandbox_pid"
    exit $?
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 1500 ]; then
    printf '%s\n' 'workspace sandbox did not publish its network namespace' >&2
    kill "$sandbox_pid" 2>/dev/null || true
    wait "$sandbox_pid" 2>/dev/null || true
    exit 125
  fi
  sleep 0.01
done

child_pid=
while IFS= read -r line; do
  case "$line" in
    *'"child-pid"'*)
      child_pid=${line#*:}
      child_pid=${child_pid//[!0-9]/}
      ;;
  esac
done <"$info"
if [ -z "$child_pid" ]; then
  printf '%s\n' 'workspace sandbox returned invalid namespace information' >&2
  kill "$sandbox_pid" 2>/dev/null || true
  wait "$sandbox_pid" 2>/dev/null || true
  exit 125
fi

"$slirp" \
  --configure \
  --mtu=65520 \
  --disable-host-loopback \
  --enable-sandbox \
  --enable-seccomp \
  --ready-fd=3 \
  "$child_pid" tap0 \
  3>&9 >"$slirp_error.stdout" 2>"$slirp_error" &
network_pid=$!

network_ready=
IFS= read -r -n 1 -t 15 network_ready <&9 || true
if [ "$network_ready" != 1 ]; then
  printf '%s\n' 'outbound network helper did not become ready' >&2
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done <"$slirp_error"
  kill "$network_pid" "$sandbox_pid" 2>/dev/null || true
  wait "$network_pid" 2>/dev/null || true
  wait "$sandbox_pid" 2>/dev/null || true
  exit 125
fi

printf 1 >&8
sandbox_timeout="$slirp_error.sandbox-timeout"
sandbox_watchdog_pid=
if [ "$test_watchdog_seconds" -gt 0 ]; then
  (
    sleep "$test_watchdog_seconds"
    if kill -0 "$sandbox_pid" 2>/dev/null; then
      : >"$sandbox_timeout"
      kill -KILL "$sandbox_pid" 2>/dev/null || true
    fi
  ) &
  sandbox_watchdog_pid=$!
fi
wait "$sandbox_pid"
sandbox_status=$?
if [ -n "$sandbox_watchdog_pid" ]; then
  kill "$sandbox_watchdog_pid" 2>/dev/null || true
  wait "$sandbox_watchdog_pid" 2>/dev/null || true
fi
if [ -e "$sandbox_timeout" ]; then
  kill "$network_pid" 2>/dev/null || true
  wait "$network_pid" 2>/dev/null || true
  printf '%s\\n' 'workspace sandbox did not exit after network release' >&2
  while IFS= read -r line; do printf '%s\\n' "$line" >&2; done <"$slirp_error"
  exit 125
fi
if ! kill -0 "$network_pid" 2>/dev/null; then
  wait "$network_pid" 2>/dev/null || true
  printf '%s\n' 'outbound network helper stopped before sandbox exit' >&2
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done <"$slirp_error"
  exit 125
fi

network_timeout="$slirp_error.timeout"
(
  sleep 5
  if kill -0 "$network_pid" 2>/dev/null; then
    : >"$network_timeout"
    kill -KILL "$network_pid" 2>/dev/null || true
  fi
) &
watchdog_pid=$!
kill "$network_pid" 2>/dev/null || true
wait "$network_pid" 2>/dev/null || true
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
if [ -e "$network_timeout" ]; then
  printf '%s\n' 'outbound network helper did not stop after sandbox exit' >&2
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done <"$slirp_error"
  exit 125
fi
while IFS= read -r line; do printf '%s\n' "$line"; done <"$sandbox_stdout"
while IFS= read -r line; do printf '%s\n' "$line" >&2; done <"$sandbox_stderr"
exit "$sandbox_status"
"#;

fn run_with_outbound_network(process: &Command, state_root: &Path) -> Result<Output, String> {
    let control = allocate_network_control(state_root)?;
    let info = control.join("bwrap-info.json");
    let gate = control.join("start.pipe");
    let ready = control.join("ready.pipe");
    let slirp_error = control.join("slirp.stderr");
    let mkfifo = sibling_coreutils_program("mkfifo");
    let fifo_status = Command::new(&mkfifo)
        .arg(&gate)
        .arg(&ready)
        .status()
        .map_err(|error| {
            format!(
                "failed to create outbound network channels with {}: {error}",
                Path::new(&mkfifo).display()
            )
        })?;
    if !fifo_status.success() {
        let _ = fs::remove_dir_all(&control);
        return Err(format!(
            "outbound network channel creation failed with {fifo_status}"
        ));
    }

    let shell = env::var_os("PHENIX_BASH").unwrap_or_else(|| OsString::from("bash"));
    let slirp = env::var_os("PHENIX_SLIRP4NETNS").unwrap_or_else(|| OsString::from("slirp4netns"));
    let mut wrapper = Command::new(&shell);
    wrapper
        .env_clear()
        .envs(
            process
                .get_envs()
                .filter_map(|(name, value)| value.map(|value| (name, value))),
        )
        .arg("-c")
        .arg(OUTBOUND_NETWORK_SCRIPT)
        .arg("phenix-outbound-network")
        .arg(slirp)
        .arg(process.get_program())
        .arg(&info)
        .arg(&gate)
        .arg(&ready)
        .arg(&slirp_error)
        .arg(if cfg!(test) { "20" } else { "0" })
        .args(process.get_args());
    if let Some(directory) = process.get_current_dir() {
        wrapper.current_dir(directory);
    }
    let output = wrapper.output().map_err(|error| {
        format!(
            "failed to start outbound sandbox network wrapper {}: {error}",
            Path::new(&shell).display()
        )
    });
    let _ = fs::remove_dir_all(&control);
    output
}

fn allocate_network_control(state_root: &Path) -> Result<PathBuf, String> {
    for _ in 0..32 {
        let sequence = NEXT_SANDBOX_STATE.fetch_add(1, Ordering::Relaxed);
        let control = state_root.join(format!("network-{sequence}"));
        match fs::create_dir(&control) {
            Ok(()) => return Ok(control),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "failed to allocate outbound network control directory: {error}"
                ));
            }
        }
    }
    Err("failed to allocate outbound network control directory".to_owned())
}

fn sibling_coreutils_program(name: &str) -> OsString {
    env::var_os("PHENIX_MKDIR")
        .and_then(|mkdir| Path::new(&mkdir).parent().map(|parent| parent.join(name)))
        .map_or_else(|| OsString::from(name), PathBuf::into_os_string)
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
    #[cfg(unix)]
    use std::net::TcpListener;
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;

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

    fn empty_workspace(label: &str) -> PathBuf {
        let workspace = env::temp_dir().join(format!(
            "phenix-sandbox-{label}-{}-{}",
            std::process::id(),
            NEXT_SANDBOX_STATE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&workspace).unwrap();
        workspace
    }

    #[test]
    fn sandbox_command_clears_ambient_credentials_and_isolates_network_and_home() {
        let state = ExecutionSandboxState::create().unwrap();
        let authority = authority();
        let sandbox = ExecutionSandbox::new(&authority, &state);
        let workspace = empty_workspace("command");
        let command = sandbox
            .configure_bwrap(
                std::ffi::OsStr::new("bwrap"),
                &workspace,
                &[],
                WorkspaceMount::ReadOnly,
            )
            .unwrap();
        let debug = format!("{:?}", command.process);

        assert!(debug.contains("--unshare-net"));
        assert!(debug.contains("/run/phenix-home"));
        assert!(!debug.contains("\"--ro-bind\" \"/\" \"/\""));
        assert!(!debug.contains("OPENAI_API_KEY"));
        fs::remove_dir_all(workspace).unwrap();
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
        let command = sandbox
            .configure_bwrap(
                std::ffi::OsStr::new("bwrap"),
                &root,
                &[],
                WorkspaceMount::ReadOnly,
            )
            .unwrap();
        let debug = format!("{:?}", command.process);

        assert!(debug.contains(root.join(".git").to_string_lossy().as_ref()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn outbound_network_keeps_network_namespace_isolation() {
        let state = ExecutionSandboxState::create().unwrap();
        let mut authority = authority();
        authority.network = NetworkAuthority::Outbound;
        let workspace = empty_workspace("outbound-command");
        let command = ExecutionSandbox::new(&authority, &state)
            .configure_bwrap(
                std::ffi::OsStr::new("bwrap"),
                &workspace,
                &[],
                WorkspaceMount::ReadOnly,
            )
            .unwrap();
        assert!(command
            .process
            .get_args()
            .any(|argument| argument == "--unshare-net"));
        fs::remove_dir_all(workspace).unwrap();
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
        let workspace = empty_workspace("ipc-command");
        let command = ExecutionSandbox::new(&authority, &state)
            .configure_bwrap(
                std::ffi::OsStr::new("bwrap"),
                &workspace,
                &[],
                WorkspaceMount::ReadOnly,
            )
            .unwrap();
        let environment = command
            .process
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let arguments = command
            .process
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
        fs::remove_dir_all(workspace).unwrap();
        fs::remove_dir_all(socket_root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bubblewrap_exposes_only_granted_filesystem_ipc_endpoints() {
        let root = env::temp_dir().join(format!(
            "phenix-sandbox-ipc-e2e-{}-{}",
            std::process::id(),
            NEXT_SANDBOX_STATE.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = root.join("workspace");
        let sockets = root.join("sockets");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&sockets).unwrap();
        let granted = sockets.join("granted.sock");
        let ungranted = workspace.join("ungranted.sock");
        let granted_listener = UnixListener::bind(&granted).unwrap();
        let ungranted_listener = UnixListener::bind(&ungranted).unwrap();
        let state = ExecutionSandboxState::create().unwrap();
        let mut authority = authority();
        authority.ipc.insert(granted.to_string_lossy().into_owned());
        let bwrap = env::var_os("PHENIX_BWRAP").unwrap_or_else(|| OsString::from("bwrap"));
        let bash = env::var_os("PHENIX_BASH").unwrap_or_else(|| OsString::from("bash"));
        let mut command = ExecutionSandbox::new(&authority, &state)
            .configure_bwrap(&bwrap, &workspace, &[], WorkspaceMount::ReadOnly)
            .unwrap();
        let output = command
            .arg("--")
            .arg(bash)
            .arg("-c")
            .arg("test -S \"$1\" && test ! -S \"$2\"")
            .arg("phenix-ipc-test")
            .arg(&granted)
            .arg(&ungranted)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "sandbox failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        drop(granted_listener);
        drop(ungranted_listener);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn outbound_network_is_private_and_cannot_reach_host_loopback() {
        let root = env::temp_dir().join(format!(
            "phenix-sandbox-network-e2e-{}-{}",
            std::process::id(),
            NEXT_SANDBOX_STATE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let host_listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let host_port = host_listener.local_addr().unwrap().port();
        let host_namespace = fs::read_link("/proc/self/ns/net").unwrap();
        let state = ExecutionSandboxState::create().unwrap();
        let mut authority = authority();
        authority.network = NetworkAuthority::Outbound;
        let bwrap = env::var_os("PHENIX_BWRAP").unwrap_or_else(|| OsString::from("bwrap"));
        let bash = env::var_os("PHENIX_BASH").unwrap_or_else(|| OsString::from("bash"));
        let timeout = sibling_coreutils_program("timeout");
        let mut command = ExecutionSandbox::new(&authority, &state)
            .configure_bwrap(&bwrap, &root, &[], WorkspaceMount::ReadOnly)
            .unwrap();
        let output = command
            .arg("--")
            .arg(&bash)
            .arg("-c")
            .arg(
                "test \"$(readlink /proc/self/ns/net)\" != \"$1\" \
                 && grep -q tap0 /proc/net/route \
                 && ! \"$2\" 3 \"$3\" -c 'exec 3<>/dev/tcp/10.0.2.2/$1' test \"$4\"",
            )
            .arg("phenix-network-test")
            .arg(host_namespace)
            .arg(timeout)
            .arg(bash)
            .arg(host_port.to_string())
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "sandbox failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        drop(host_listener);
        fs::remove_dir_all(root).unwrap();
    }
}
