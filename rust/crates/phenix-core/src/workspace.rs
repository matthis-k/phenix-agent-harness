use crate::{CallableId, CapabilitySet, ExecutionId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

pub const CAPABILITY_FILESYSTEM_READ: &str = "filesystem.read";
pub const CAPABILITY_FILESYSTEM_WRITE: &str = "filesystem.write";

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilesystemAuthority {
    ReadOnly,
    Write,
}

impl FilesystemAuthority {
    #[must_use]
    pub fn permits_capabilities(self, capabilities: &CapabilitySet) -> bool {
        !capabilities.0.contains(CAPABILITY_FILESYSTEM_WRITE)
            || self == FilesystemAuthority::Write
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkAuthority {
    None,
    Outbound,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepositoryAuthority {
    Read,
    Write,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExecutionAuthority {
    pub filesystem: FilesystemAuthority,
    pub network: NetworkAuthority,
    pub repository: RepositoryAuthority,
    #[serde(default)]
    pub ipc: BTreeSet<String>,
    #[serde(default)]
    pub secrets: BTreeSet<String>,
    #[serde(default)]
    pub callables: BTreeSet<CallableId>,
}

impl Default for ExecutionAuthority {
    fn default() -> Self {
        Self::read_only()
    }
}

impl ExecutionAuthority {
    #[must_use]
    pub fn read_only() -> Self {
        Self {
            filesystem: FilesystemAuthority::ReadOnly,
            network: NetworkAuthority::None,
            repository: RepositoryAuthority::Read,
            ipc: BTreeSet::new(),
            secrets: BTreeSet::new(),
            callables: BTreeSet::new(),
        }
    }

    #[must_use]
    pub fn attenuate(&self, requested: &Self) -> Self {
        Self {
            filesystem: self.filesystem.min(requested.filesystem),
            network: self.network.min(requested.network),
            repository: self.repository.min(requested.repository),
            ipc: intersection(&self.ipc, &requested.ipc),
            secrets: intersection(&self.secrets, &requested.secrets),
            callables: intersection(&self.callables, &requested.callables),
        }
    }

    #[must_use]
    pub fn permits(&self, child: &Self) -> bool {
        self.attenuate(child) == *child
    }
}

fn intersection<T>(left: &BTreeSet<T>, right: &BTreeSet<T>) -> BTreeSet<T>
where
    T: Clone + Ord,
{
    left.intersection(right).cloned().collect()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceLeaseMode {
    Read,
    Write,
}

impl From<FilesystemAuthority> for WorkspaceLeaseMode {
    fn from(authority: FilesystemAuthority) -> Self {
        match authority {
            FilesystemAuthority::ReadOnly => Self::Read,
            FilesystemAuthority::Write => Self::Write,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceLeaseRequest {
    pub workspace_id: WorkspaceId,
    pub execution_id: ExecutionId,
    pub mode: WorkspaceLeaseMode,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceDescriptor {
    pub id: WorkspaceId,
    pub root: PathBuf,
    #[serde(default)]
    pub scratch_paths: BTreeSet<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Regular,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum FileVersion {
    Absent,
    Present {
        content_hash: String,
        kind: FileKind,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FileObservation {
    pub path: PathBuf,
    pub version: FileVersion,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExecutionReadSet {
    pub execution_id: ExecutionId,
    #[serde(default)]
    pub files: BTreeMap<PathBuf, FileVersion>,
}

impl ExecutionReadSet {
    #[must_use]
    pub fn new(execution_id: ExecutionId) -> Self {
        Self {
            execution_id,
            files: BTreeMap::new(),
        }
    }

    pub fn observe(&mut self, observation: FileObservation) {
        self.files.insert(observation.path, observation.version);
    }

    #[must_use]
    pub fn conflicts_with(
        &self,
        current: &BTreeMap<PathBuf, FileVersion>,
    ) -> Vec<WorkspaceConflict> {
        self.files
            .iter()
            .filter_map(|(path, expected)| {
                let actual = current.get(path).unwrap_or(&FileVersion::Absent);
                (actual != expected).then(|| WorkspaceConflict {
                    path: path.clone(),
                    expected: expected.clone(),
                    actual: actual.clone(),
                })
            })
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceConflict {
    pub path: PathBuf,
    pub expected: FileVersion,
    pub actual: FileVersion,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn callable(id: &str) -> CallableId {
        CallableId::parse(id).unwrap()
    }

    #[test]
    fn authority_defaults_to_read_only() {
        assert_eq!(
            ExecutionAuthority::default(),
            ExecutionAuthority::read_only()
        );
    }

    #[test]
    fn child_authority_can_only_shrink() {
        let parent = ExecutionAuthority {
            filesystem: FilesystemAuthority::ReadOnly,
            network: NetworkAuthority::Outbound,
            repository: RepositoryAuthority::Read,
            ipc: BTreeSet::from(["dbus".to_owned()]),
            secrets: BTreeSet::from(["github".to_owned()]),
            callables: BTreeSet::from([callable("agent.scout"), callable("tool.read")]),
        };
        let requested = ExecutionAuthority {
            filesystem: FilesystemAuthority::Write,
            network: NetworkAuthority::Outbound,
            repository: RepositoryAuthority::Write,
            ipc: BTreeSet::from(["dbus".to_owned(), "docker".to_owned()]),
            secrets: BTreeSet::from(["github".to_owned(), "other".to_owned()]),
            callables: BTreeSet::from([callable("agent.implement"), callable("tool.read")]),
        };

        let child = parent.attenuate(&requested);
        assert_eq!(child.filesystem, FilesystemAuthority::ReadOnly);
        assert_eq!(child.network, NetworkAuthority::Outbound);
        assert_eq!(child.repository, RepositoryAuthority::Read);
        assert_eq!(child.ipc, BTreeSet::from(["dbus".to_owned()]));
        assert_eq!(child.secrets, BTreeSet::from(["github".to_owned()]));
        assert_eq!(child.callables, BTreeSet::from([callable("tool.read")]));
        assert!(parent.permits(&child));
        assert!(!parent.permits(&requested));
    }

    #[test]
    fn filesystem_authority_selects_workspace_lease_mode() {
        assert_eq!(
            WorkspaceLeaseMode::from(FilesystemAuthority::ReadOnly),
            WorkspaceLeaseMode::Read
        );
        assert_eq!(
            WorkspaceLeaseMode::from(FilesystemAuthority::Write),
            WorkspaceLeaseMode::Write
        );
    }

    #[test]
    fn filesystem_authority_filters_write_capabilities() {
        let read = CapabilitySet(BTreeSet::from([CAPABILITY_FILESYSTEM_READ.to_owned()]));
        let write = CapabilitySet(BTreeSet::from([CAPABILITY_FILESYSTEM_WRITE.to_owned()]));

        assert!(FilesystemAuthority::ReadOnly.permits_capabilities(&read));
        assert!(!FilesystemAuthority::ReadOnly.permits_capabilities(&write));
        assert!(FilesystemAuthority::Write.permits_capabilities(&write));
    }

    #[test]
    fn invalidation_is_file_scoped() {
        let mut reads = ExecutionReadSet::new(ExecutionId::parse("execution-1").unwrap());
        reads.observe(FileObservation {
            path: PathBuf::from("src/a.rs"),
            version: FileVersion::Present {
                content_hash: "a1".to_owned(),
                kind: FileKind::Regular,
            },
        });
        reads.observe(FileObservation {
            path: PathBuf::from("src/b.rs"),
            version: FileVersion::Present {
                content_hash: "b1".to_owned(),
                kind: FileKind::Regular,
            },
        });
        let current = BTreeMap::from([
            (
                PathBuf::from("src/a.rs"),
                FileVersion::Present {
                    content_hash: "a2".to_owned(),
                    kind: FileKind::Regular,
                },
            ),
            (
                PathBuf::from("src/b.rs"),
                FileVersion::Present {
                    content_hash: "b1".to_owned(),
                    kind: FileKind::Regular,
                },
            ),
        ]);

        let conflicts = reads.conflicts_with(&current);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].path, PathBuf::from("src/a.rs"));
    }
}
