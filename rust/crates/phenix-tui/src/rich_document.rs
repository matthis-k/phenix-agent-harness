use crate::syntax_highlight::highlighted_lines;
use crate::theme::{surface_style, theme_style};
use phenix_frontend_config::ThemeConfig;
use phenix_ui_core::{
    RichBlock, RichBlockView, RichBlockViewport, RichCodeBlock, RichDocument, RichImage, RichSpan,
    RichTable, RichText,
};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

const CODE_VIEWPORT_ROWS: usize = 14;
const DIAGRAM_VIEWPORT_ROWS: usize = 18;
const TABLE_VIEWPORT_ROWS: usize = 16;
const IMAGE_PREVIEW_ROWS: u16 = 10;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RichMedia {
    Image {
        alt: String,
        source: String,
        rows: u16,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct RichBlockPresentation {
    pub view: Option<RichBlockView>,
    pub viewport: RichBlockViewport,
    pub selected: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct RenderedRichBlock {
    pub lines: Vec<Line<'static>>,
    pub media: Option<RichMedia>,
}

pub(crate) fn render_document(
    document: &RichDocument,
    width: u16,
    theme: &ThemeConfig,
    mut presentation_for: impl FnMut(usize, &RichBlock) -> RichBlockPresentation,
) -> Vec<RenderedRichBlock> {
    let width = usize::from(width.max(1));
    document
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let mut presentation = presentation_for(index, block);
            let views = block.candidate_views();
            if presentation
                .view
                .is_none_or(|view| !views.contains(&view))
            {
                presentation.view = Some(block.default_view());
            }
            render_block(block, presentation, width, theme)
        })
        .collect()
}

fn render_block(
    block: &RichBlock,
    presentation: RichBlockPresentation,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    match block {
        RichBlock::Heading { level, content } => RenderedRichBlock {
            lines: vec![Line::from(styled_rich_text(
                content,
                heading_style(*level, theme).add_modifier(Modifier::BOLD),
                theme,
            ))],
            media: None,
        },
        RichBlock::Paragraph(content) => RenderedRichBlock {
            lines: vec![Line::from(styled_rich_text(
                content,
                theme_style(theme, "Normal"),
                theme,
            ))],
            media: None,
        },
        RichBlock::Quote(lines) => RenderedRichBlock {
            lines: lines
                .iter()
                .map(|text| {
                    let mut spans = vec![Span::styled("│ ", theme_style(theme, "Accent"))];
                    spans.extend(styled_rich_text(
                        text,
                        theme_style(theme, "Muted").add_modifier(Modifier::ITALIC),
                        theme,
                    ));
                    Line::from(spans)
                })
                .collect(),
            media: None,
        },
        RichBlock::Code(code) => render_code(code, presentation, width, theme),
        RichBlock::List { ordered, items } => RenderedRichBlock {
            lines: items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let marker = if *ordered {
                        format!("{}. ", index + 1)
                    } else {
                        "• ".to_owned()
                    };
                    let mut spans = vec![Span::styled(marker, theme_style(theme, "Accent"))];
                    spans.extend(styled_rich_text(
                        item,
                        theme_style(theme, "Normal"),
                        theme,
                    ));
                    Line::from(spans)
                })
                .collect(),
            media: None,
        },
        RichBlock::Table(table) => render_table(table, presentation, width, theme),
        RichBlock::Rule => RenderedRichBlock {
            lines: vec![Line::styled(
                "─".repeat(width.min(48).max(3)),
                theme_style(theme, "Border"),
            )],
            media: None,
        },
        RichBlock::Image(image) => render_image(image, presentation, width, theme),
    }
}

fn render_code(
    code: &RichCodeBlock,
    presentation: RichBlockPresentation,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    let view = presentation.view.unwrap_or_else(|| RichBlock::Code(code.clone()).default_view());
    if view == RichBlockView::Rendered && code.language_is("mermaid") {
        return render_mermaid(code, presentation, width, theme);
    }

    let surface = surface_style(theme, "CodeBlock");
    let views = RichBlock::Code(code.clone()).candidate_views();
    let mut lines = vec![block_toolbar(
        code.language.as_deref().unwrap_or("code"),
        views,
        view,
        presentation.selected,
        width,
        surface,
        theme,
    )];

    let source_lines = if view == RichBlockView::Highlighted {
        highlighted_lines(code.language.as_deref(), &code.source, theme)
            .unwrap_or_else(|| plain_source_lines(&code.source, theme))
    } else {
        plain_source_lines(&code.source, theme)
    };
    lines.extend(viewport_lines(
        &source_lines,
        presentation.viewport,
        CODE_VIEWPORT_ROWS,
        width,
        surface,
    ));
    if source_lines.len() > CODE_VIEWPORT_ROWS {
        lines.push(viewport_footer(
            source_lines.len(),
            presentation.viewport.vertical,
            CODE_VIEWPORT_ROWS,
            width,
            surface,
            theme,
        ));
    } else {
        lines.push(surface_line("", width, surface));
    }

    RenderedRichBlock { lines, media: None }
}

fn render_mermaid(
    code: &RichCodeBlock,
    presentation: RichBlockPresentation,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    let surface = surface_style(theme, "CodeBlock");
    let views = RichBlock::Code(code.clone()).candidate_views();
    let mut lines = vec![block_toolbar(
        "mermaid",
        views,
        RichBlockView::Rendered,
        presentation.selected,
        width,
        surface,
        theme,
    )];

    match mermaid_text::render(&code.source) {
        Ok(rendered) => {
            let rendered_lines = rendered
                .trim_end_matches('\n')
                .lines()
                .map(|line| Line::styled(line.to_owned(), theme_style(theme, "Normal")))
                .collect::<Vec<_>>();
            lines.extend(viewport_lines(
                &rendered_lines,
                presentation.viewport,
                DIAGRAM_VIEWPORT_ROWS,
                width,
                surface,
            ));
            if rendered_lines.len() > DIAGRAM_VIEWPORT_ROWS {
                lines.push(viewport_footer(
                    rendered_lines.len(),
                    presentation.viewport.vertical,
                    DIAGRAM_VIEWPORT_ROWS,
                    width,
                    surface,
                    theme,
                ));
            } else {
                lines.push(surface_line("", width, surface));
            }
        }
        Err(error) => {
            lines.push(padded_line(
                vec![Span::styled(
                    format!("  Mermaid render unavailable: {error}"),
                    theme_style(theme, "Warning"),
                )],
                width,
                surface,
            ));
            lines.push(padded_line(
                vec![Span::styled(
                    "  Switch this block to source/highlighted view.",
                    theme_style(theme, "Muted"),
                )],
                width,
                surface,
            ));
        }
    }

    RenderedRichBlock { lines, media: None }
}

fn plain_source_lines(source: &str, theme: &ThemeConfig) -> Vec<Line<'static>> {
    if source.is_empty() {
        vec![Line::default()]
    } else {
        source
            .split('\n')
            .map(|line| Line::styled(line.to_owned(), theme_style(theme, "Normal")))
            .collect()
    }
}

fn viewport_lines(
    source: &[Line<'static>],
    viewport: RichBlockViewport,
    max_rows: usize,
    width: usize,
    surface: Style,
) -> Vec<Line<'static>> {
    source
        .iter()
        .skip(viewport.vertical.min(source.len().saturating_sub(1)))
        .take(max_rows)
        .map(|line| {
            let cropped = crop_line(line, viewport.horizontal, width.saturating_sub(2));
            let mut spans = vec![Span::styled("  ", surface)];
            spans.extend(cropped.spans);
            padded_line(spans, width, surface)
        })
        .collect()
}

fn viewport_footer(
    total_rows: usize,
    vertical: usize,
    visible_rows: usize,
    width: usize,
    surface: Style,
    theme: &ThemeConfig,
) -> Line<'static> {
    let start = vertical.min(total_rows.saturating_sub(1)) + 1;
    let end = start
        .saturating_add(visible_rows.saturating_sub(1))
        .min(total_rows);
    padded_line(
        vec![Span::styled(
            format!("  rows {start}–{end}/{total_rows}"),
            theme_style(theme, "Muted"),
        )],
        width,
        surface,
    )
}

fn crop_line(line: &Line<'_>, horizontal: usize, width: usize) -> Line<'static> {
    let mut skip = horizontal;
    let mut remaining = width;
    let mut spans = Vec::new();
    for span in &line.spans {
        if remaining == 0 {
            break;
        }
        let chars = span.content.chars().collect::<Vec<_>>();
        if skip >= chars.len() {
            skip -= chars.len();
            continue;
        }
        let take = chars.len().saturating_sub(skip).min(remaining);
        let text = chars[skip..skip + take].iter().collect::<String>();
        spans.push(Span::styled(text, span.style));
        remaining -= take;
        skip = 0;
    }
    Line::from(spans)
}

fn render_table(
    table: &RichTable,
    presentation: RichBlockPresentation,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    let view = presentation.view.unwrap_or(RichBlockView::Dense);
    let surface = surface_style(theme, "Surface");
    let views = RichBlock::Table(table.clone()).candidate_views();
    let mut lines = vec![block_toolbar(
        "table",
        views,
        view,
        presentation.selected,
        width,
        surface,
        theme,
    )];
    let body = match view {
        RichBlockView::Grid => grid_table_lines(table, width, theme),
        _ => dense_table_lines(table, width, theme),
    };
    lines.extend(viewport_lines(
        &body,
        presentation.viewport,
        TABLE_VIEWPORT_ROWS,
        width,
        surface,
    ));
    if body.len() > TABLE_VIEWPORT_ROWS {
        lines.push(viewport_footer(
            body.len(),
            presentation.viewport.vertical,
            TABLE_VIEWPORT_ROWS,
            width,
            surface,
            theme,
        ));
    }
    RenderedRichBlock { lines, media: None }
}

fn dense_table_lines(table: &RichTable, width: usize, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let widths = table_widths(table, width.saturating_sub(2), 3);
    if widths.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![table_row(&table.header, &widths, true, theme)];
    lines.push(Line::styled(
        widths
            .iter()
            .map(|cell| "─".repeat(*cell))
            .collect::<Vec<_>>()
            .join("─┼─"),
        theme_style(theme, "Border"),
    ));
    lines.extend(
        table
            .rows
            .iter()
            .map(|row| table_row(row, &widths, false, theme)),
    );
    lines
}

fn grid_table_lines(table: &RichTable, width: usize, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let widths = table_widths(table, width.saturating_sub(2), 3);
    if widths.is_empty() {
        return Vec::new();
    }
    let border = theme_style(theme, "Border");
    let rule = |left: char, middle: char, right: char| {
        Line::styled(
            format!(
                "{left}{}{right}",
                widths
                    .iter()
                    .map(|cell| "─".repeat(cell.saturating_add(2)))
                    .collect::<Vec<_>>()
                    .join(&middle.to_string())
            ),
            border,
        )
    };
    let mut lines = vec![rule('┌', '┬', '┐')];
    lines.push(grid_table_row(&table.header, &widths, true, theme));
    if !table.rows.is_empty() {
        lines.push(rule('├', '┼', '┤'));
    }
    for (index, row) in table.rows.iter().enumerate() {
        lines.push(grid_table_row(row, &widths, false, theme));
        if index + 1 < table.rows.len() {
            lines.push(rule('├', '┼', '┤'));
        }
    }
    lines.push(rule('└', '┴', '┘'));
    lines
}

fn table_widths(table: &RichTable, available: usize, separator_width: usize) -> Vec<usize> {
    let columns = table
        .rows
        .iter()
        .map(Vec::len)
        .chain(std::iter::once(table.header.len()))
        .max()
        .unwrap_or(0);
    if columns == 0 {
        return Vec::new();
    }
    let separators = columns.saturating_sub(1).saturating_mul(separator_width);
    let available = available.saturating_sub(separators).max(columns);
    let mut widths = (0..columns)
        .map(|column| {
            std::iter::once(table.header.get(column).map_or_else(String::new, RichText::text))
                .chain(table.rows.iter().map(|row| {
                    row.get(column).map_or_else(String::new, RichText::text)
                }))
                .map(|cell| cell.chars().count())
                .max()
                .unwrap_or(1)
                .clamp(1, 48)
        })
        .collect::<Vec<_>>();
    while widths.iter().sum::<usize>() > available {
        let Some((index, _)) = widths
            .iter()
            .enumerate()
            .filter(|(_, cell)| **cell > 1)
            .max_by_key(|(_, cell)| **cell)
        else {
            break;
        };
        widths[index] -= 1;
    }
    widths
}

fn table_row(
    cells: &[RichText],
    widths: &[usize],
    header: bool,
    theme: &ThemeConfig,
) -> Line<'static> {
    let mut spans = Vec::new();
    for (index, width) in widths.iter().copied().enumerate() {
        if index > 0 {
            spans.push(Span::styled(" │ ", theme_style(theme, "Border")));
        }
        let text = cells.get(index).map_or_else(String::new, RichText::text);
        spans.push(Span::styled(
            fit_cell(&text, width),
            if header {
                theme_style(theme, "Accent").add_modifier(Modifier::BOLD)
            } else {
                theme_style(theme, "Normal")
            },
        ));
    }
    Line::from(spans)
}

fn grid_table_row(
    cells: &[RichText],
    widths: &[usize],
    header: bool,
    theme: &ThemeConfig,
) -> Line<'static> {
    let mut spans = vec![Span::styled("│", theme_style(theme, "Border"))];
    for (index, width) in widths.iter().copied().enumerate() {
        let text = cells.get(index).map_or_else(String::new, RichText::text);
        spans.push(Span::styled(" ", theme_style(theme, "Normal")));
        spans.push(Span::styled(
            fit_cell(&text, width),
            if header {
                theme_style(theme, "Accent").add_modifier(Modifier::BOLD)
            } else {
                theme_style(theme, "Normal")
            },
        ));
        spans.push(Span::styled(" │", theme_style(theme, "Border")));
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

fn render_image(
    image: &RichImage,
    presentation: RichBlockPresentation,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    let view = presentation.view.unwrap_or(RichBlockView::Preview);
    let surface = surface_style(theme, "MediaBlock");
    let views = RichBlock::Image(image.clone()).candidate_views();
    let mut lines = vec![block_toolbar(
        if image.alt.is_empty() { "image" } else { &image.alt },
        views,
        view,
        presentation.selected,
        width,
        surface,
        theme,
    )];

    match view {
        RichBlockView::Metadata => {
            lines.push(padded_line(
                vec![Span::styled("  source  ", theme_style(theme, "Muted"))],
                width,
                surface,
            ));
            for fragment in wrap_text(&image.source, width.saturating_sub(4).max(1)) {
                lines.push(padded_line(
                    vec![Span::styled(format!("  {fragment}"), theme_style(theme, "Normal"))],
                    width,
                    surface,
                ));
            }
            RenderedRichBlock { lines, media: None }
        }
        _ => {
            lines.extend(
                (0..IMAGE_PREVIEW_ROWS).map(|_| surface_line("", width, surface)),
            );
            RenderedRichBlock {
                lines,
                media: Some(RichMedia::Image {
                    alt: image.alt.clone(),
                    source: image.source.clone(),
                    rows: IMAGE_PREVIEW_ROWS,
                }),
            }
        }
    }
}

fn block_toolbar(
    label: &str,
    views: &[RichBlockView],
    active: RichBlockView,
    selected: bool,
    width: usize,
    surface: Style,
    theme: &ThemeConfig,
) -> Line<'static> {
    let mut spans = vec![Span::styled(
        if selected { "▸ " } else { "  " },
        if selected {
            theme_style(theme, "Accent")
        } else {
            surface
        },
    )];
    spans.push(Span::styled(
        label.to_owned(),
        theme_style(theme, if selected { "Accent" } else { "Muted" })
            .add_modifier(Modifier::BOLD),
    ));
    if views.len() > 1 {
        spans.push(Span::styled("  ", surface));
        for (index, view) in views.iter().enumerate() {
            if index > 0 {
                spans.push(Span::styled(" ", surface));
            }
            spans.push(Span::styled(
                format!("[{}]", view.label()),
                if *view == active {
                    theme_style(theme, "Accent").add_modifier(Modifier::BOLD)
                } else {
                    theme_style(theme, "Muted")
                },
            ));
        }
    }
    padded_line(spans, width, surface)
}

fn styled_rich_text(text: &RichText, base: Style, theme: &ThemeConfig) -> Vec<Span<'static>> {
    text.spans
        .iter()
        .map(|span| match span {
            RichSpan::Text(value) => Span::styled(value.clone(), base),
            RichSpan::Strong(value) => Span::styled(value.clone(), base.add_modifier(Modifier::BOLD)),
            RichSpan::Emphasis(value) => {
                Span::styled(value.clone(), base.add_modifier(Modifier::ITALIC))
            }
            RichSpan::Code(value) => Span::styled(value.clone(), theme_style(theme, "Tool")),
            RichSpan::Link { label, .. } => Span::styled(
                label.clone(),
                theme_style(theme, "Accent").add_modifier(Modifier::UNDERLINED),
            ),
        })
        .collect()
}

fn heading_style(level: u8, theme: &ThemeConfig) -> Style {
    theme_style(
        theme,
        match level {
            1 => "Accent",
            2 => "Tool",
            3 => "Success",
            4 => "Warning",
            _ => "Muted",
        },
    )
}

fn padded_line(mut spans: Vec<Span<'static>>, width: usize, surface: Style) -> Line<'static> {
    let used = spans
        .iter()
        .map(|span| span.content.chars().count())
        .sum::<usize>();
    if used < width {
        spans.push(Span::styled(" ".repeat(width - used), surface));
    }
    Line::from(spans).style(surface)
}

fn surface_line(text: &str, width: usize, surface: Style) -> Line<'static> {
    padded_line(vec![Span::styled(text.to_owned(), surface)], width, surface)
}

fn wrap_text(text: &str, width: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let mut output = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if current.chars().count() == width {
            output.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        output.push(current);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_ui_core::parse_markdown;

    fn line_text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn code_blocks_are_bounded_and_keep_a_distinct_surface() {
        let source = (0..30)
            .map(|index| format!("let value_{index} = {index};"))
            .collect::<Vec<_>>()
            .join("\n");
        let document = parse_markdown(&format!("```rust\n{source}\n```"));
        let rendered = render_document(&document, 50, &ThemeConfig::default(), |_, block| {
            RichBlockPresentation {
                view: Some(block.default_view()),
                ..RichBlockPresentation::default()
            }
        });
        assert!(rendered[0].lines.len() <= CODE_VIEWPORT_ROWS + 2);
        let background = surface_style(&ThemeConfig::default(), "CodeBlock").bg;
        assert!(background.is_some());
        assert!(rendered[0].lines.iter().all(|line| line.style.bg == background));
    }

    #[test]
    fn mermaid_rendered_view_uses_real_terminal_diagram_renderer() {
        let document = parse_markdown("```mermaid\ngraph LR; A[Build] --> B[Test]\n```");
        let rendered = render_document(&document, 80, &ThemeConfig::default(), |_, _| {
            RichBlockPresentation::default()
        });
        let text = rendered[0]
            .lines
            .iter()
            .map(line_text)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Build"));
        assert!(text.contains("Test"));
        assert!(text.contains('┌') || text.contains('│'));
    }

    #[test]
    fn table_views_are_visually_distinct() {
        let document = parse_markdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
        let dense = render_document(&document, 40, &ThemeConfig::default(), |_, _| {
            RichBlockPresentation {
                view: Some(RichBlockView::Dense),
                ..RichBlockPresentation::default()
            }
        });
        let grid = render_document(&document, 40, &ThemeConfig::default(), |_, _| {
            RichBlockPresentation {
                view: Some(RichBlockView::Grid),
                ..RichBlockPresentation::default()
            }
        });
        let dense_text = dense[0].lines.iter().map(line_text).collect::<Vec<_>>();
        let grid_text = grid[0].lines.iter().map(line_text).collect::<Vec<_>>();
        assert!(!dense_text.iter().any(|line| line.starts_with('┌')));
        assert!(grid_text.iter().any(|line| line.starts_with("  ┌") || line.starts_with('┌')));
    }

    #[test]
    fn image_preview_emits_media_anchor_payload() {
        let document = parse_markdown("![preview](data:image/png;base64,Zm9v)");
        let rendered = render_document(&document, 40, &ThemeConfig::default(), |_, _| {
            RichBlockPresentation::default()
        });
        assert!(matches!(rendered[0].media, Some(RichMedia::Image { .. })));
    }
}
