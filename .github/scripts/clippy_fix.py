from pathlib import Path

path = Path("rust/crates/phenix-acp/src/source.rs")
text = path.read_text()
text = text.replace(
    '.next_nonblank()\n            .ok_or_else(|| DefinitionSourceError::UnexpectedEnd {\n                expected: "a phenix-workflow or phenix-router fenced declaration",\n            })?;',
    '.next_nonblank()\n            .ok_or(DefinitionSourceError::UnexpectedEnd {\n                expected: "a phenix-workflow or phenix-router fenced declaration",\n            })?;',
)
text = text.replace(
    '.next_nonblank()\n            .ok_or_else(|| DefinitionSourceError::UnexpectedEnd {\n                expected: match kind {\n                    DefinitionSourceKind::Workflow => "the ## Steps section",\n                    DefinitionSourceKind::Router => "the ## Routes section",\n                },\n            })?;',
    '.next_nonblank()\n            .ok_or(DefinitionSourceError::UnexpectedEnd {\n                expected: match kind {\n                    DefinitionSourceKind::Workflow => "the ## Steps section",\n                    DefinitionSourceKind::Router => "the ## Routes section",\n                },\n            })?;',
)
text = text.replace(
    '.next_nonblank()\n            .ok_or_else(|| DefinitionSourceError::UnexpectedEnd {\n                expected: "a Markdown table header",\n            })?;',
    '.next_nonblank()\n            .ok_or(DefinitionSourceError::UnexpectedEnd {\n                expected: "a Markdown table header",\n            })?;',
)
text = text.replace(
    '.next_nonblank()\n            .ok_or_else(|| DefinitionSourceError::UnexpectedEnd {\n                expected: "a Markdown table separator",\n            })?;',
    '.next_nonblank()\n            .ok_or(DefinitionSourceError::UnexpectedEnd {\n                expected: "a Markdown table separator",\n            })?;',
)
text = text.replace(
    "fn raw_pipe_row<'a>(source: &'a str, line: usize) -> Result<Vec<&'a str>, DefinitionSourceError> {",
    "fn raw_pipe_row(source: &str, line: usize) -> Result<Vec<&str>, DefinitionSourceError> {",
)
path.write_text(text)
