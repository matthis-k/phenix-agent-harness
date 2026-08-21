use phenix_core::{FileKind, FileObservation, FileVersion, WorkspaceConflict, WorkspaceDescriptor};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::path::{Component, Path, PathBuf};

const FNV_128_OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
const FNV_128_PRIME: u128 = 0x0000000001000000000000000000013b;
const DIRECTORY_FINGERPRINT_SOURCE: &[u8] = b"directory";

#[derive(Clone, Debug)]
pub struct WorkspaceRead {
    pub path: PathBuf,
    pub content: String,
    pub observation: Option<FileObservation>,
}

#[derive(Clone, Debug)]
pub struct WorkspaceConsistency {
    root: PathBuf,
    scratch_paths: BTreeSet<PathBuf>,
}

impl WorkspaceConsistency {
    pub fn new(descriptor: &WorkspaceDescriptor) -> Result<Self, WorkspaceConsistencyError> {
        let root =
            fs::canonicalize(&descriptor.root).map_err(|source| WorkspaceConsistencyError::Io {
                path: descriptor.root.clone(),
                source,
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

    pub fn checkpoint_baseline(
        &self,
    ) -> Result<BTreeMap<PathBuf, FileVersion>, WorkspaceConsistencyError> {
        let mut files = BTreeMap::new();
        self.collect_real_versions(&self.root, Path::new(""), &mut files)?;
        Ok(files)
    }

    pub(super) fn validate_checkpoint_baseline(
        &self,
        expected: &BTreeMap<PathBuf, FileVersion>,
    ) -> Result<(), WorkspaceConsistencyError> {
        let actual = self.checkpoint_baseline()?;
        compare_manifests(expected, &actual)
    }

    pub(super) fn snapshot_manifest(
        &self,
        snapshot_root: &Path,
    ) -> Result<BTreeMap<PathBuf, FileVersion>, WorkspaceConsistencyError> {
        let snapshot_root = fs::canonicalize(snapshot_root).map_err(|source| {
            WorkspaceConsistencyError::Io {
                path: snapshot_root.to_path_buf(),
                source,
            }
        })?;
        let mut files = BTreeMap::new();
        self.collect_snapshot_versions(&snapshot_root, Path::new(""), &mut files)?;
        Ok(files)
    }

    pub(super) fn prepare_scratch_mounts(
        &self,
    ) -> Result<Vec<(PathBuf, PathBuf)>, WorkspaceConsistencyError> {
        let mut mounts = Vec::new();
        for scratch in &self.scratch_paths {
            let relative = normalize_relative(scratch)?;
            if mounts
                .iter()
                .any(|(parent, _): &(PathBuf, PathBuf)| relative.starts_with(parent))
            {
                continue;
            }

            let target = self.root.join(&relative);
            self.ensure_ancestor_inside(&target)?;
            match fs::symlink_metadata(&target) {
                Ok(metadata) => {
                    let kind = file_kind(&metadata);
                    if matches!(kind, FileKind::Symlink | FileKind::Other) {
                        return Err(WorkspaceConsistencyError::UnsupportedScratchRoot {
                            path: relative,
                            kind,
                        });
                    }
                    if metadata.is_dir() {
                        let canonical = fs::canonicalize(&target).map_err(|source| {
                            WorkspaceConsistencyError::Io {
                                path: target.clone(),
                                source,
                            }
                        })?;
                        self.ensure_canonical_inside(&canonical)?;
                    }
                }
                Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir_all(&target).map_err(|source| WorkspaceConsistencyError::Io {
                        path: target.clone(),
                        source,
                    })?;
                    let canonical = fs::canonicalize(&target).map_err(|source| {
                        WorkspaceConsistencyError::Io {
                            path: target.clone(),
                            source,
                        }
                    })?;
                    self.ensure_canonical_inside(&canonical)?;
                }
                Err(source) => {
                    return Err(WorkspaceConsistencyError::Io {
                        path: target,
                        source,
                    });
                }
            }
            mounts.push((relative, target));
        }
        Ok(mounts)
    }

    pub fn read_utf8(
        &self,
        path: impl AsRef<Path>,
    ) -> Result<WorkspaceRead, WorkspaceConsistencyError> {
        let relative = normalize_relative(path.as_ref())?;
        let target = self.root.join(&relative);
        self.ensure_ancestor_inside(&target)?;
        let metadata =
            fs::symlink_metadata(&target).map_err(|source| WorkspaceConsistencyError::Io {
                path: target.clone(),
                source,
            })?;
        let scratch = self.is_scratch(&relative);
        if metadata.file_type().is_symlink() {
            let canonical =
                fs::canonicalize(&target).map_err(|source| WorkspaceConsistencyError::Io {
                    path: target.clone(),
                    source,
                })?;
            self.ensure_canonical_inside(&canonical)?;
            if !scratch {
                return Err(WorkspaceConsistencyError::UnsupportedReadTarget {
                    path: relative,
                    kind: FileKind::Symlink,
                });
            }
        } else if !metadata.is_file() {
            return Err(WorkspaceConsistencyError::UnsupportedReadTarget {
                path: relative,
                kind: file_kind(&metadata),
            });
        }

        let bytes = fs::read(&target).map_err(|source| WorkspaceConsistencyError::Io {
            path: target,
            source,
        })?;
        let content =
            String::from_utf8(bytes.clone()).map_err(|_| WorkspaceConsistencyError::NotUtf8 {
                path: relative.clone(),
            })?;
        let observation = (!scratch).then(|| FileObservation {
            path: relative.clone(),
            version: FileVersion::Present {
                content_hash: fingerprint(&bytes),
                kind: FileKind::Regular,
            },
        });
        Ok(WorkspaceRead {
            path: relative,
            content,
            observation,
        })
    }

    pub fn write_utf8(
        &self,
        path: impl AsRef<Path>,
        expected: Option<&FileVersion>,
        content: &str,
    ) -> Result<Option<FileObservation>, WorkspaceConsistencyError> {
        let relative = normalize_relative(path.as_ref())?;
        let target = self.root.join(&relative);
        self.ensure_ancestor_inside(&target)?;

        if self.is_scratch(&relative) {
            self.create_parent_directories(&target)?;
            fs::write(&target, content.as_bytes()).map_err(|source| {
                WorkspaceConsistencyError::Io {
                    path: target,
                    source,
                }
            })?;
            return Ok(None);
        }

        let expected = expected
            .ok_or_else(|| WorkspaceConsistencyError::MissingExpectedVersion(relative.clone()))?;
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

        self.create_parent_directories(&target)?;
        fs::write(&target, content.as_bytes()).map_err(|source| WorkspaceConsistencyError::Io {
            path: target,
            source,
        })?;
        let observation = FileObservation {
            path: relative,
            version: FileVersion::Present {
                content_hash: fingerprint(content.as_bytes()),
                kind: FileKind::Regular,
            },
        };
        Ok(Some(observation))
    }

    fn collect_real_versions(
        &self,
        directory: &Path,
        relative_directory: &Path,
        files: &mut BTreeMap<PathBuf, FileVersion>,
    ) -> Result<(), WorkspaceConsistencyError> {
        for entry in sorted_entries(directory)? {
            let relative = relative_directory.join(entry.file_name());
            if is_repository_metadata(&relative) || self.is_scratch(&relative) {
                continue;
            }
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|source| WorkspaceConsistencyError::Io {
                    path: path.clone(),
                    source,
                })?;
            if metadata.is_dir() {
                files.insert(relative.clone(), directory_version());
                let canonical =
                    fs::canonicalize(&path).map_err(|source| WorkspaceConsistencyError::Io {
                        path: path.clone(),
                        source,
                    })?;
                self.ensure_canonical_inside(&canonical)?;
                self.collect_real_versions(&canonical, &relative, files)?;
            } else {
                files.insert(relative.clone(), self.version_at(&relative)?);
            }
        }
        Ok(())
    }

    fn collect_snapshot_versions(
        &self,
        snapshot_directory: &Path,
        relative_directory: &Path,
        files: &mut BTreeMap<PathBuf, FileVersion>,
    ) -> Result<(), WorkspaceConsistencyError> {
        for entry in sorted_entries(snapshot_directory)? {
            let relative = relative_directory.join(entry.file_name());
            if is_repository_metadata(&relative) || self.is_scratch(&relative) {
                continue;
            }
            let path = entry.path();
            let metadata =
                fs::symlink_metadata(&path).map_err(|source| WorkspaceConsistencyError::Io {
                    path: path.clone(),
                    source,
                })?;
            let kind = file_kind(&metadata);
            let version = match kind {
                FileKind::Regular => FileVersion::Present {
                    content_hash: fingerprint(&fs::read(&path).map_err(|source| {
                        WorkspaceConsistencyError::Io {
                            path: path.clone(),
                            source,
                        }
                    })?),
                    kind,
                },
                FileKind::Directory => directory_version(),
                FileKind::Symlink => {
                    let target = fs::read_link(&path).map_err(|source| {
                        WorkspaceConsistencyError::Io {
                            path: path.clone(),
                            source,
                        }
                    })?;
                    self.ensure_snapshot_link_inside(&relative, &target)?;
                    FileVersion::Present {
                        content_hash: fingerprint(target.to_string_lossy().as_bytes()),
                        kind,
                    }
                }
                FileKind::Other => FileVersion::Present {
                    content_hash: fingerprint(metadata.len().to_string().as_bytes()),
                    kind,
                },
            };
            files.insert(relative.clone(), version);
            if metadata.is_dir() {
                self.collect_snapshot_versions(&path, &relative, files)?;
            }
        }
        Ok(())
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
                return Ok(FileVersion::Absent);
            }
            Err(source) => {
                return Err(WorkspaceConsistencyError::Io {
                    path: target,
                    source,
                });
            }
        };
        let kind = file_kind(&metadata);
        let hash = match kind {
            FileKind::Regular => {
                let canonical =
                    fs::canonicalize(&target).map_err(|source| WorkspaceConsistencyError::Io {
                        path: target.clone(),
                        source,
                    })?;
                self.ensure_canonical_inside(&canonical)?;
                fingerprint(&fs::read(&canonical).map_err(|source| {
                    WorkspaceConsistencyError::Io {
                        path: canonical,
                        source,
                    }
                })?)
            }
            FileKind::Directory => fingerprint(DIRECTORY_FINGERPRINT_SOURCE),
            FileKind::Symlink => {
                let link =
                    fs::read_link(&target).map_err(|source| WorkspaceConsistencyError::Io {
                        path: target.clone(),
                        source,
                    })?;
                let canonical =
                    fs::canonicalize(&target).map_err(|source| WorkspaceConsistencyError::Io {
                        path: target.clone(),
                        source,
                    })?;
                self.ensure_canonical_inside(&canonical)?;
                fingerprint(link.to_string_lossy().as_bytes())
            }
            FileKind::Other => fingerprint(metadata.len().to_string().as_bytes()),
        };
        Ok(FileVersion::Present {
            content_hash: hash,
            kind,
        })
    }

    fn create_parent_directories(&self, target: &Path) -> Result<(), WorkspaceConsistencyError> {
        self.ensure_ancestor_inside(target)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|source| WorkspaceConsistencyError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
            let canonical =
                fs::canonicalize(parent).map_err(|source| WorkspaceConsistencyError::Io {
                    path: parent.to_path_buf(),
                    source,
                })?;
            self.ensure_canonical_inside(&canonical)?;
        }
        Ok(())
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
                    });
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

    fn ensure_snapshot_link_inside(
        &self,
        relative: &Path,
        link: &Path,
    ) -> Result<(), WorkspaceConsistencyError> {
        let candidate = if link.is_absolute() {
            link.to_path_buf()
        } else {
            self.root
                .join(relative.parent().unwrap_or_else(|| Path::new("")))
                .join(link)
        };
        let normalized = lexical_normalize(&candidate).ok_or_else(|| {
            WorkspaceConsistencyError::EscapesWorkspace(self.root.join(relative))
        })?;
        if normalized == self.root || normalized.starts_with(&self.root) {
            Ok(())
        } else {
            Err(WorkspaceConsistencyError::EscapesWorkspace(normalized))
        }
    }
}

#[derive(Debug)]
pub enum WorkspaceConsistencyError {
    InvalidPath(PathBuf),
    EscapesWorkspace(PathBuf),
    MissingExpectedVersion(PathBuf),
    UnsupportedReadTarget {
        path: PathBuf,
        kind: FileKind,
    },
    UnsupportedWriteTarget {
        path: PathBuf,
        kind: FileKind,
    },
    UnsupportedScratchRoot {
        path: PathBuf,
        kind: FileKind,
    },
    NotUtf8 {
        path: PathBuf,
    },
    Conflict(WorkspaceConflict),
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
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
            Self::MissingExpectedVersion(path) => write!(
                f,
                "source write requires expected_version from a prior read, or state=absent for a new file: {}",
                path.display()
            ),
            Self::UnsupportedReadTarget { path, kind } => write!(
                f,
                "versioned source read requires a regular file, found {kind:?}: {}",
                path.display()
            ),
            Self::UnsupportedWriteTarget { path, kind } => write!(
                f,
                "versioned source write requires a regular file or absent path, found {kind:?}: {}",
                path.display()
            ),
            Self::UnsupportedScratchRoot { path, kind } => write!(
                f,
                "workspace scratch root must be a regular file or directory, found {kind:?}: {}",
                path.display()
            ),
            Self::NotUtf8 { path } => {
                write!(f, "workspace text file is not valid UTF-8: {}", path.display())
            }
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

fn compare_manifests(
    expected: &BTreeMap<PathBuf, FileVersion>,
    actual: &BTreeMap<PathBuf, FileVersion>,
) -> Result<(), WorkspaceConsistencyError> {
    let paths = expected
        .keys()
        .chain(actual.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for path in paths {
        let expected_version = expected.get(&path).cloned().unwrap_or(FileVersion::Absent);
        let actual_version = actual.get(&path).cloned().unwrap_or(FileVersion::Absent);
        if expected_version != actual_version {
            return Err(WorkspaceConsistencyError::Conflict(WorkspaceConflict {
                path,
                expected: expected_version,
                actual: actual_version,
            }));
        }
    }
    Ok(())
}

fn sorted_entries(directory: &Path) -> Result<Vec<fs::DirEntry>, WorkspaceConsistencyError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|source| WorkspaceConsistencyError::Io {
            path: directory.to_path_buf(),
            source,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source| WorkspaceConsistencyError::Io {
            path: directory.to_path_buf(),
            source,
        })?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn normalize_relative(path: &Path) -> Result<PathBuf, WorkspaceConsistencyError> {
    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(WorkspaceConsistencyError::InvalidPath(path.to_path_buf()));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        return Err(WorkspaceConsistencyError::InvalidPath(path.to_path_buf()));
    }
    Ok(relative)
}

fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
        }
    }
    Some(normalized)
}

fn is_repository_metadata(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::Normal(part) if part == ".git"))
}

fn file_kind(metadata: &fs::Metadata) -> FileKind {
    let file_type = metadata.file_type();
    if file_type.is_file() {
        FileKind::Regular
    } else if file_type.is_dir() {
        FileKind::Directory
    } else if file_type.is_symlink() {
        FileKind::Symlink
    } else {
        FileKind::Other
    }
}

fn directory_version() -> FileVersion {
    FileVersion::Present {
        content_hash: fingerprint(DIRECTORY_FINGERPRINT_SOURCE),
        kind: FileKind::Directory,
    }
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
    use phenix_core::WorkspaceId;
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
    fn read_version_matches_the_exact_returned_content() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("source.rs"), "v1\n").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        let read = guard.read_utf8("source.rs").unwrap();
        let observed = read.observation.unwrap();

        assert_eq!(read.content, "v1\n");
        assert_eq!(
            observed.version,
            FileVersion::Present {
                content_hash: fingerprint(b"v1\n"),
                kind: FileKind::Regular,
            }
        );
    }

    #[test]
    fn checkpoint_baseline_tracks_tree_and_excludes_scratch_and_git_metadata() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("src/nested")).unwrap();
        fs::create_dir_all(fixture.root.join("target")).unwrap();
        fs::create_dir_all(fixture.root.join(".git")).unwrap();
        fs::write(fixture.root.join("src/lib.rs"), "source").unwrap();
        fs::write(fixture.root.join("target/cache"), "scratch").unwrap();
        fs::write(fixture.root.join(".git/index"), "metadata").unwrap();
        let guard = WorkspaceConsistency::new(
            &fixture.descriptor(BTreeSet::from([PathBuf::from("target")])),
        )
        .unwrap();

        let baseline = guard.checkpoint_baseline().unwrap();

        assert_eq!(baseline.get(Path::new("src")), Some(&directory_version()));
        assert_eq!(baseline.get(Path::new("src/nested")), Some(&directory_version()));
        assert_eq!(
            baseline.get(Path::new("src/lib.rs")),
            Some(&FileVersion::Present {
                content_hash: fingerprint(b"source"),
                kind: FileKind::Regular,
            })
        );
        assert!(!baseline.contains_key(Path::new("target")));
        assert!(!baseline.contains_key(Path::new("target/cache")));
        assert!(!baseline.contains_key(Path::new(".git")));
        assert!(!baseline.contains_key(Path::new(".git/index")));
    }

    #[test]
    fn full_manifest_validation_detects_new_files_and_directories() {
        let fixture = Fixture::new();
        fs::write(fixture.root.join("source.rs"), "v1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let baseline = guard.checkpoint_baseline().unwrap();

        fs::create_dir(fixture.root.join("external-dir")).unwrap();
        let error = guard.validate_checkpoint_baseline(&baseline).unwrap_err();
        assert!(matches!(error, WorkspaceConsistencyError::Conflict(_)));

        fs::remove_dir(fixture.root.join("external-dir")).unwrap();
        fs::write(fixture.root.join("external.rs"), "external").unwrap();
        let error = guard.validate_checkpoint_baseline(&baseline).unwrap_err();
        assert!(matches!(error, WorkspaceConsistencyError::Conflict(_)));
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
    fn scratch_paths_are_read_and_written_without_source_versions() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.root.join("target")).unwrap();
        fs::write(fixture.root.join("target/cache"), "cache").unwrap();
        let guard = WorkspaceConsistency::new(
            &fixture.descriptor(BTreeSet::from([PathBuf::from("target")])),
        )
        .unwrap();

        assert_eq!(guard.read_utf8("target/cache").unwrap().observation, None);
        assert_eq!(guard.write_utf8("target/cache", None, "new").unwrap(), None);
        assert_eq!(
            fs::read_to_string(fixture.root.join("target/cache")).unwrap(),
            "new"
        );
    }

    #[test]
    fn scratch_mounts_create_missing_roots_and_collapse_nested_roots() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::from([
            PathBuf::from("target"),
            PathBuf::from("target/nested"),
        ])))
        .unwrap();

        let mounts = guard.prepare_scratch_mounts().unwrap();

        assert_eq!(mounts.len(), 1);
        assert_eq!(mounts[0].0, Path::new("target"));
        assert!(mounts[0].1.is_dir());
    }

    #[test]
    fn source_write_requires_an_expected_version() {
        let fixture = Fixture::new();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        assert!(matches!(
            guard.write_utf8("new.rs", None, "new"),
            Err(WorkspaceConsistencyError::MissingExpectedVersion(path))
                if path == Path::new("new.rs")
        ));
    }

    #[test]
    fn stale_native_write_is_rejected_without_overwriting_external_change() {
        let fixture = Fixture::new();
        let path = fixture.root.join("source.rs");
        fs::write(&path, "v1").unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();
        let observed = guard.read_utf8("source.rs").unwrap().observation.unwrap();
        fs::write(&path, "external-v2").unwrap();

        let error = guard
            .write_utf8("source.rs", Some(&observed.version), "agent-v3")
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
        fs::write(outside.join("secret"), "outside").unwrap();
        symlink(&outside, fixture.root.join("target")).unwrap();
        let guard = WorkspaceConsistency::new(
            &fixture.descriptor(BTreeSet::from([PathBuf::from("target")])),
        )
        .unwrap();

        assert!(matches!(
            guard.read_utf8("target/secret"),
            Err(WorkspaceConsistencyError::EscapesWorkspace(_))
        ));
        assert!(matches!(
            guard.prepare_scratch_mounts(),
            Err(WorkspaceConsistencyError::UnsupportedScratchRoot { .. })
        ));
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_manifest_rejects_symlinks_that_would_escape_after_apply() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let snapshot = fixture.root.parent().unwrap().join(format!(
            "phenix-snapshot-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&snapshot).unwrap();
        symlink("../../outside", snapshot.join("escape")).unwrap();
        let guard = WorkspaceConsistency::new(&fixture.descriptor(BTreeSet::new())).unwrap();

        assert!(matches!(
            guard.snapshot_manifest(&snapshot),
            Err(WorkspaceConsistencyError::EscapesWorkspace(_))
        ));
        let _ = fs::remove_dir_all(snapshot);
    }
}
