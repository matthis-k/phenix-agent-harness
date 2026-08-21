use phenix_core::{FileKind, FileObservation, FileVersion, WorkspaceConflict, WorkspaceDescriptor};
use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub enum WorkspaceConsistencyError {
    Io(io::Error),
    InvalidPath(PathBuf),
    Conflict(WorkspaceConflict),
    UnsupportedFileKind(PathBuf),
}

pub struct WorkspaceConsistency {
    root: PathBuf,
    scratch_paths: BTreeSet<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceRead {
    pub path: PathBuf,
    pub content: String,
    pub observation: Option<FileObservation>,
}

impl WorkspaceConsistency {
    pub fn new(
        workspace: &WorkspaceDescriptor,
    ) -> Result<Self, WorkspaceConsistencyError> {
        let root = fs::canonicalize(&workspace.root)?;
        let scratch_paths = workspace
            .scratch_paths
            .iter()
            .map(|path| normalize_relative(path))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            root,
            scratch_paths,
        })
    }

    pub fn read_utf8(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<WorkspaceRead, WorkspaceConsistencyError> {
        let relative = normalize_relative(path.as_ref())?;
        let resolved = self.resolve_existing(&relative)?;
        let metadata = fs::symlink_metadata(&resolved)?;
        if !metadata.file_type().is_file() {
            return Err(WorkspaceConsistencyError::UnsupportedFileKind(relative));
        }
        let content = fs::read_to_string(&resolved)?;
        let observation = if self.is_scratch(&relative) {
            None
        } else {
            Some(FileObservation {
                path: relative.clone(),
                version: fingerprint_file(&resolved, FileKind::Regular)?,
            })
        };
        Ok(WorkspaceRead {
            path: relative,
            content,
            observation,
        })
    }

    pub fn version_at(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<FileVersion, WorkspaceConsistencyError> {
        let relative = normalize_relative(path.as_ref())?;
        match self.resolve_existing(&relative) {
            Ok(resolved) => {
                let metadata = fs::symlink_metadata(&resolved)?;
                if metadata.file_type().is_file() {
                    fingerprint_file(&resolved, FileKind::Regular)
                } else if metadata.file_type().is_dir() {
                    Ok(FileVersion::Present {
                        content_hash: fingerprint(relative.as_os_str().as_encoded_bytes()),
                        kind: FileKind::Directory,
                    })
                } else if metadata.file_type().is_symlink() {
                    Ok(FileVersion::Present {
                        content_hash: fingerprint(relative.as_os_str().as_encoded_bytes()),
                        kind: FileKind::Symlink,
                    })
                } else {
                    Ok(FileVersion::Present {
                        content_hash: fingerprint(relative.as_os_str().as_encoded_bytes()),
                        kind: FileKind::Other,
                    })
                }
            }
            Err(WorkspaceConsistencyError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                self.resolve_parent(&relative)?;
                Ok(FileVersion::Absent)
            }
            Err(error) => Err(error),
        }
    }

    pub fn write_utf8(
        &self,
        path: impl AsRef<Path>,
        expected: Option<&FileVersion>,
        content: &str,
    ) -> Result<Option<FileObservation>, WorkspaceConsistencyError> {
        let relative = normalize_relative(path.as_ref())?;
        let scratch = self.is_scratch(&relative);
        if !scratch {
            let expected = expected.ok_or_else(|| WorkspaceConsistencyError::Conflict(
                WorkspaceConflict {
                    path: relative.clone(),
                    expected: FileVersion::Absent,
                    actual: self.version_at(&relative)?,
                },
            ))?;
            self.ensure_version(&relative, expected)?;
        }
        let destination = self.resolve_write_target(&relative)?;
        atomic_write(&destination, content.as_bytes())?;
        if scratch {
            return Ok(None);
        }
        Ok(Some(FileObservation {
            path: relative,
            version: fingerprint_file(&destination, FileKind::Regular)?,
        }))
    }

    pub fn edit_utf8(
        &self,
        path: impl AsRef<Path>,
        expected: &FileVersion,
        old: &str,
        new: &str,
        replace_all: bool,
    ) -> Result<Option<FileObservation>, WorkspaceConsistencyError> {
        let relative = normalize_relative(path.as_ref())?;
        self.ensure_version(&relative, expected)?;
        let resolved = self.resolve_existing(&relative)?;
        let metadata = fs::symlink_metadata(&resolved)?;
        if !metadata.file_type().is_file() {
            return Err(WorkspaceConsistencyError::UnsupportedFileKind(relative));
        }
        let content = fs::read_to_string(&resolved)?;
        let matches = content.matches(old).count();
        if matches == 0 {
            return Err(WorkspaceConsistencyError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "edit pattern was not found",
            )));
        }
        if !replace_all && matches != 1 {
            return Err(WorkspaceConsistencyError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "edit pattern is not unique",
            )));
        }
        let edited = if replace_all {
            content.replace(old, new)
        } else {
            content.replacen(old, new, 1)
        };
        atomic_write(&resolved, edited.as_bytes())?;
        if self.is_scratch(&relative) {
            return Ok(None);
        }
        Ok(Some(FileObservation {
            path: relative,
            version: fingerprint_file(&resolved, FileKind::Regular)?,
        }))
    }

    fn is_scratch(&self, relative: &Path) -> bool {
        self.scratch_paths
            .iter()
            .any(|scratch| relative == scratch || relative.starts_with(scratch))
    }

    fn ensure_version(
        &self,
        relative: &Path,
        expected: &FileVersion,
    ) -> Result<(), WorkspaceConsistencyError> {
        let actual = self.version_at(relative)?;
        if actual == *expected {
            return Ok(());
        }
        Err(WorkspaceConsistencyError::Conflict(WorkspaceConflict {
            path: relative.to_path_buf(),
            expected: expected.clone(),
            actual,
        }))
    }

    fn resolve_existing(&self, relative: &Path) -> Result<PathBuf, WorkspaceConsistencyError> {
        let resolved = fs::canonicalize(self.root.join(relative))?;
        self.ensure_inside(&resolved, relative)?;
        Ok(resolved)
    }

    fn resolve_parent(&self, relative: &Path) -> Result<PathBuf, WorkspaceConsistencyError> {
        let Some(parent) = relative.parent() else {
            return Ok(self.root.clone());
        };
        let resolved = fs::canonicalize(self.root.join(parent))?;
        self.ensure_inside(&resolved, relative)?;
        Ok(resolved)
    }

    fn resolve_write_target(&self, relative: &Path) -> Result<PathBuf, WorkspaceConsistencyError> {
        match self.resolve_existing(relative) {
            Ok(resolved) => Ok(resolved),
            Err(WorkspaceConsistencyError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                let parent = self.resolve_parent(relative)?;
                let name = relative
                    .file_name()
                    .ok_or_else(|| WorkspaceConsistencyError::InvalidPath(relative.to_path_buf()))?;
                Ok(parent.join(name))
            }
            Err(error) => Err(error),
        }
    }

    fn ensure_inside(
        &self,
        resolved: &Path,
        requested: &Path,
    ) -> Result<(), WorkspaceConsistencyError> {
        if resolved.starts_with(&self.root) {
            Ok(())
        } else {
            Err(WorkspaceConsistencyError::InvalidPath(
                requested.to_path_buf(),
            ))
        }
    }
}

impl Display for WorkspaceConsistencyError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "workspace I/O failed: {error}"),
            Self::InvalidPath(path) => write!(
                formatter,
                "workspace path escapes its root: {}",
                path.display()
            ),
            Self::Conflict(conflict) => write!(
                formatter,
                "workspace file changed since it was observed: {}",
                conflict.path.display()
            ),
            Self::UnsupportedFileKind(path) => write!(
                formatter,
                "workspace path is not a regular file: {}",
                path.display()
            ),
        }
    }
}

impl Error for WorkspaceConsistencyError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::InvalidPath(_) | Self::Conflict(_) | Self::UnsupportedFileKind(_) => None,
        }
    }
}

impl From<io::Error> for WorkspaceConsistencyError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

fn normalize_relative(path: &Path) -> Result<PathBuf, WorkspaceConsistencyError> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(WorkspaceConsistencyError::InvalidPath(path.to_path_buf()));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceConsistencyError::InvalidPath(path.to_path_buf()));
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(WorkspaceConsistencyError::InvalidPath(path.to_path_buf()));
    }
    Ok(normalized)
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), WorkspaceConsistencyError> {
    let parent = path
        .parent()
        .ok_or_else(|| WorkspaceConsistencyError::InvalidPath(path.to_path_buf()))?;
    let name = path
        .file_name()
        .ok_or_else(|| WorkspaceConsistencyError::InvalidPath(path.to_path_buf()))?;
    let mut temporary = parent.join(format!(".{}.phenix-tmp", name.to_string_lossy()));
    let mut suffix = 0_u64;
    while temporary.exists() {
        suffix += 1;
        temporary = parent.join(format!(
            ".{}.phenix-tmp-{suffix}",
            name.to_string_lossy()
        ));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(content)?;
    file.sync_all()?;
    drop(file);
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error.into())
        }
    }
}

fn fingerprint_file(
    path: &Path,
    kind: FileKind,
) -> Result<FileVersion, WorkspaceConsistencyError> {
    let bytes = fs::read(path)?;
    Ok(FileVersion::Present {
        content_hash: fingerprint(&bytes),
        kind,
    })
}

fn fingerprint(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::WorkspaceId;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "phenix-workspace-consistency-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn descriptor(&self, scratch_paths: BTreeSet<PathBuf>) -> WorkspaceDescriptor {
            WorkspaceDescriptor {
                id: WorkspaceId::parse("workspace-1").unwrap(),
                root: self.root.clone(),
                scratch_paths,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn source_reads_return_versions() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("source.rs"), "fn main() {}\n").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        let first = guard.read_utf8("source.rs").unwrap();
        let second = guard.read_utf8("source.rs").unwrap();

        assert_eq!(first.observation, second.observation);
        assert!(first.observation.is_some());
    }

    #[test]
    fn scratch_reads_are_unversioned() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("target")).unwrap();
        fs::write(fixture.root.join("target/build.log"), "scratch").unwrap();
        let guard = WorkspaceConsistency::new(
            &fixture.descriptor(BTreeSet::from([PathBuf::from("target")])),
        )
        .unwrap();

        assert!(guard
            .read_utf8("target/build.log")
            .unwrap()
            .observation
            .is_none());
    }

    #[test]
    fn exact_versions_change_only_for_changed_files() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("a.rs"), "a1").unwrap();
        fs::write(fixture.root.join("b.rs"), "b1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let a_before = guard.read_utf8("a.rs").unwrap().observation.unwrap();
        let b_before = guard.read_utf8("b.rs").unwrap().observation.unwrap();

        fs::write(fixture.root.join("a.rs"), "a2").unwrap();
        let a_after = guard.read_utf8("a.rs").unwrap().observation.unwrap();
        let b_after = guard.read_utf8("b.rs").unwrap().observation.unwrap();

        assert_ne!(a_before.version, a_after.version);
        assert_eq!(b_before.version, b_after.version);
    }

    #[test]
    fn stale_write_is_rejected() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "v1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.read_utf8("source.rs").unwrap().observation.unwrap();
        fs::write(&path, "external").unwrap();

        let error = guard
            .write_utf8("source.rs", Some(&observed.version), "agent")
            .unwrap_err();

        assert!(matches!(error, WorkspaceConsistencyError::Conflict(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "external");
    }

    #[test]
    fn new_source_write_requires_absent_version() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        guard
            .write_utf8("new.rs", Some(&FileVersion::Absent), "new")
            .unwrap();

        assert_eq!(fs::read_to_string(fixture.root.join("new.rs")).unwrap(), "new");
    }

    #[test]
    fn source_write_requires_expected_version() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        let error = guard.write_utf8("new.rs", None, "new").unwrap_err();

        assert!(matches!(error, WorkspaceConsistencyError::Conflict(_)));
    }

    #[test]
    fn scratch_write_does_not_require_expected_version() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("target")).unwrap();
        let guard = WorkspaceConsistency::new(
            &fixture.descriptor(BTreeSet::from([PathBuf::from("target")])),
        )
        .unwrap();

        assert!(guard
            .write_utf8("target/output", None, "scratch")
            .unwrap()
            .is_none());
        assert_eq!(
            fs::read_to_string(fixture.root.join("target/output")).unwrap(),
            "scratch"
        );
    }

    #[test]
    fn guarded_source_write_returns_new_version() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "v1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.read_utf8("source.rs").unwrap().observation.unwrap();

        let written = guard
            .write_utf8("source.rs", Some(&observed.version), "v2")
            .unwrap()
            .unwrap();

        assert_ne!(written.version, observed.version);
        assert_eq!(fs::read_to_string(path).unwrap(), "v2");
    }

    #[test]
    fn parent_traversal_is_rejected() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        assert!(matches!(
            guard.read_utf8("../outside"),
            Err(WorkspaceConsistencyError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_parent_cannot_escape_workspace_even_for_scratch() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let outside = fixture
            .root
            .parent()
            .unwrap()
            .join(format!("phenix-workspace-outside-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, fixture.root.join("scratch-link")).unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::from([
            PathBuf::from("scratch-link"),
        ])))
        .unwrap();

        let error = guard
            .write_utf8("scratch-link/escape", None, "nope")
            .unwrap_err();

        assert!(matches!(error, WorkspaceConsistencyError::InvalidPath(_)));
        assert!(!outside.join("escape").exists());
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn edit_rejects_stale_version() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "one two").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.read_utf8("source.rs").unwrap().observation.unwrap();
        fs::write(&path, "external").unwrap();

        let error = guard
            .edit_utf8("source.rs", &observed.version, "one", "three", false)
            .unwrap_err();

        assert!(matches!(error, WorkspaceConsistencyError::Conflict(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "external");
    }

    #[test]
    fn conflicts_preserve_expected_and_actual_versions() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "before").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.read_utf8("source.rs").unwrap().observation.unwrap();
        fs::write(&path, "after").unwrap();

        let WorkspaceConsistencyError::Conflict(conflict) = guard
            .write_utf8("source.rs", Some(&observed.version), "agent")
            .unwrap_err()
        else {
            panic!("expected workspace conflict");
        };

        assert_eq!(conflict.path, PathBuf::from("source.rs"));
        assert_eq!(conflict.expected, observed.version);
        assert_ne!(conflict.actual, conflict.expected);
    }

    #[test]
    fn absent_file_version_changes_after_creation() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        assert_eq!(guard.version_at("new.rs").unwrap(), FileVersion::Absent);
        fs::write(fixture.root.join("new.rs"), "present").unwrap();
        assert!(matches!(
            guard.version_at("new.rs").unwrap(),
            FileVersion::Present { .. }
        ));
    }

    #[test]
    fn invalid_source_path_is_rejected_for_version_lookup() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        assert!(matches!(
            guard.version_at("../escape"),
            Err(WorkspaceConsistencyError::InvalidPath(_))
        ));
    }

    #[test]
    fn write_target_is_kept_inside_workspace() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let result = guard.write_utf8("new.rs", Some(&FileVersion::Absent), "safe");
        assert!(result.is_ok());
        let path = fixture.root.join("new.rs");
        assert!(path.exists());
        assert!(path.starts_with(&fixture.root));
    }

    #[test]
    fn atomic_write_replaces_existing_content() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "old").unwrap();

        atomic_write(&path, b"new").unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "new");
    }

    #[test]
    fn directory_version_is_stable_for_same_path() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("dir")).unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        let first = guard.version_at("dir").unwrap();
        let second = guard.version_at("dir").unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn source_write_conflict_is_file_scoped() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("a.rs"), "a1").unwrap();
        fs::write(fixture.root.join("b.rs"), "b1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let a = guard.read_utf8("a.rs").unwrap().observation.unwrap();
        let b = guard.read_utf8("b.rs").unwrap().observation.unwrap();
        fs::write(fixture.root.join("a.rs"), "a2").unwrap();

        assert!(matches!(
            guard.write_utf8("a.rs", Some(&a.version), "agent"),
            Err(WorkspaceConsistencyError::Conflict(_))
        ));
        assert!(guard
            .write_utf8("b.rs", Some(&b.version), "b2")
            .is_ok());
    }

    #[test]
    fn invalid_write_path_is_rejected() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        assert!(matches!(
            guard.write_utf8("../escape", Some(&FileVersion::Absent), "bad"),
            Err(WorkspaceConsistencyError::InvalidPath(_))
        ));
    }

    #[test]
    fn scratch_prefix_does_not_match_sibling_path() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("target-other"), "source").unwrap();
        let guard = WorkspaceConsistency::new(
            &fixture.descriptor(BTreeSet::from([PathBuf::from("target")])),
        )
        .unwrap();

        assert!(guard
            .read_utf8("target-other")
            .unwrap()
            .observation
            .is_some());
    }

    #[test]
    fn version_lookup_rejects_symlink_escape() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let fixture = Fixture::new();
            let outside = fixture.root.parent().unwrap().join(format!(
                "phenix-workspace-version-outside-{}",
                std::process::id()
            ));
            fs::write(&outside, "outside").unwrap();
            symlink(&outside, fixture.root.join("link")).unwrap();
            let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

            assert!(matches!(
                guard.version_at("link"),
                Err(WorkspaceConsistencyError::InvalidPath(_))
            ));
            let _ = fs::remove_file(outside);
        }
    }

    #[test]
    fn edit_updates_expected_content() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "one two").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.read_utf8("source.rs").unwrap().observation.unwrap();

        let updated = guard
            .edit_utf8("source.rs", &observed.version, "two", "three", false)
            .unwrap()
            .unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "one three");
        assert_ne!(updated.version, observed.version);
    }

    #[test]
    fn edit_requires_unique_pattern_without_replace_all() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "same same").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.read_utf8("source.rs").unwrap().observation.unwrap();

        assert!(guard
            .edit_utf8("source.rs", &observed.version, "same", "other", false)
            .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "same same");
    }

    #[test]
    fn edit_replace_all_updates_every_match() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "same same").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.read_utf8("source.rs").unwrap().observation.unwrap();

        guard
            .edit_utf8("source.rs", &observed.version, "same", "other", true)
            .unwrap();

        assert_eq!(fs::read_to_string(path).unwrap(), "other other");
    }

    #[test]
    fn write_rejects_directory_target() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("dir")).unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let version = guard.version_at("dir").unwrap();

        assert!(guard.write_utf8("dir", Some(&version), "bad").is_err());
    }

    #[test]
    fn file_version_differs_for_different_content() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "one").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let one = guard.version_at("source.rs").unwrap();
        fs::write(&path, "two").unwrap();
        let two = guard.version_at("source.rs").unwrap();

        assert_ne!(one, two);
    }

    #[test]
    fn absent_parent_must_be_inside_workspace() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        assert!(guard.version_at("missing/file").is_err());
    }

    #[test]
    fn write_to_existing_file_does_not_require_parent_recreation() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("existing"), "old").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let version = guard.version_at("existing").unwrap();

        guard
            .write_utf8("existing", Some(&version), "new")
            .unwrap();

        assert_eq!(fs::read_to_string(fixture.root.join("existing")).unwrap(), "new");
    }

    #[test]
    fn source_write_conflict_reports_absent_expected_for_created_file() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        fs::write(fixture.root.join("new.rs"), "external").unwrap();

        let WorkspaceConsistencyError::Conflict(conflict) = guard
            .write_utf8("new.rs", Some(&FileVersion::Absent), "agent")
            .unwrap_err()
        else {
            panic!("expected conflict");
        };

        assert_eq!(conflict.expected, FileVersion::Absent);
        assert!(matches!(conflict.actual, FileVersion::Present { .. }));
    }

    #[test]
    fn conflict_path_uses_normalized_relative_path() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("source.rs"), "external").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        let WorkspaceConsistencyError::Conflict(conflict) = guard
            .write_utf8("./source.rs", Some(&FileVersion::Absent), "agent")
            .unwrap_err()
        else {
            panic!("expected conflict");
        };

        assert_eq!(conflict.path, Path::new("source.rs"));
    }
}
