#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum RichBlockView {
    Rendered,
    Source,
    Highlighted,
    Dense,
    Grid,
    Preview,
    Metadata,
}

impl RichBlockView {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Rendered => "rendered",
            Self::Source => "source",
            Self::Highlighted => "highlighted",
            Self::Dense => "dense",
            Self::Grid => "grid",
            Self::Preview => "preview",
            Self::Metadata => "metadata",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RichSpan {
    Text(String),
    Strong(String),
    Emphasis(String),
    Code(String),
    Link { label: String, target: String },
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RichText {
    pub spans: Vec<RichSpan>,
}

impl RichText {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            spans: vec![RichSpan::Text(text.into())],
        }
    }

    pub fn text(&self) -> String {
        self.spans
            .iter()
            .map(|span| match span {
                RichSpan::Text(value)
                | RichSpan::Strong(value)
                | RichSpan::Emphasis(value)
                | RichSpan::Code(value) => value.as_str(),
                RichSpan::Link { label, .. } => label.as_str(),
            })
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RichCodeBlock {
    pub language: Option<String>,
    pub source: String,
}

impl RichCodeBlock {
    pub fn language_is(&self, expected: &str) -> bool {
        self.language
            .as_deref()
            .is_some_and(|language| language.eq_ignore_ascii_case(expected))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RichTable {
    pub header: Vec<RichText>,
    pub rows: Vec<Vec<RichText>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RichImage {
    pub alt: String,
    pub source: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RichBlock {
    Heading { level: u8, content: RichText },
    Paragraph(RichText),
    Quote(Vec<RichText>),
    Code(RichCodeBlock),
    List { ordered: bool, items: Vec<RichText> },
    Table(RichTable),
    Rule,
    Image(RichImage),
}

impl RichBlock {
    /// Semantic representations that may make sense for this block. A concrete
    /// renderer is free to expose only the subset it actually implements.
    pub fn candidate_views(&self) -> &'static [RichBlockView] {
        match self {
            Self::Code(code) if code.language_is("mermaid") => &[
                RichBlockView::Source,
                RichBlockView::Highlighted,
                RichBlockView::Rendered,
            ],
            Self::Code(_) => &[RichBlockView::Source, RichBlockView::Highlighted],
            Self::Table(_) => &[RichBlockView::Dense, RichBlockView::Grid],
            Self::Image(_) => &[RichBlockView::Preview, RichBlockView::Metadata],
            Self::Heading { .. }
            | Self::Paragraph(_)
            | Self::Quote(_)
            | Self::List { .. }
            | Self::Rule => &[RichBlockView::Rendered],
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RichDocument {
    pub blocks: Vec<RichBlock>,
}

pub fn parse_markdown(text: &str) -> RichDocument {
    let source = text.lines().collect::<Vec<_>>();
    let mut blocks = Vec::new();
    let mut index = 0usize;

    while index < source.len() {
        let raw = source[index];
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            index += 1;
            continue;
        }

        if let Some(fence) = trimmed.strip_prefix("```") {
            let language = (!fence.trim().is_empty()).then(|| fence.trim().to_owned());
            index += 1;
            let mut lines = Vec::new();
            while index < source.len() && !source[index].trim_start().starts_with("```") {
                lines.push(source[index]);
                index += 1;
            }
            if index < source.len() {
                index += 1;
            }
            blocks.push(RichBlock::Code(RichCodeBlock {
                language,
                source: lines.join("\n"),
            }));
            continue;
        }

        if let Some((level, heading)) = markdown_heading(trimmed) {
            blocks.push(RichBlock::Heading {
                level: u8::try_from(level).unwrap_or(6),
                content: parse_inline(heading),
            });
            index += 1;
            continue;
        }

        if is_markdown_rule(trimmed) {
            blocks.push(RichBlock::Rule);
            index += 1;
            continue;
        }

        if index + 1 < source.len()
            && parse_table_row(raw).is_some()
            && is_table_separator(source[index + 1])
        {
            let header = parse_table_row(raw)
                .unwrap_or_default()
                .into_iter()
                .map(|cell| parse_inline(&cell))
                .collect();
            index += 2;
            let mut rows = Vec::new();
            while index < source.len() {
                let Some(row) = parse_table_row(source[index]) else {
                    break;
                };
                rows.push(row.into_iter().map(|cell| parse_inline(&cell)).collect());
                index += 1;
            }
            blocks.push(RichBlock::Table(RichTable { header, rows }));
            continue;
        }

        if let Some((alt, source)) = markdown_image(trimmed) {
            blocks.push(RichBlock::Image(RichImage {
                alt: alt.to_owned(),
                source: source.to_owned(),
            }));
            index += 1;
            continue;
        }

        if trimmed.starts_with('>') {
            let mut lines = Vec::new();
            while index < source.len() {
                let line = source[index].trim_start();
                let Some(quote) = line.strip_prefix('>') else {
                    break;
                };
                lines.push(parse_inline(quote.strip_prefix(' ').unwrap_or(quote)));
                index += 1;
            }
            blocks.push(RichBlock::Quote(lines));
            continue;
        }

        if unordered_item(trimmed).is_some() {
            let mut items = Vec::new();
            while index < source.len() {
                let Some(item) = unordered_item(source[index].trim_start()) else {
                    break;
                };
                items.push(parse_inline(item));
                index += 1;
            }
            blocks.push(RichBlock::List {
                ordered: false,
                items,
            });
            continue;
        }

        if ordered_list_item(trimmed).is_some() {
            let mut items = Vec::new();
            while index < source.len() {
                let Some((_, item)) = ordered_list_item(source[index].trim_start()) else {
                    break;
                };
                items.push(parse_inline(item));
                index += 1;
            }
            blocks.push(RichBlock::List {
                ordered: true,
                items,
            });
            continue;
        }

        let mut paragraph = Vec::new();
        while index < source.len() {
            let line = source[index];
            if line.trim().is_empty() || starts_block(&source, index) {
                break;
            }
            paragraph.push(line.trim());
            index += 1;
        }
        if paragraph.is_empty() {
            paragraph.push(raw);
            index += 1;
        }
        blocks.push(RichBlock::Paragraph(parse_inline(&paragraph.join(" "))));
    }

    RichDocument { blocks }
}

pub fn parse_inline(text: &str) -> RichText {
    let mut spans = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if let Some(after_open) = remaining.strip_prefix("**") {
            if let Some(end) = after_open.find("**") {
                spans.push(RichSpan::Strong(after_open[..end].to_owned()));
                remaining = &after_open[end + 2..];
                continue;
            }
        }

        if let Some(after_open) = remaining.strip_prefix('`') {
            if let Some(end) = after_open.find('`') {
                spans.push(RichSpan::Code(after_open[..end].to_owned()));
                remaining = &after_open[end + 1..];
                continue;
            }
        }

        if let Some(after_open) = remaining.strip_prefix('[') {
            if let Some(label_end) = after_open.find("](") {
                let label = &after_open[..label_end];
                let target = &after_open[label_end + 2..];
                if let Some(target_end) = target.find(')') {
                    spans.push(RichSpan::Link {
                        label: label.to_owned(),
                        target: target[..target_end].to_owned(),
                    });
                    remaining = &target[target_end + 1..];
                    continue;
                }
            }
        }

        if let Some(after_open) = remaining.strip_prefix('*') {
            if let Some(end) = after_open.find('*') {
                spans.push(RichSpan::Emphasis(after_open[..end].to_owned()));
                remaining = &after_open[end + 1..];
                continue;
            }
        }

        let next = next_inline_marker(remaining).unwrap_or(remaining.len());
        if next == 0 {
            let character = remaining.chars().next().expect("remaining is non-empty");
            spans.push(RichSpan::Text(character.to_string()));
            remaining = &remaining[character.len_utf8()..];
        } else {
            spans.push(RichSpan::Text(remaining[..next].to_owned()));
            remaining = &remaining[next..];
        }
    }

    RichText { spans }
}

fn starts_block(lines: &[&str], index: usize) -> bool {
    let trimmed = lines[index].trim();
    trimmed.starts_with("```")
        || markdown_heading(trimmed).is_some()
        || is_markdown_rule(trimmed)
        || markdown_image(trimmed).is_some()
        || trimmed.starts_with('>')
        || unordered_item(trimmed).is_some()
        || ordered_list_item(trimmed).is_some()
        || (index + 1 < lines.len()
            && parse_table_row(lines[index]).is_some()
            && is_table_separator(lines[index + 1]))
}

fn markdown_heading(line: &str) -> Option<(usize, &str)> {
    let level = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let heading = line.get(level..)?.strip_prefix(' ')?;
    Some((level, heading.trim()))
}

fn unordered_item(line: &str) -> Option<&str> {
    line.strip_prefix("- ").or_else(|| line.strip_prefix("* "))
}

fn ordered_list_item(line: &str) -> Option<(&str, &str)> {
    let (marker, item) = line.split_once(' ')?;
    let digits = marker.strip_suffix('.')?;
    if digits.is_empty() || !digits.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    Some((marker, item))
}

fn is_markdown_rule(line: &str) -> bool {
    let compact = line
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let Some(marker) = compact.chars().next() else {
        return false;
    };
    compact.len() >= 3
        && matches!(marker, '-' | '*' | '_')
        && compact.chars().all(|character| character == marker)
}

fn parse_table_row(line: &str) -> Option<Vec<String>> {
    if !line.contains('|') {
        return None;
    }
    let cells = line
        .trim()
        .trim_matches('|')
        .split('|')
        .map(|cell| cell.trim().to_owned())
        .collect::<Vec<_>>();
    (cells.len() >= 2).then_some(cells)
}

fn is_table_separator(line: &str) -> bool {
    let Some(cells) = parse_table_row(line) else {
        return false;
    };
    cells.into_iter().all(|cell| {
        let body = cell.trim().trim_matches(':');
        body.len() >= 3 && body.chars().all(|character| character == '-')
    })
}

fn markdown_image(line: &str) -> Option<(&str, &str)> {
    let after_marker = line.strip_prefix("![")?;
    let (alt, tail) = after_marker.split_once("](")?;
    let source = tail.strip_suffix(')')?;
    (!source.trim().is_empty()).then_some((alt.trim(), source.trim()))
}

fn next_inline_marker(text: &str) -> Option<usize> {
    [
        text.find("**"),
        text.find('`'),
        text.find('['),
        text.find('*'),
    ]
    .into_iter()
    .flatten()
    .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_is_parsed_into_renderer_neutral_blocks() {
        let document = parse_markdown(
            "# Heading\n\n| Name | State |\n| --- | --- |\n| build | green |\n\n```mermaid\nflowchart LR\nA --> B\n```",
        );
        assert!(matches!(
            document.blocks[0],
            RichBlock::Heading { level: 1, .. }
        ));
        assert!(matches!(document.blocks[1], RichBlock::Table(_)));
        assert!(matches!(document.blocks[2], RichBlock::Code(_)));
    }

    #[test]
    fn block_views_are_semantic_not_renderer_specific() {
        let table = RichBlock::Table(RichTable {
            header: vec![RichText::plain("Name")],
            rows: vec![vec![RichText::plain("build")]],
        });
        assert_eq!(
            table.candidate_views(),
            &[RichBlockView::Dense, RichBlockView::Grid]
        );

        let mermaid = RichBlock::Code(RichCodeBlock {
            language: Some("mermaid".to_owned()),
            source: "A --> B".to_owned(),
        });
        assert_eq!(
            mermaid.candidate_views(),
            &[
                RichBlockView::Source,
                RichBlockView::Highlighted,
                RichBlockView::Rendered,
            ]
        );
    }

    #[test]
    fn inline_content_preserves_semantics() {
        let rich = parse_inline("**bold** `code` *italic* [docs](https://example.test)");
        assert_eq!(rich.spans.len(), 7);
        assert!(matches!(rich.spans[0], RichSpan::Strong(_)));
        assert!(matches!(rich.spans[2], RichSpan::Code(_)));
        assert!(matches!(rich.spans[4], RichSpan::Emphasis(_)));
        assert!(matches!(rich.spans[6], RichSpan::Link { .. }));
    }
}
