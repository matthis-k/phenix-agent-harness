use crate::theme::theme_style;
use phenix_frontend_config::ThemeConfig;
use ratatui::style::Modifier;
use ratatui::text::{Line, Span};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DocumentBlock {
    Heading {
        level: u8,
        text: String,
    },
    Paragraph(String),
    Quote(Vec<String>),
    Code {
        language: Option<String>,
        lines: Vec<String>,
    },
    List {
        ordered: bool,
        items: Vec<String>,
    },
    Table {
        header: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Rule,
    Image {
        alt: String,
        source: String,
    },
}

pub(crate) fn render_markdown(
    text: &str,
    width: u16,
    theme: &ThemeConfig,
) -> Vec<Line<'static>> {
    let blocks = parse_markdown(text);
    render_blocks(&blocks, usize::from(width.max(1)), theme)
}

pub(crate) fn parse_markdown(text: &str) -> Vec<DocumentBlock> {
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
                lines.push(source[index].to_owned());
                index += 1;
            }
            if index < source.len() {
                index += 1;
            }
            blocks.push(DocumentBlock::Code { language, lines });
            continue;
        }

        if let Some((level, heading)) = markdown_heading(trimmed) {
            blocks.push(DocumentBlock::Heading {
                level: u8::try_from(level).unwrap_or(6),
                text: heading.to_owned(),
            });
            index += 1;
            continue;
        }

        if is_markdown_rule(trimmed) {
            blocks.push(DocumentBlock::Rule);
            index += 1;
            continue;
        }

        if index + 1 < source.len()
            && parse_table_row(raw).is_some()
            && is_table_separator(source[index + 1])
        {
            let header = parse_table_row(raw).unwrap_or_default();
            index += 2;
            let mut rows = Vec::new();
            while index < source.len() {
                let Some(row) = parse_table_row(source[index]) else {
                    break;
                };
                rows.push(row);
                index += 1;
            }
            blocks.push(DocumentBlock::Table { header, rows });
            continue;
        }

        if let Some((alt, source)) = markdown_image(trimmed) {
            blocks.push(DocumentBlock::Image {
                alt: alt.to_owned(),
                source: source.to_owned(),
            });
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
                lines.push(quote.strip_prefix(' ').unwrap_or(quote).to_owned());
                index += 1;
            }
            blocks.push(DocumentBlock::Quote(lines));
            continue;
        }

        if unordered_item(trimmed).is_some() {
            let mut items = Vec::new();
            while index < source.len() {
                let Some(item) = unordered_item(source[index].trim_start()) else {
                    break;
                };
                items.push(item.to_owned());
                index += 1;
            }
            blocks.push(DocumentBlock::List {
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
                items.push(item.to_owned());
                index += 1;
            }
            blocks.push(DocumentBlock::List {
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
            paragraph.push(line.trim().to_owned());
            index += 1;
        }
        if paragraph.is_empty() {
            paragraph.push(raw.to_owned());
            index += 1;
        }
        blocks.push(DocumentBlock::Paragraph(paragraph.join(" ")));
    }

    blocks
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

fn render_blocks(
    blocks: &[DocumentBlock],
    width: usize,
    theme: &ThemeConfig,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        if index > 0 && needs_spacing(blocks.get(index - 1), block) {
            lines.push(Line::default());
        }
        match block {
            DocumentBlock::Heading { level, text } => {
                lines.push(Line::styled(
                    text.clone(),
                    heading_style(*level, theme).add_modifier(Modifier::BOLD),
                ));
            }
            DocumentBlock::Paragraph(text) => {
                lines.push(Line::from(inline_markdown_spans(text, theme)));
            }
            DocumentBlock::Quote(quote_lines) => {
                for text in quote_lines {
                    let mut spans = vec![Span::styled("│ ", theme_style(theme, "Accent"))];
                    spans.push(Span::styled(
                        text.clone(),
                        theme_style(theme, "Muted").add_modifier(Modifier::ITALIC),
                    ));
                    lines.push(Line::from(spans));
                }
            }
            DocumentBlock::Code {
                language,
                lines: code_lines,
            } => {
                if let Some(language) = language {
                    lines.push(Line::from(vec![
                        Span::styled("┌ ", theme_style(theme, "Border")),
                        Span::styled(
                            language.clone(),
                            theme_style(theme, "Tool").add_modifier(Modifier::BOLD),
                        ),
                    ]));
                }
                for text in code_lines {
                    lines.push(Line::from(vec![
                        Span::styled("│ ", theme_style(theme, "Border")),
                        Span::styled(text.clone(), theme_style(theme, "Normal")),
                    ]));
                }
            }
            DocumentBlock::List { ordered, items } => {
                for (item_index, item) in items.iter().enumerate() {
                    let marker = if *ordered {
                        format!("{}. ", item_index + 1)
                    } else {
                        "• ".to_owned()
                    };
                    let mut spans = vec![Span::styled(marker, theme_style(theme, "Accent"))];
                    spans.extend(inline_markdown_spans(item, theme));
                    lines.push(Line::from(spans));
                }
            }
            DocumentBlock::Table { header, rows } => {
                lines.extend(render_table(header, rows, width, theme));
            }
            DocumentBlock::Rule => {
                lines.push(Line::styled(
                    "─".repeat(width.min(48).max(3)),
                    theme_style(theme, "Border"),
                ));
            }
            DocumentBlock::Image { alt, source } => {
                lines.push(Line::from(vec![
                    Span::styled("▣ ", theme_style(theme, "Accent")),
                    Span::styled(
                        if alt.is_empty() {
                            "image".to_owned()
                        } else {
                            alt.clone()
                        },
                        theme_style(theme, "Accent").add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(format!("  {source}"), theme_style(theme, "Muted")),
                ]));
            }
        }
    }
    lines
}

fn needs_spacing(previous: Option<&DocumentBlock>, current: &DocumentBlock) -> bool {
    !matches!(
        (previous, current),
        (
            Some(DocumentBlock::List { .. }),
            DocumentBlock::List { .. }
        ) | (
            Some(DocumentBlock::Quote(_)),
            DocumentBlock::Quote(_)
        )
    )
}

fn render_table(
    header: &[String],
    rows: &[Vec<String>],
    width: usize,
    theme: &ThemeConfig,
) -> Vec<Line<'static>> {
    let columns = rows
        .iter()
        .map(Vec::len)
        .chain(std::iter::once(header.len()))
        .max()
        .unwrap_or(0);
    if columns == 0 {
        return Vec::new();
    }

    let separator_width = columns.saturating_sub(1).saturating_mul(3);
    let available = width.saturating_sub(separator_width).max(columns);
    let mut widths = (0..columns)
        .map(|column| {
            std::iter::once(header.get(column).map_or("", String::as_str))
                .chain(rows.iter().map(|row| row.get(column).map_or("", String::as_str)))
                .map(|cell| cell.chars().count())
                .max()
                .unwrap_or(1)
                .clamp(1, 40)
        })
        .collect::<Vec<_>>();

    while widths.iter().sum::<usize>() > available {
        let Some((index, _)) = widths
            .iter()
            .enumerate()
            .filter(|(_, value)| **value > 1)
            .max_by_key(|(_, value)| **value)
        else {
            break;
        };
        widths[index] -= 1;
    }

    let mut output = Vec::new();
    output.push(table_line(header, &widths, true, theme));
    let divider = widths
        .iter()
        .map(|cell_width| "─".repeat(*cell_width))
        .collect::<Vec<_>>()
        .join("─┼─");
    output.push(Line::styled(divider, theme_style(theme, "Border")));
    for row in rows {
        output.push(table_line(row, &widths, false, theme));
    }
    output
}

fn table_line(
    cells: &[String],
    widths: &[usize],
    header: bool,
    theme: &ThemeConfig,
) -> Line<'static> {
    let mut spans = Vec::new();
    for (index, width) in widths.iter().copied().enumerate() {
        if index > 0 {
            spans.push(Span::styled(" │ ", theme_style(theme, "Border")));
        }
        let value = cells.get(index).map_or("", String::as_str);
        let fitted = fit_cell(value, width);
        spans.push(Span::styled(
            fitted,
            if header {
                theme_style(theme, "Accent").add_modifier(Modifier::BOLD)
            } else {
                theme_style(theme, "Normal")
            },
        ));
    }
    Line::from(spans)
}

fn fit_cell(value: &str, width: usize) -> String {
    let count = value.chars().count();
    if count <= width {
        return format!("{value:<width$}");
    }
    if width <= 1 {
        return "…".chars().take(width).collect();
    }
    let mut output = value.chars().take(width - 1).collect::<String>();
    output.push('…');
    output
}

fn heading_style(level: u8, theme: &ThemeConfig) -> ratatui::style::Style {
    let group = match level {
        1 => "Accent",
        2 => "Tool",
        3 => "Success",
        4 => "Warning",
        _ => "Muted",
    };
    theme_style(theme, group)
}

fn markdown_heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|character| *character == '#').count();
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

fn inline_markdown_spans(text: &str, theme: &ThemeConfig) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if let Some(after_open) = remaining.strip_prefix("**") {
            if let Some(end) = after_open.find("**") {
                spans.push(Span::styled(
                    after_open[..end].to_owned(),
                    theme_style(theme, "Normal").add_modifier(Modifier::BOLD),
                ));
                remaining = &after_open[end + 2..];
                continue;
            }
        }

        if let Some(after_open) = remaining.strip_prefix('`') {
            if let Some(end) = after_open.find('`') {
                spans.push(Span::styled(
                    after_open[..end].to_owned(),
                    theme_style(theme, "Tool"),
                ));
                remaining = &after_open[end + 1..];
                continue;
            }
        }

        if let Some(after_open) = remaining.strip_prefix('[') {
            if let Some(label_end) = after_open.find("](") {
                let label = &after_open[..label_end];
                let target = &after_open[label_end + 2..];
                if let Some(target_end) = target.find(')') {
                    spans.push(Span::styled(
                        label.to_owned(),
                        theme_style(theme, "Accent").add_modifier(Modifier::UNDERLINED),
                    ));
                    remaining = &target[target_end + 1..];
                    continue;
                }
            }
        }

        if let Some(after_open) = remaining.strip_prefix('*') {
            if let Some(end) = after_open.find('*') {
                spans.push(Span::styled(
                    after_open[..end].to_owned(),
                    theme_style(theme, "Normal").add_modifier(Modifier::ITALIC),
                ));
                remaining = &after_open[end + 1..];
                continue;
            }
        }

        let next = next_inline_marker(remaining).unwrap_or(remaining.len());
        if next == 0 {
            let character = remaining.chars().next().expect("remaining is non-empty");
            spans.push(Span::styled(
                character.to_string(),
                theme_style(theme, "Normal"),
            ));
            remaining = &remaining[character.len_utf8()..];
        } else {
            spans.push(Span::styled(
                remaining[..next].to_owned(),
                theme_style(theme, "Normal"),
            ));
            remaining = &remaining[next..];
        }
    }

    spans
}

fn next_inline_marker(text: &str) -> Option<usize> {
    [text.find("**"), text.find('`'), text.find('['), text.find('*')]
        .into_iter()
        .flatten()
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn parses_tables_as_first_class_blocks() {
        let blocks = parse_markdown("| Name | State |\n| --- | --- |\n| build | green |\n");
        assert!(matches!(
            blocks.as_slice(),
            [DocumentBlock::Table { header, rows }]
                if header == &["Name".to_owned(), "State".to_owned()] && rows.len() == 1
        ));
    }

    #[test]
    fn renders_table_with_aligned_columns() {
        let rendered = render_markdown(
            "| Name | State |\n| --- | --- |\n| build | green |\n| test | pending |",
            40,
            &ThemeConfig::default(),
        );
        let text = rendered.iter().map(line_text).collect::<Vec<_>>();
        assert_eq!(text.len(), 4);
        assert!(text[0].contains("Name"));
        assert!(text[1].contains('┼'));
        assert!(text[2].contains("build"));
    }

    #[test]
    fn headings_use_distinct_semantic_styles() {
        let theme = ThemeConfig::default();
        assert_ne!(heading_style(1, &theme).fg, heading_style(2, &theme).fg);
        assert_ne!(heading_style(2, &theme).fg, heading_style(3, &theme).fg);
    }

    #[test]
    fn image_syntax_is_a_document_primitive() {
        let blocks = parse_markdown("![architecture](./graph.png)");
        assert_eq!(
            blocks,
            vec![DocumentBlock::Image {
                alt: "architecture".to_owned(),
                source: "./graph.png".to_owned(),
            }]
        );
    }

    #[test]
    fn paragraph_supports_bold_code_italic_and_links() {
        let rendered = render_markdown(
            "**bold** `code` *italic* [docs](https://example.test)",
            80,
            &ThemeConfig::default(),
        );
        assert_eq!(line_text(&rendered[0]), "bold code italic docs");
    }
}
