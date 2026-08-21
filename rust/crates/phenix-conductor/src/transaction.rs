use super::super::workspace_consistency::WorkspaceConsistencyError;
use super::WorkspaceConsistency;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt::{self, Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SANDBOX_RELEASE: &str = "/tmp/phenix-transaction-release";
const SANDBOX_SNAPSHOT: &str = "/tmp/phenix-transaction-snapshot";
const SANDBOX_EXCLUDES: &str = "/tmp/phenix-transaction-excludes";
const COMMAND_SCRIPT: &str = r#"
release_file=$1
bash_path=$2
user_command=$3

while [ ! -s "$release_file" ]; do
  sleep 0.001
done
exec "$bash_path" -c "$user_command" </dev/null
"#;

static NEXT_TRANSACTION_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug)]
pub(super) struct TransactionOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug)]
pub(super) struct WorkspaceTransaction {
    consistency: WorkspaceConsistency,
    baseline: std::collections::BTreeMap<PathBuf, phenix_core::FileVersion>,
    scratch_mounts: Vec<(PathBuf, PathBuf)>,
    paths: TransactionPaths,
    rsync: OsString,
}

impl WorkspaceTransaction {
    pub fn begin(consistency: WorkspaceConsistency) -> Result<Self, TransactionError> {
        let scratch_mounts = consistency.prepare_scratch_mounts()?;
        let baseline = consistency.checkpoint_baseline()?;
        let paths = TransactionPaths::create(consistency.root())?;
        paths.write_excludes(&scratch_mounts)?;
        let rsync = std::env::var_os("PHENIX_RSYNC").unwrap_or_else(|| OsString::from("rsync"));
        Ok(Self {
            consistency,
            baseline,
            scratch_mounts,
            paths,
            rsync,
        })
    }

    pub fn execute(
        &self,
        bash: &OsStr,
        command: &str,
    ) -> Result<TransactionOutput, TransactionError> {
        let bwrap = std::env::var_os("PHENIX_BWRAP").unwrap_or_else(|| OsString::from("bwrap"));
        let info = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&self.paths.info)
            .map_err(|source| TransactionError::Io {
                path: self.paths.info.clone(),
                source,
            })?;

        let mut process = self.sandbox_command(&bwrap, &self.paths.command_work);
        process
            .arg("--ro-bind")
            .arg(&self.paths.release)
            .arg(SANDBOX_RELEASE)
            .arg("--info-fd")
            .arg("0")
            .arg("--")
            .arg(bash)
            .arg("-c")
            .arg(COMMAND_SCRIPT)
            .arg("phenix-transaction")
            .arg(SANDBOX_RELEASE)
            .arg(bash)
            .arg(command)
            .stdin(Stdio::from(info))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = process.spawn().map_err(|source| TransactionError::Spawn {
            program: PathBuf::from(&bwrap),
            source,
        })?;
        let userns = self.capture_user_namespace(&bwrap, &mut child)?;
        fs::write(&self.paths.release, b"1").map_err(|source| TransactionError::Io {
            path: self.paths.release.clone(),
            source,
        })?;

        let output = child
            .wait_with_output()
            .map_err(|source| TransactionError::Wait {
                program: PathBuf::from(&bwrap),
                source,
            })?;
        let exit_code = output.status.code().unwrap_or(-1);

        self.snapshot(&bwrap, userns)?;

        Ok(TransactionOutput {
            exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    pub fn commit(&self) -> Result<(), TransactionError> {
        let snapshot_manifest = self.consistency.snapshot_manifest(&self.paths.snapshot)?;
        self.consistency
            .validate_checkpoint_baseline(&self.baseline)?;

        let output = Command::new(&self.rsync)
            .arg("-rlpt")
            .arg("--delete")
            .arg("--delete-delay")
            .arg("--delay-updates")
            .arg("--quiet")
            .arg("--exclude-from")
            .arg(&self.paths.excludes)
            .arg(self.paths.snapshot.join("."))
            .arg(self.consistency.root())
            .output()
            .map_err(|source| TransactionError::Spawn {
                program: PathBuf::from(&self.rsync),
                source,
            })?;
        if !output.status.success() {
            return Err(TransactionError::ApplyFailed {
                exit_code: output.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }

        self.consistency
            .validate_checkpoint_baseline(&snapshot_manifest)?;
        Ok(())
    }

    fn sandbox_command(&self, bwrap: &OsStr, work: &Path) -> Command {
        let mut process = Command::new(bwrap);
        process
            .arg("--die-with-parent")
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
            .arg(&self.paths.root)
            .arg("--overlay-src")
            .arg(self.consistency.root())
            .arg("--overlay")
            .arg(&self.paths.upper)
            .arg(work)
            .arg(self.consistency.root());

        for (_, absolute) in &self.scratch_mounts {
            process.arg("--bind").arg(absolute).arg(absolute);
        }

        process
            .arg("--chdir")
            .arg(self.consistency.root())
            .arg("--setenv")
            .arg("TMPDIR")
            .arg("/tmp");
        process
    }

    fn capture_user_namespace(
        &self,
        bwrap: &OsStr,
        child: &mut Child,
    ) -> Result<File, TransactionError> {
        loop {
            let info =
                fs::read_to_string(&self.paths.info).map_err(|source| TransactionError::Io {
                    path: self.paths.info.clone(),
                    source,
                })?;
            if !info.is_empty() {
                if let Some(pid) = sandbox_child_pid(&info) {
                    let path = PathBuf::from(format!("/proc/{pid}/ns/user"));
                    return File::open(&path)
                        .map_err(|source| TransactionError::Io { path, source });
                }
                if info.trim_end().ends_with('}') {
                    return Err(TransactionError::InvalidSandboxInfo {
                        path: self.paths.info.clone(),
                        value: info,
                    });
                }
            }

            if let Some(status) = child.try_wait().map_err(|source| TransactionError::Wait {
                program: PathBuf::from(bwrap),
                source,
            })? {
                let mut stderr = Vec::new();
                if let Some(stream) = child.stderr.as_mut() {
                    let _ = stream.read_to_end(&mut stderr);
                }
                return Err(TransactionError::SandboxFailed {
                    exit_code: status.code().unwrap_or(-1),
                    stderr: String::from_utf8_lossy(&stderr).into_owned(),
                });
            }
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn snapshot(&self, bwrap: &OsStr, userns: File) -> Result<(), TransactionError> {
        let output = self
            .sandbox_command(bwrap, &self.paths.snapshot_work)
            .arg("--userns")
            .arg("0")
            .arg("--bind")
            .arg(&self.paths.snapshot)
            .arg(SANDBOX_SNAPSHOT)
            .arg("--ro-bind")
            .arg(&self.paths.excludes)
            .arg(SANDBOX_EXCLUDES)
            .arg("--")
            .arg(&self.rsync)
            .arg("-rlpt")
            .arg("--delete")
            .arg("--delete-delay")
            .arg("--delay-updates")
            .arg("--quiet")
            .arg("--exclude-from")
            .arg(SANDBOX_EXCLUDES)
            .arg(self.consistency.root().join("."))
            .arg(Path::new(SANDBOX_SNAPSHOT).join("."))
            .stdin(Stdio::from(userns))
            .output()
            .map_err(|source| TransactionError::Spawn {
                program: PathBuf::from(bwrap),
                source,
            })?;
        if !output.status.success() {
            return Err(TransactionError::SandboxFailed {
                exit_code: output.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        Ok(())
    }
}

fn sandbox_child_pid(info: &str) -> Option<u32> {
    let value = serde_json::from_str::<serde_json::Value>(info).ok()?;
    let pid = value.get("child-pid")?.as_u64()?;
    u32::try_from(pid).ok()
}

#[derive(Debug)]
struct TransactionPaths {
    root: PathBuf,
    upper: PathBuf,
    command_work: PathBuf,
    snapshot_work: PathBuf,
    snapshot: PathBuf,
    excludes: PathBuf,
    info: PathBuf,
    release: PathBuf,
}

impl TransactionPaths {
    fn create(workspace: &Path) -> Result<Self, TransactionError> {
        let parent = std::env::temp_dir();
        let canonical_parent =
            fs::canonicalize(&parent).map_err(|source| TransactionError::Io {
                path: parent.clone(),
                source,
            })?;
        if canonical_parent == workspace || canonical_parent.starts_with(workspace) {
            return Err(TransactionError::TempInsideWorkspace(canonical_parent));
        }

        for _ in 0..32 {
            let sequence = NEXT_TRANSACTION_ID.fetch_add(1, Ordering::Relaxed);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let root = canonical_parent.join(format!(
                "phenix-workspace-transaction-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&root) {
                Ok(()) => {
                    let upper = root.join("upper");
                    let command_work = root.join("command-work");
                    let snapshot_work = root.join("snapshot-work");
                    let snapshot = root.join("snapshot");
                    for path in [&upper, &command_work, &snapshot_work, &snapshot] {
                        fs::create_dir(path).map_err(|source| TransactionError::Io {
                            path: path.clone(),
                            source,
                        })?;
                    }
                    let info = root.join("info");
                    let release = root.join("release");
                    for path in [&info, &release] {
                        fs::write(path, b"").map_err(|source| TransactionError::Io {
                            path: path.clone(),
                            source,
                        })?;
                    }
                    return Ok(Self {
                        excludes: root.join("excludes"),
                        root,
                        upper,
                        command_work,
                        snapshot_work,
                        snapshot,
                        info,
                        release,
                    });
                }
                Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(source) => return Err(TransactionError::Io { path: root, source }),
            }
        }
        Err(TransactionError::CreateTempExhausted(canonical_parent))
    }

    fn write_excludes(
        &self,
        scratch_mounts: &[(PathBuf, PathBuf)],
    ) -> Result<(), TransactionError> {
        let mut rules = String::from(".git\n");
        for (relative, _) in scratch_mounts {
            let pattern = relative.to_string_lossy();
            rules.push('/');
            rules.push_str(&pattern);
            rules.push('\n');
            rules.push('/');
            rules.push_str(&pattern);
            rules.push_str("/***\n");
        }
        fs::write(&self.excludes, rules).map_err(|source| TransactionError::Io {
            path: self.excludes.clone(),
            source,
        })
    }
}

impl Drop for TransactionPaths {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug)]
pub(super) enum TransactionError {
    Workspace(WorkspaceConsistencyError),
    TempInsideWorkspace(PathBuf),
    CreateTempExhausted(PathBuf),
    InvalidSandboxInfo {
        path: PathBuf,
        value: String,
    },
    Spawn {
        program: PathBuf,
        source: std::io::Error,
    },
    Wait {
        program: PathBuf,
        source: std::io::Error,
    },
    SandboxFailed {
        exit_code: i32,
        stderr: String,
    },
    ApplyFailed {
        exit_code: i32,
        stderr: String,
    },
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl Display for TransactionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Workspace(error) => Display::fmt(error, f),
            Self::TempInsideWorkspace(path) => write!(
                f,
                "workspace transaction temporary directory must be outside the workspace: {}",
                path.display()
            ),
            Self::CreateTempExhausted(path) => write!(
                f,
                "failed to allocate a workspace transaction directory below {}",
                path.display()
            ),
            Self::InvalidSandboxInfo { path, value } => write!(
                f,
                "invalid Bubblewrap sandbox info in {}: {value:?}",
                path.display()
            ),
            Self::Spawn { program, source } => {
                write!(f, "failed to execute {}: {source}", program.display())
            }
            Self::Wait { program, source } => {
                write!(f, "failed to wait for {}: {source}", program.display())
            }
            Self::SandboxFailed { exit_code, stderr } => write!(
                f,
                "workspace sandbox failed with exit code {exit_code}: {}",
                stderr.trim()
            ),
            Self::ApplyFailed { exit_code, stderr } => write!(
                f,
                "workspace transaction apply failed with exit code {exit_code}: {}",
                stderr.trim()
            ),
            Self::Io { path, source } => {
                write!(
                    f,
                    "workspace transaction I/O failed for {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl Error for TransactionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Workspace(error) => Some(error),
            Self::Spawn { source, .. } | Self::Wait { source, .. } | Self::Io { source, .. } => {
                Some(source)
            }
            Self::TempInsideWorkspace(_)
            | Self::CreateTempExhausted(_)
            | Self::InvalidSandboxInfo { .. }
            | Self::SandboxFailed { .. }
            | Self::ApplyFailed { .. } => None,
        }
    }
}

impl From<WorkspaceConsistencyError> for TransactionError {
    fn from(value: WorkspaceConsistencyError) -> Self {
        Self::Workspace(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{WorkspaceDescriptor, WorkspaceId};
    use std::collections::BTreeSet;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "phenix-transaction-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn consistency(&self, scratch_paths: BTreeSet<PathBuf>) -> WorkspaceConsistency {
            WorkspaceConsistency::new(&WorkspaceDescriptor {
                id: WorkspaceId::parse("workspace:test").unwrap(),
                root: self.root.clone(),
                scratch_paths,
            })
            .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn bash() -> OsString {
        std::env::var_os("PHENIX_BASH").unwrap_or_else(|| OsString::from("bash"))
    }

    #[test]
    fn protected_changes_apply_git_changes_discard_and_scratch_writes_persist() {
        let fixture = Fixture::new("overlay");
        fs::create_dir_all(fixture.root.join(".git")).unwrap();
        fs::create_dir_all(fixture.root.join("target")).unwrap();
        fs::write(fixture.root.join("source.txt"), "old").unwrap();
        fs::write(fixture.root.join(".git/index"), "git-old").unwrap();
        fs::write(fixture.root.join("target/cache"), "scratch-old").unwrap();
        let transaction = WorkspaceTransaction::begin(
            fixture.consistency(BTreeSet::from([PathBuf::from("target")])),
        )
        .unwrap();

        let output = transaction
            .execute(
                &bash(),
                "printf new > source.txt; printf git-new > .git/index; printf scratch-new > target/cache; printf temporary > /tmp/phenix-only",
            )
            .unwrap();

        assert_eq!(output.exit_code, 0);
        assert_eq!(
            fs::read_to_string(fixture.root.join("source.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join(".git/index")).unwrap(),
            "git-old"
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("target/cache")).unwrap(),
            "scratch-new"
        );

        transaction.commit().unwrap();

        assert_eq!(
            fs::read_to_string(fixture.root.join("source.txt")).unwrap(),
            "new"
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join(".git/index")).unwrap(),
            "git-old"
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("target/cache")).unwrap(),
            "scratch-new"
        );
    }

    #[test]
    fn user_command_cannot_modify_transaction_control_state() {
        let fixture = Fixture::new("controls");
        fs::write(fixture.root.join("source.txt"), "old").unwrap();
        let transaction =
            WorkspaceTransaction::begin(fixture.consistency(BTreeSet::new())).unwrap();

        let output = transaction
            .execute(
                &bash(),
                "! printf tamper > /tmp/phenix-transaction-release 2>/dev/null; test ! -e /tmp/phenix-transaction-snapshot; test ! -e /tmp/phenix-transaction-excludes; printf new > source.txt",
            )
            .unwrap();

        assert_eq!(output.exit_code, 0);
        assert_eq!(fs::read_to_string(&transaction.paths.release).unwrap(), "1");
        transaction.commit().unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.join("source.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn nonzero_user_command_still_commits_its_protected_result() {
        let fixture = Fixture::new("nonzero");
        fs::write(fixture.root.join("source.txt"), "old").unwrap();
        let transaction =
            WorkspaceTransaction::begin(fixture.consistency(BTreeSet::new())).unwrap();

        let output = transaction
            .execute(
                &bash(),
                "printf new > source.txt; printf failure >&2; exit 7",
            )
            .unwrap();
        assert_eq!(output.exit_code, 7);
        assert!(String::from_utf8_lossy(&output.stderr).contains("failure"));

        transaction.commit().unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.join("source.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn concurrent_protected_path_creation_rejects_the_overlay_result() {
        let fixture = Fixture::new("conflict");
        fs::write(fixture.root.join("source.txt"), "old").unwrap();
        let transaction =
            WorkspaceTransaction::begin(fixture.consistency(BTreeSet::new())).unwrap();
        transaction
            .execute(&bash(), "printf agent > source.txt")
            .unwrap();
        fs::write(fixture.root.join("external.txt"), "external").unwrap();

        let error = transaction.commit().unwrap_err();

        assert!(matches!(
            error,
            TransactionError::Workspace(WorkspaceConsistencyError::Conflict(_))
        ));
        assert_eq!(
            fs::read_to_string(fixture.root.join("source.txt")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(fixture.root.join("external.txt")).unwrap(),
            "external"
        );
    }
}
