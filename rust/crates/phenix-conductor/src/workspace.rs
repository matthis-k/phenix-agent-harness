use phenix_core::{WorkspaceDescriptor, WorkspaceId};
use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::path::{Component, Path, PathBuf};

const SCRATCH_DIRECTIVE: &str = "# phenix:scratch";

#[derive(Clone, Debug)]
pub struct Workspace {
    descriptor: WorkspaceDescriptor,
}

impl Workspace {
    pub fn discover(root: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
        let root = fs::canonicalize(root.as_ref()).map_err(|source| WorkspaceError::Resolve {
            path: root.as_ref().to_path_buf(),
            source,
        })?;
        let id = WorkspaceId::parse(format!("workspace:{}", root.display()))
            .expect("canonical workspace path is non-empty");
        let scratch_paths = discover_scratch_paths(&root)?;
        Ok(Self {
            descriptor: WorkspaceDescriptor {
                id,
                root,
                scratch_paths,
            },
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.descriptor.root
    }

    #[must_use]
    pub fn id(&self) -> &WorkspaceId {
        &self.descriptor.id
    }
}

#[derive(Debug)]
pub enum WorkspaceError {
    Resolve {
        path: PathBuf,
        source: std::io::Error,
    },
    ReadGitignore {
        path: PathBuf,
        source: std::io::Error,
    },
    InvalidScratchPattern {
        path: PathBuf,
        line: usize,
        pattern: String,
        reason: &'static str,
    },
    DanglingScratchDirective {
        path: PathBuf,
        line: usize,
    },
}

impl Display for WorkspaceError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Resolve { path, source } => {
                write!(
                    f,
                    "failed to resolve workspace {}: {source}",
                    path.display()
                )
            }
            Self::ReadGitignore { path, source } => {
                write!(f, "failed to read {}: {source}", path.display())
            }
            Self::InvalidScratchPattern {
                path,
                line,
                pattern,
                reason,
            } => write!(
                f,
                "invalid Phenix scratch pattern {pattern:?} at {}:{line}: {reason}",
                path.display()
            ),
            Self::DanglingScratchDirective { path, line } => write!(
                f,
                "Phenix scratch directive at {}:{line} has no following ignore pattern",
                path.display()
            ),
        }
    }
}

impl Error for WorkspaceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Resolve { source, .. } | Self::ReadGitignore { source, .. } => Some(source),
            Self::InvalidScratchPattern { .. } | Self::DanglingScratchDirective { .. } => None,
        }
    }
}

fn discover_scratch_paths(root: &Path) -> Result<BTreeSet<PathBuf>, WorkspaceError> {
    let path = root.join(".gitignore");
    let source = match fs::read_to_string(&path) {
        Ok(source) => source,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(source) => return Err(WorkspaceError::ReadGitignore { path, source }),
    };
    parse_scratch_paths(&path, &source)
}

fn parse_scratch_paths(path: &Path, source: &str) -> Result<BTreeSet<PathBuf>, WorkspaceError> {
    let mut scratch = BTreeSet::new();
    let mut directive_line = None;

    for (index, raw) in source.lines().enumerate() {
        let line_number = index + 1;
        let line = raw.trim();
        if line == SCRATCH_DIRECTIVE {
            directive_line = Some(line_number);
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if directive_line.take().is_none() {
            continue;
        }
        let relative = normalize_scratch_pattern(path, line_number, line)?;
        if relative.as_os_str().is_empty() {
            return Err(WorkspaceError::InvalidScratchPattern {
                path: path.to_path_buf(),
                line: line_number,
                pattern: line.to_owned(),
                reason: "scratch must name a path below the workspace root",
            });
        }
        scratch.insert(relative);
    }

    if let Some(line) = directive_line {
        return Err(WorkspaceError::DanglingScratchDirective {
            path: path.to_path_buf(),
            line,
        });
    }
    Ok(scratch)
}

fn normalize_scratch_pattern(
    gitignore: &Path,
    line: usize,
    raw: &str,
) -> Result<PathBuf, WorkspaceError> {
    if raw.starts_with('!') {
        return invalid_pattern(
            gitignore,
            line,
            raw,
            "negated patterns are not scratch roots",
        );
    }
    if raw.chars().any(|ch| matches!(ch, '*' | '?' | '[' | ']')) {
        return invalid_pattern(
            gitignore,
            line,
            raw,
            "scratch roots must be literal paths; glob patterns are not supported",
        );
    }

    let normalized = raw.trim_start_matches('/').trim_end_matches('/');
    let mut relative = PathBuf::new();
    for component in Path::new(normalized).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return invalid_pattern(
                    gitignore,
                    line,
                    raw,
                    "scratch path must stay inside the workspace",
                );
            }
        }
    }
    Ok(relative)
}

fn invalid_pattern<T>(
    path: &Path,
    line: usize,
    pattern: &str,
    reason: &'static str,
) -> Result<T, WorkspaceError> {
    Err(WorkspaceError::InvalidScratchPattern {
        path: path.to_path_buf(),
        line,
        pattern: pattern.to_owned(),
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_namespaced_directives_make_ignored_paths_scratch() {
        let parsed = parse_scratch_paths(
            Path::new("/repo/.gitignore"),
            r#"
.env
/ignored-but-protected/
# phenix:scratch
/target/
# ordinary comment
# phenix:scratch
/.cache/
"#,
        )
        .unwrap();

        assert_eq!(
            parsed,
            BTreeSet::from([PathBuf::from(".cache"), PathBuf::from("target")])
        );
        assert!(!parsed.contains(Path::new(".env")));
        assert!(!parsed.contains(Path::new("ignored-but-protected")));
    }

    #[test]
    fn scratch_directive_rejects_ambiguous_gitignore_patterns() {
        let error = parse_scratch_paths(
            Path::new("/repo/.gitignore"),
            "# phenix:scratch\n/target-*/\n",
        )
        .unwrap_err();
        assert!(matches!(
            error,
            WorkspaceError::InvalidScratchPattern { .. }
        ));
    }

    #[test]
    fn scratch_directive_requires_a_following_pattern() {
        let error = parse_scratch_paths(
            Path::new("/repo/.gitignore"),
            "# phenix:scratch\n# explanation only\n",
        )
        .unwrap_err();
        assert!(matches!(
            error,
            WorkspaceError::DanglingScratchDirective { line: 1, .. }
        ));
    }
}
