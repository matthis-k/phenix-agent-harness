use phenix_core::{
    ExecutionReadSet, FileKind, FileObservation, FileVersion, WorkspaceConflict, WorkspaceDescriptor,
};
use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::path::{Component, Path, PathBuf};

const FNV_128_OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
const FNV_128_PRIME: u128 = 0x0000000001000000000000000000013b;

#[derive(Clone, Debug)]
pub struct WorkspaceConsistency {
    root: PathBuf,
    scratch_paths: BTreeSet<PathBuf>,
}

impl WorkspaceConsistency {
    pub fn new(descriptor: &WorkspaceDescriptor) -> Result<Self, WorkspaceConsistencyError> {
        let root = fs::canonicalize(&descriptor.root).map_err(|source| {
            WorkspaceConsistencyError::Io {
                path: descriptor.root.clone(),
                source,
            }
        })?;
        Ok(Self {
            root,
            scratch_paths: descriptor.scratch_paths.clone(),
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn observe(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<Option<FileObservation>, WorkspaceConsistencyError> {
        let relative = normalize_relative(path.as_ref())?;
        if self.is_scratch(&relative) {
            return Ok(None);
        }
        let version = self.version_at(&relative)?;
        Ok(Some(FileObservation {
            path: relative,
            version,
        }))
    }

    pub fn validate(
        &self,
        reads: &ExecutionReadSet,
    ) -> Result<Vec<WorkspaceConflict>, WorkspaceConsistencyError> {
        let mut conflicts = Vec::new();
        for (path, expected) in &reads.files {
            let relative = normalize_relative(path)?;
            if self.is_scratch(&relative) {
                continue;
            }
            let actual = self.version_at(&relative)?;
            if actual != *expected {
                conflicts.push(WorkspaceConflict {
                    path: relative,
                    expected: expected.clone(),
                    actual,
                });
            }
        }
        Ok(conflicts)
    }

    pub fn write_source_if_version(
        &self,
        path: impl AsRef<Path>,
        expected: &FileVersion,
        content: &[u8],
    ) -> Result<FileObservation, WorkspaceConsistencyError> {
        let relative = normalize_relative(path.as_ref())?;
        if self.is_scratch(&relative) {
            return Err(WorkspaceConsistencyError::ScratchPath(relative));
        }
        let actual = self.version_at(&relative)?;
        if actual != *expected {
            return Err(WorkspaceConsistencyError::Conflict(WorkspaceConflict {
                path: relative,
                expected: expected.clone(),
                actual,
            }));
        }
        if let FileVersion::Present { kind, .. } = &actual {
            if *kind != FileKind::Regular {
                return Err(WorkspaceConsistencyError::UnsupportedWriteTarget {
                    path: relative,
                    kind: kind.clone(),
                });
            }
        }

        let target = self.root.join(&relative);
        self.ensure_ancestor_inside(&target)?;
        fs::write(&target, content).map_err(|source| WorkspaceConsistencyError::Io {
            path: target,
            source,
        })?;
        let version = self.version_at(&relative)?;
        Ok(FileObservation {
            path: relative,
            version,
        })
    }

    fn is_scratch(&self, relative: &Path) -> bool {
        self.scratch_paths
            .iter()
            .any(|scratch| relative == scratch || relative.starts_with(scratch))
    }

    fn version_at(&self, relative: &Path) -> Result<FileVersion, WorkspaceConsistencyError> {
        let target = self.root.join(relative);
        self.ensure_ancestor_inside(&target)?;
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(FileVersion::Absent)
            }
            Err(source) => {
                return Err(WorkspaceConsistencyError::Io {
                    path: target,
                    source,
                })
            }
        };
        let file_type = metadata.file_type();
        let kind = if file_type.is_file() {
            FileKind::Regular
        } else if file_type.is_dir() {
            FileKind::Directory
        } else if file_type.is_symlink() {
            FileKind::Symlink
        } else {
            FileKind::Other
        };
        let hash = match kind {
            FileKind::Regular => {
                let canonical = fs::canonicalize(&target).map_err(|source| {
                    WorkspaceConsistencyError::Io {
                        path: target.clone(),
                        source,
                    }
                })?;
                self.ensure_canonical_inside(&canonical)?;
                fingerprint(&fs::read(&canonical).map_err(|source| {
                    WorkspaceConsistencyError::Io {
                        path: canonical,
                        source,
                    }
                })?)
            }
            FileKind::Directory => {
                let canonical = fs::canonicalize(&target).map_err(|source| {
                    WorkspaceConsistencyError::Io {
                        path: target.clone(),
                        source,
                    }
                })?;
                self.ensure_canonical_inside(&canonical)?;
                let mut entries = fs::read_dir(&canonical)
                    .map_err(|source| WorkspaceConsistencyError::Io {
                        path: canonical.clone(),
                        source,
                    })?
                    .map(|entry| {
                        entry
                            .map(|entry| entry.file_name().to_string_lossy().into_owned())
                            .map_err(|source| WorkspaceConsistencyError::Io {
                                path: canonical.clone(),
                                source,
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                entries.sort();
                fingerprint(entries.join("\0").as_bytes())
            }
            FileKind::Symlink => {
                let link = fs::read_link(&target).map_err(|source| WorkspaceConsistencyError::Io {
                    path: target.clone(),
                    source,
                })?;
                fingerprint(link.to_string_lossy().as_bytes())
            }
            FileKind::Other => fingerprint(metadata.len().to_string().as_bytes()),
        };
        Ok(FileVersion::Present {
            content_hash: hash,
            kind,
        })
    }

    fn ensure_ancestor_inside(&self, target: &Path) -> Result<(), WorkspaceConsistencyError> {
        let mut candidate = target.parent().unwrap_or(&self.root);
        loop {
            match fs::canonicalize(candidate) {
                Ok(canonical) => return self.ensure_canonical_inside(&canonical),
                Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                    candidate = candidate.parent().ok_or_else(|| {
                        WorkspaceConsistencyError::EscapesWorkspace(target.to_path_buf())
                    })?;
                }
                Err(source) => {
                    return Err(WorkspaceConsistencyError::Io {
                        path: candidate.to_path_buf(),
                        source,
                    })
                }
            }
        }
    }

    fn ensure_canonical_inside(&self, path: &Path) -> Result<(), WorkspaceConsistencyError> {
        if path == self.root || path.starts_with(&self.root) {
            Ok(())
        } else {
            Err(WorkspaceConsistencyError::EscapesWorkspace(
                path.to_path_buf(),
            ))
        }
    }
}

#[derive(Debug)]
pub enum WorkspaceConsistencyError {
    InvalidPath(PathBuf),
    EscapesWorkspace(PathBuf),
    ScratchPath(PathBuf),
    UnsupportedWriteTarget { path: PathBuf, kind: FileKind },
    Conflict(WorkspaceConflict),
    Io { path: PathBuf, source: std::io::Error },
}

impl Display for WorkspaceConsistencyError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath(path) => write!(
                f,
                "workspace path must be a non-empty relative path without parent traversal: {}",
                path.display()
            ),
            Self::EscapesWorkspace(path) => {
                write!(f, "workspace path escapes the workspace root: {}", path.display())
            }
            Self::ScratchPath(path) => write!(
                f,
                "scratch path is excluded from authoritative source writes: {}",
                path.display()
            ),
            Self::UnsupportedWriteTarget { path, kind } => write!(
                f,
                "guarded source write requires a regular file or absent path, found {kind:?}: {}",
                path.display()
            ),
            Self::Conflict(conflict) => write!(
                f,
                "workspace file changed since it was observed: {}",
                conflict.path.display()
            ),
            Self::Io { path, source } => {
                write!(f, "workspace I/O failed for {}: {source}", path.display())
            }
        }
    }
}

impl Error for WorkspaceConsistencyError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

fn normalize_relative(path: &Path) -> Result<PathBuf, WorkspaceConsistencyError> {
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceConsistencyError::InvalidPath(path.to_path_buf()))
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(WorkspaceConsistencyError::InvalidPath(path.to_path_buf()));
    }
    Ok(relative)
}

fn fingerprint(bytes: &[u8]) -> String {
    let mut hash = FNV_128_OFFSET;
    for byte in bytes {
        hash ^= u128::from(*byte);
        hash = hash.wrapping_mul(FNV_128_PRIME);
    }
    format!("fnv1a128:{hash:032x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{ExecutionId, WorkspaceId};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "phenix-workspace-consistency-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn descriptor(&self, scratch_paths: BTreeSet<PathBuf>) -> WorkspaceDescriptor {
            WorkspaceDescriptor {
                id: WorkspaceId::parse("workspace:test").unwrap(),
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
    fn validation_is_scoped_to_observed_files() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("a.rs"), "a1").unwrap();
        fs::write(fixture.root.join("b.rs"), "b1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let mut reads = ExecutionReadSet::new(ExecutionId::parse("execution-1").unwrap());
        reads.observe(guard.observe("a.rs").unwrap().unwrap());
        reads.observe(guard.observe("b.rs").unwrap().unwrap());

        fs::write(fixture.root.join("a.rs"), "a2").unwrap();
        let conflicts = guard.validate(&reads).unwrap();

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].path, PathBuf::from("a.rs"));
    }

    #[test]
    fn scratch_paths_are_not_source_observations() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("target")).unwrap();
        fs::write(fixture.root.join("target/cache"), "cache").unwrap();
        let guard = WorkspaceConsistency::new(
            &fixture.descriptor(BTreeSet::from([PathBuf::from("target")])),
        )
        .unwrap();

        assert_eq!(guard.observe("target/cache").unwrap(), None);
        assert!(matches!(
            guard.write_source_if_version("target/cache", &FileVersion::Absent, b"new"),
            Err(WorkspaceConsistencyError::ScratchPath(path)) if path == PathBuf::from("target/cache")
        ));
    }

    #[test]
    fn stale_native_write_is_rejected_without_overwriting_external_change() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "v1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.observe("source.rs").unwrap().unwrap();
        fs::write(&path, "external-v2").unwrap();

        let error = guard
            .write_source_if_version("source.rs", &observed.version, b"agent-v3")
            .unwrap_err();

        assert!(matches!(error, WorkspaceConsistencyError::Conflict(_)));
        assert_eq!(fs::read_to_string(path).unwrap(), "external-v2");
    }

    #[test]
    fn matching_native_write_returns_the_new_observation() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "v1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.observe("source.rs").unwrap().unwrap();

        let written = guard
            .write_source_if_version("source.rs", &observed.version, b"v2")
            .unwrap();

        assert_ne!(written.version, observed.version);
        assert_eq!(fs::read_to_string(path).unwrap(), "v2");
    }

    #[test]
    fn parent_traversal_is_rejected() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        assert!(matches!(
            guard.observe("../outside"),
            Err(WorkspaceConsistencyError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_parent_cannot_escape_workspace() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let outside = fixture.root.parent().unwrap().join(format!(
            "phenix-workspace-outside-{}",
            std::process::id()
        ));
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret"), "outside").unwrap();
        symlink(&outside, fixture.root.join("escape")).unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        assert!(matches!(
            guard.observe("escape/secret"),
            Err(WorkspaceConsistencyError::EscapesWorkspace(_))
        ));
        let _ = fs::remove_dir_all(outside);
    }
}
