use crate::theme::theme_style;
use phenix_frontend_config::ThemeConfig;
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use std::cell::RefCell;
use std::sync::OnceLock;
use tree_sitter::Language;
use tree_sitter_highlight::{Highlight, HighlightConfiguration, HighlightEvent, Highlighter};

const HIGHLIGHT_NAMES: &[&str] = &[
    "attribute",
    "boolean",
    "comment",
    "conditional",
    "constant",
    "constructor",
    "embedded",
    "escape",
    "field",
    "function",
    "keyword",
    "label",
    "method",
    "module",
    "number",
    "operator",
    "parameter",
    "preproc",
    "property",
    "punctuation",
    "repeat",
    "string",
    "tag",
    "type",
    "variable",
];

thread_local! {
    static HIGHLIGHTER: RefCell<Highlighter> = RefCell::new(Highlighter::new());
}

pub(crate) fn highlighted_lines(
    language: Option<&str>,
    source: &str,
    theme: &ThemeConfig,
) -> Option<Vec<Line<'static>>> {
    let configuration = configuration_for(language?)?;
    HIGHLIGHTER.with(|cell| {
        let mut highlighter = cell.borrow_mut();
        let events = highlighter
            .highlight(configuration, source.as_bytes(), None, |_| None)
            .ok()?;
        let mut lines = vec![Vec::<Span<'static>>::new()];
        let mut styles = Vec::new();
        for event in events {
            match event.ok()? {
                HighlightEvent::Source { start, end } => {
                    let style = styles
                        .last()
                        .copied()
                        .unwrap_or_else(|| theme_style(theme, "Normal"));
                    push_source(&mut lines, source.get(start..end)?, style);
                }
                HighlightEvent::HighlightStart(Highlight(index)) => {
                    let name = HIGHLIGHT_NAMES.get(index).copied().unwrap_or("variable");
                    styles.push(highlight_style(name, theme));
                }
                HighlightEvent::HighlightEnd => {
                    styles.pop();
                }
            }
        }
        Some(lines.into_iter().map(Line::from).collect())
    })
}

fn push_source(lines: &mut Vec<Vec<Span<'static>>>, source: &str, style: Style) {
    let mut first = true;
    for part in source.split('\n') {
        if !first {
            lines.push(Vec::new());
        }
        first = false;
        if !part.is_empty() {
            lines
                .last_mut()
                .expect("highlight output has at least one line")
                .push(Span::styled(part.to_owned(), style));
        }
    }
}

fn highlight_style(name: &str, theme: &ThemeConfig) -> Style {
    match name {
        "comment" => theme_style(theme, "Muted").add_modifier(Modifier::ITALIC),
        "string" | "escape" => theme_style(theme, "Success"),
        "number" | "boolean" | "constant" => theme_style(theme, "Warning"),
        "keyword" | "conditional" | "repeat" | "operator" | "preproc" => {
            theme_style(theme, "Tool").add_modifier(Modifier::BOLD)
        }
        "type" | "constructor" | "module" | "tag" | "attribute" => theme_style(theme, "Accent"),
        "function" | "method" => theme_style(theme, "Tool"),
        "punctuation" => theme_style(theme, "Muted"),
        "field" | "property" | "parameter" | "variable" | "embedded" | "label" | _ => {
            theme_style(theme, "Normal")
        }
    }
}

fn configuration_for(language: &str) -> Option<&'static HighlightConfiguration> {
    let normalized = language.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "rs" | "rust" => Some(rust_configuration()),
        "js" | "javascript" | "jsx" => Some(javascript_configuration()),
        "ts" | "typescript" => Some(typescript_configuration(false)),
        "tsx" | "typescriptreact" => Some(typescript_configuration(true)),
        "py" | "python" => Some(python_configuration()),
        "nix" => Some(nix_configuration()),
        "sh" | "bash" | "shell" | "zsh" => Some(bash_configuration()),
        "lua" => Some(lua_configuration()),
        "json" | "jsonc" => Some(json_configuration()),
        _ => None,
    }
}

fn configured(
    language: Language,
    name: &str,
    highlights: &str,
    injections: &str,
    locals: &str,
) -> HighlightConfiguration {
    let mut configuration =
        HighlightConfiguration::new(language, name, highlights, injections, locals)
            .expect("bundled tree-sitter query must match bundled grammar");
    configuration.configure(HIGHLIGHT_NAMES);
    configuration
}

fn rust_configuration() -> &'static HighlightConfiguration {
    static CONFIGURATION: OnceLock<HighlightConfiguration> = OnceLock::new();
    CONFIGURATION.get_or_init(|| {
        configured(
            tree_sitter_rust::LANGUAGE.into(),
            "rust",
            tree_sitter_rust::HIGHLIGHTS_QUERY,
            tree_sitter_rust::INJECTIONS_QUERY,
            "",
        )
    })
}

fn javascript_configuration() -> &'static HighlightConfiguration {
    static CONFIGURATION: OnceLock<HighlightConfiguration> = OnceLock::new();
    CONFIGURATION.get_or_init(|| {
        let highlights = format!(
            "{}\n{}",
            tree_sitter_javascript::HIGHLIGHT_QUERY,
            tree_sitter_javascript::JSX_HIGHLIGHT_QUERY
        );
        configured(
            tree_sitter_javascript::LANGUAGE.into(),
            "javascript",
            &highlights,
            tree_sitter_javascript::INJECTIONS_QUERY,
            tree_sitter_javascript::LOCALS_QUERY,
        )
    })
}

fn typescript_configuration(tsx: bool) -> &'static HighlightConfiguration {
    static TYPESCRIPT: OnceLock<HighlightConfiguration> = OnceLock::new();
    static TSX: OnceLock<HighlightConfiguration> = OnceLock::new();
    let cell = if tsx { &TSX } else { &TYPESCRIPT };
    cell.get_or_init(|| {
        let highlights = format!(
            "{}\n{}\n{}",
            tree_sitter_javascript::HIGHLIGHT_QUERY,
            tree_sitter_javascript::JSX_HIGHLIGHT_QUERY,
            tree_sitter_typescript::HIGHLIGHTS_QUERY
        );
        let language = if tsx {
            tree_sitter_typescript::LANGUAGE_TSX
        } else {
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT
        };
        configured(
            language.into(),
            if tsx { "tsx" } else { "typescript" },
            &highlights,
            tree_sitter_javascript::INJECTIONS_QUERY,
            tree_sitter_typescript::LOCALS_QUERY,
        )
    })
}

fn python_configuration() -> &'static HighlightConfiguration {
    static CONFIGURATION: OnceLock<HighlightConfiguration> = OnceLock::new();
    CONFIGURATION.get_or_init(|| {
        configured(
            tree_sitter_python::LANGUAGE.into(),
            "python",
            tree_sitter_python::HIGHLIGHTS_QUERY,
            "",
            "",
        )
    })
}

fn nix_configuration() -> &'static HighlightConfiguration {
    static CONFIGURATION: OnceLock<HighlightConfiguration> = OnceLock::new();
    CONFIGURATION.get_or_init(|| {
        configured(
            tree_sitter_nix::LANGUAGE.into(),
            "nix",
            tree_sitter_nix::HIGHLIGHTS_QUERY,
            tree_sitter_nix::INJECTIONS_QUERY,
            "",
        )
    })
}

fn bash_configuration() -> &'static HighlightConfiguration {
    static CONFIGURATION: OnceLock<HighlightConfiguration> = OnceLock::new();
    CONFIGURATION.get_or_init(|| {
        configured(
            tree_sitter_bash::LANGUAGE.into(),
            "bash",
            tree_sitter_bash::HIGHLIGHT_QUERY,
            "",
            "",
        )
    })
}

fn lua_configuration() -> &'static HighlightConfiguration {
    static CONFIGURATION: OnceLock<HighlightConfiguration> = OnceLock::new();
    CONFIGURATION.get_or_init(|| {
        configured(
            tree_sitter_lua::LANGUAGE.into(),
            "lua",
            tree_sitter_lua::HIGHLIGHTS_QUERY,
            tree_sitter_lua::INJECTIONS_QUERY,
            tree_sitter_lua::LOCALS_QUERY,
        )
    })
}

fn json_configuration() -> &'static HighlightConfiguration {
    static CONFIGURATION: OnceLock<HighlightConfiguration> = OnceLock::new();
    CONFIGURATION.get_or_init(|| {
        configured(
            tree_sitter_json::LANGUAGE.into(),
            "json",
            tree_sitter_json::HIGHLIGHTS_QUERY,
            "",
            "",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_highlighting_preserves_source_text() {
        let source = "fn main() {\n    let value = 42;\n}";
        let lines = highlighted_lines(Some("rust"), source, &ThemeConfig::default())
            .expect("rust highlighter");
        let rendered = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(rendered, source);
        assert!(lines.iter().any(|line| line
            .spans
            .iter()
            .any(|span| { span.style != theme_style(&ThemeConfig::default(), "Normal") })));
    }

    #[test]
    fn unsupported_language_falls_back_to_plain_rendering() {
        assert!(
            highlighted_lines(Some("unknown-language"), "x", &ThemeConfig::default()).is_none()
        );
    }
}
