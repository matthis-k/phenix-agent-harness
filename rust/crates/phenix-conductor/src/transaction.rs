use super::super::workspace_consistency::WorkspaceConsistencyError;
use super::WorkspaceConsistency;
use crate::sandbox::{ExecutionSandbox, ExecutionSandboxState, SandboxCommand, WorkspaceMount};
use phenix_core::{DiagnosticWritePatch, ExecutionAuthority, ExecutionId, FileKind, FileVersion};
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const SANDBOX_SNAPSHOT_RELATIVE: &str = ".phenix-transaction/snapshot";
const SANDBOX_RESULT_STATUS_RELATIVE: &str = ".phenix-transaction/result-status";
const COMMAND_SCRIPT: &str = r#"
bash_path=$1
rsync_path=$2
rm_path=$3
mkdir_path=$4
workspace=$5
exclude_rules=$6
user_command=$7

command_status=0
"$bash_path" -c "$user_command" </dev/null || command_status=$?

while :; do
  descendants=0
  for process in /proc/[0-9]*; do
    pid=${process##*/}
    case "$pid" in
      1|"$$") continue ;;
    esac
    descendants=1
    kill -KILL "$pid" 2>/dev/null || true
  done
  [ "$descendants" -eq 0 ] && break
done

control="$workspace/.phenix-transaction"
snapshot="$control/snapshot"
excludes="$control/excludes"
result_status="$control/result-status"

"$rm_path" -rf -- "$control" || exit $?
"$mkdir_path" -p -- "$snapshot" || exit $?
printf '%s' "$exclude_rules" > "$excludes" || exit $?

"$rsync_path" \
  -rlpt \
  --delete \
  --delete-delay \
  --delay-updates \
  --quiet \
  --exclude-from "$excludes" \
  "$workspace/." \
  "$snapshot/." || { snapshot_status=$?; exit "$snapshot_status"; }

printf '%s\n' "$command_status" > "$result_status"
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
    authority: ExecutionAuthority,
    sandbox_state: Arc<ExecutionSandboxState>,
}

impl WorkspaceTransaction {
    pub fn begin(
        consistency: WorkspaceConsistency,
        authority: ExecutionAuthority,
        sandbox_state: Arc<ExecutionSandboxState>,
    ) -> Result<Self, TransactionError> {
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
            authority,
            sandbox_state,
        })
    }

    pub fn execute(
        &self,
        bash: &OsStr,
        command: &str,
    ) -> Result<TransactionOutput, TransactionError> {
        let bwrap = std::env::var_os("PHENIX_BWRAP").unwrap_or_else(|| OsString::from("bwrap"));
        let rm = std::env::var_os("PHENIX_RM").unwrap_or_else(|| OsString::from("rm"));
        let mkdir = std::env::var_os("PHENIX_MKDIR").unwrap_or_else(|| OsString::from("mkdir"));
        let exclude_rules =
            fs::read_to_string(&self.paths.excludes).map_err(|source| TransactionError::Io {
                path: self.paths.excludes.clone(),
                source,
            })?;
        let output = self
            .sandbox_command(&bwrap, &self.paths.command_work)?
            .arg("--")
            .arg(bash)
            .arg("-c")
            .arg(COMMAND_SCRIPT)
            .arg("phenix-transaction")
            .arg(bash)
            .arg(&self.rsync)
            .arg(&rm)
            .arg(&mkdir)
            .arg(self.consistency.root())
            .arg(exclude_rules)
            .arg(command)
            .output()
            .map_err(TransactionError::SandboxConfiguration)?;
        if !output.status.success() {
            return Err(TransactionError::SandboxFailed {
                exit_code: output.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }

        let result_status = self.paths.result_status();
        let status = fs::read_to_string(&result_status).map_err(|source| TransactionError::Io {
            path: result_status.clone(),
            source,
        })?;
        let exit_code = match status.trim().parse::<i32>() {
            Ok(code) if (0..=255).contains(&code) => code,
            _ => {
                return Err(TransactionError::InvalidSandboxStatus {
                    path: result_status,
                    value: status,
                });
            }
        };

        Ok(TransactionOutput {
            exit_code,
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    pub fn commit(&self) -> Result<(), TransactionError> {
        let snapshot = self.paths.snapshot();
        let snapshot_manifest = self.consistency.snapshot_manifest(&snapshot)?;
        self.consistency
            .validate_checkpoint_baseline(&self.baseline)?;

        let output = Command::new(&self.rsync)
            .arg("-rlpt")
            .arg("--checksum")
            .arg("--delete")
            .arg("--delete-delay")
            .arg("--delay-updates")
            .arg("--quiet")
            .arg("--exclude-from")
            .arg(&self.paths.excludes)
            .arg(snapshot.join("."))
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

    pub fn diagnostic_patches(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<Vec<DiagnosticWritePatch>, TransactionError> {
        let snapshot = self.paths.snapshot();
        let snapshot_manifest = self.consistency.snapshot_manifest(&snapshot)?;
        let paths = self
            .baseline
            .keys()
            .chain(snapshot_manifest.keys())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let mut patches = Vec::new();
        for path in paths {
            let before = self.baseline.get(&path).unwrap_or(&FileVersion::Absent);
            let after = snapshot_manifest.get(&path).unwrap_or(&FileVersion::Absent);
            if before == after || (!regular_or_absent(before) && !regular_or_absent(after)) {
                continue;
            }
            let old = read_patch_text(&self.consistency.root().join(&path));
            let new = read_patch_text(&snapshot.join(&path));
            patches.push(DiagnosticWritePatch {
                execution_id: execution_id.clone(),
                path: path.clone(),
                patch: unified_diagnostic_patch(&path, old.as_deref(), new.as_deref()),
            });
        }
        Ok(patches)
    }

    fn sandbox_command(
        &self,
        bwrap: &OsStr,
        work: &Path,
    ) -> Result<SandboxCommand, TransactionError> {
        ExecutionSandbox::new(&self.authority, &self.sandbox_state)
            .configure_bwrap(
                bwrap,
                self.consistency.root(),
                &self.scratch_mounts,
                WorkspaceMount::Overlay {
                    upper: &self.paths.upper,
                    work,
                },
            )
            .map_err(TransactionError::SandboxConfiguration)
    }
}

fn regular_or_absent(version: &FileVersion) -> bool {
    matches!(
        version,
        FileVersion::Absent
            | FileVersion::Present {
                kind: FileKind::Regular,
                ..
            }
    )
}

fn read_patch_text(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn unified_diagnostic_patch(path: &Path, old: Option<&str>, new: Option<&str>) -> String {
    let label = path.to_string_lossy();
    let old_label = old.map_or_else(|| "/dev/null".to_owned(), |_| format!("a/{label}"));
    let new_label = new.map_or_else(|| "/dev/null".to_owned(), |_| format!("b/{label}"));
    let old_lines = old.map_or_else(Vec::new, |text| text.lines().collect::<Vec<_>>());
    let new_lines = new.map_or_else(Vec::new, |text| text.lines().collect::<Vec<_>>());
    let mut patch = format!(
        "--- {old_label}\n+++ {new_label}\n@@ -1,{} +1,{} @@\n",
        old_lines.len(),
        new_lines.len()
    );
    for line in old_lines {
        patch.push('-');
        patch.push_str(line);
        patch.push('\n');
    }
    for line in new_lines {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    patch
}

#[derive(Debug)]
struct TransactionPaths {
    root: PathBuf,
    upper: PathBuf,
    command_work: PathBuf,
    excludes: PathBuf,
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
                    for path in [&upper, &command_work] {
                        fs::create_dir(path).map_err(|source| TransactionError::Io {
                            path: path.clone(),
                            source,
                        })?;
                    }
                    return Ok(Self {
                        excludes: root.join("excludes"),
                        root,
                        upper,
                        command_work,
                    });
                }
                Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(source) => return Err(TransactionError::Io { path: root, source }),
            }
        }
        Err(TransactionError::CreateTempExhausted(canonical_parent))
    }

    fn snapshot(&self) -> PathBuf {
        self.upper.join(SANDBOX_SNAPSHOT_RELATIVE)
    }

    fn result_status(&self) -> PathBuf {
        self.upper.join(SANDBOX_RESULT_STATUS_RELATIVE)
    }

    fn write_excludes(
        &self,
        scratch_mounts: &[(PathBuf, PathBuf)],
    ) -> Result<(), TransactionError> {
        let mut rules = String::from(".git\n.phenix-transaction\n");
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
    InvalidSandboxStatus {
        path: PathBuf,
        value: String,
    },
    Spawn {
        program: PathBuf,
        source: std::io::Error,
    },
    SandboxFailed {
        exit_code: i32,
        stderr: String,
    },
    SandboxConfiguration(String),
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
            Self::InvalidSandboxStatus { path, value } => write!(
                f,
                "invalid Bubblewrap sandbox status in {}: {value:?}",
                path.display()
            ),
            Self::Spawn { program, source } => {
                write!(f, "failed to execute {}: {source}", program.display())
            }
            Self::SandboxFailed { exit_code, stderr } => write!(
                f,
                "workspace sandbox failed with exit code {exit_code}: {}",
                stderr.trim()
            ),
            Self::SandboxConfiguration(message) => {
                write!(f, "workspace sandbox configuration failed: {message}")
            }
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
            Self::Spawn { source, .. } | Self::Io { source, .. } => Some(source),
            Self::TempInsideWorkspace(_)
            | Self::CreateTempExhausted(_)
            | Self::InvalidSandboxStatus { .. }
            | Self::SandboxConfiguration(_)
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

    fn begin_transaction(
        consistency: WorkspaceConsistency,
    ) -> Result<WorkspaceTransaction, TransactionError> {
        let authority = ExecutionAuthority {
            filesystem: phenix_core::FilesystemAuthority::Write,
            ..ExecutionAuthority::default()
        };
        WorkspaceTransaction::begin(
            consistency,
            authority,
            ExecutionSandboxState::create().unwrap(),
        )
    }

    #[test]
    fn protected_changes_apply_git_changes_discard_and_scratch_writes_persist() {
        let fixture = Fixture::new("overlay");
        fs::create_dir_all(fixture.root.join(".git")).unwrap();
        fs::create_dir_all(fixture.root.join("target")).unwrap();
        fs::write(fixture.root.join("source.txt"), "old").unwrap();
        fs::write(fixture.root.join(".git/index"), "git-old").unwrap();
        fs::write(fixture.root.join("target/cache"), "scratch-old").unwrap();
        let transaction =
            begin_transaction(fixture.consistency(BTreeSet::from([PathBuf::from("target")])))
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
    fn apply_checks_content_when_size_and_mtime_match() {
        let fixture = Fixture::new("checksum");
        let source = fixture.root.join("source.txt");
        fs::write(&source, "old").unwrap();
        let transaction = begin_transaction(fixture.consistency(BTreeSet::new())).unwrap();
        transaction
            .execute(&bash(), "printf new > source.txt")
            .unwrap();

        let snapshot = transaction.paths.snapshot().join("source.txt");
        let snapshot_modified = fs::metadata(snapshot).unwrap().modified().unwrap();
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(snapshot_modified))
            .unwrap();

        transaction.commit().unwrap();
        assert_eq!(fs::read_to_string(source).unwrap(), "new");
    }

    #[test]
    fn user_command_cannot_modify_transaction_control_state() {
        let fixture = Fixture::new("controls");
        fs::write(fixture.root.join("source.txt"), "old").unwrap();
        let transaction = begin_transaction(fixture.consistency(BTreeSet::new())).unwrap();

        let output = transaction
            .execute(
                &bash(),
                "rm -rf .phenix-transaction; mkdir -p .phenix-transaction/snapshot; printf tamper > .phenix-transaction/snapshot/source.txt; printf 99 > .phenix-transaction/result-status; printf new > source.txt",
            )
            .unwrap();

        assert_eq!(output.exit_code, 0);
        assert_eq!(
            fs::read_to_string(transaction.paths.result_status()).unwrap(),
            "0\n"
        );
        assert_eq!(
            fs::read_to_string(transaction.paths.snapshot().join("source.txt")).unwrap(),
            "new"
        );
        transaction.commit().unwrap();
        assert_eq!(
            fs::read_to_string(fixture.root.join("source.txt")).unwrap(),
            "new"
        );
    }

    #[test]
    fn background_user_process_cannot_modify_transaction_control_state() {
        let fixture = Fixture::new("background-controls");
        fs::write(fixture.root.join("source.txt"), "old").unwrap();
        let transaction = begin_transaction(fixture.consistency(BTreeSet::new())).unwrap();

        let output = transaction
            .execute(
                &bash(),
                "printf new > source.txt; (while :; do mkdir -p .phenix-transaction/snapshot; printf tamper > .phenix-transaction/snapshot/source.txt; printf 99 > .phenix-transaction/result-status; done) >/dev/null 2>&1 &",
            )
            .unwrap();

        assert_eq!(output.exit_code, 0);
        assert_eq!(
            fs::read_to_string(transaction.paths.result_status()).unwrap(),
            "0\n"
        );
        assert_eq!(
            fs::read_to_string(transaction.paths.snapshot().join("source.txt")).unwrap(),
            "new"
        );
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
        let transaction = begin_transaction(fixture.consistency(BTreeSet::new())).unwrap();

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
        let transaction = begin_transaction(fixture.consistency(BTreeSet::new())).unwrap();
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
