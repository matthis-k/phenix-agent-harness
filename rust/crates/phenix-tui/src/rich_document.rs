use crate::theme::{surface_style, theme_style};
use phenix_frontend_config::ThemeConfig;
use phenix_ui_core::{
    RichBlock, RichBlockView, RichCodeBlock, RichDocument, RichImage, RichSpan, RichTable, RichText,
};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

const IMAGE_PREVIEW_ROWS: u16 = 8;
const DOCUMENT_MARGIN: usize = 1;
const MAX_HEADING_DEPTH: usize = 4;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RichMedia {
    Image {
        alt: String,
        source: String,
        rows: u16,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct RenderedRichBlock {
    pub lines: Vec<Line<'static>>,
    pub active_view: RichBlockView,
    pub media: Option<RichMedia>,
}

pub(crate) fn render_document(
    document: &RichDocument,
    width: u16,
    theme: &ThemeConfig,
    mut view_for: impl FnMut(usize) -> Option<RichBlockView>,
) -> Vec<RenderedRichBlock> {
    let width = usize::from(width.max(1));
    document
        .blocks
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let views = block.candidate_views().to_vec();
            let active_view = view_for(index)
                .filter(|candidate| views.contains(candidate))
                .unwrap_or_else(|| default_view(block));
            render_block(block, active_view, views, width, theme)
        })
        .collect()
}

fn default_view(block: &RichBlock) -> RichBlockView {
    match block {
        RichBlock::Table(_) => RichBlockView::Dense,
        RichBlock::Code(code) if code.language_is("mermaid") => RichBlockView::Rendered,
        RichBlock::Code(_) => RichBlockView::Highlighted,
        RichBlock::Image(_) => RichBlockView::Preview,
        RichBlock::Heading { .. }
        | RichBlock::Paragraph(_)
        | RichBlock::Quote(_)
        | RichBlock::List { .. }
        | RichBlock::Rule => RichBlockView::Rendered,
    }
}

fn render_block(
    block: &RichBlock,
    active_view: RichBlockView,
    views: Vec<RichBlockView>,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    match block {
        RichBlock::Heading { level, content } => {
            render_heading(*level, content, active_view, width, theme)
        }
        RichBlock::Paragraph(content) => RenderedRichBlock {
            lines: vec![Line::from(styled_rich_text(
                content,
                theme_style(theme, "Normal"),
                theme,
            ))],
            active_view,
            media: None,
        },
        RichBlock::Quote(quote_lines) => RenderedRichBlock {
            lines: quote_lines
                .iter()
                .map(|content| {
                    let mut spans = vec![Span::styled("│ ", theme_style(theme, "Accent"))];
                    spans.extend(styled_rich_text(
                        content,
                        theme_style(theme, "Muted").add_modifier(Modifier::ITALIC),
                        theme,
                    ));
                    Line::from(spans)
                })
                .collect(),
            active_view,
            media: None,
        },
        RichBlock::Code(code) => render_code(code, active_view, views, width, theme),
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
                    spans.extend(styled_rich_text(item, theme_style(theme, "Normal"), theme));
                    Line::from(spans)
                })
                .collect(),
            active_view,
            media: None,
        },
        RichBlock::Table(table) => render_table(table, active_view, views, width, theme),
        RichBlock::Rule => render_rule(active_view, width, theme),
        RichBlock::Image(image) => render_image(image, active_view, views, width, theme),
    }
}

fn render_heading(
    level: u8,
    content: &RichText,
    active_view: RichBlockView,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    let depth = usize::from(level.saturating_sub(1)).min(MAX_HEADING_DEPTH);
    let maximum_margin = width.saturating_sub(3) / 2;
    let margin = depth.min(maximum_margin);
    let band_width = width.saturating_sub(margin.saturating_mul(2)).max(1);
    let surface = heading_surface(level, theme);
    let mut content_spans = styled_rich_text(
        content,
        heading_style(level, theme).add_modifier(Modifier::BOLD),
        theme,
    );
    for span in &mut content_spans {
        span.style = on_surface(span.style, surface);
    }

    let mut band = Vec::new();
    if band_width > 1 {
        band.push(Span::styled(" ", surface));
    }
    band.extend(content_spans);
    let used = band
        .iter()
        .map(|span| span.content.chars().count())
        .sum::<usize>();
    if used < band_width {
        band.push(Span::styled(" ".repeat(band_width - used), surface));
    }

    let mut spans = Vec::new();
    if margin > 0 {
        spans.push(Span::raw(" ".repeat(margin)));
    }
    spans.extend(band);
    if margin > 0 {
        spans.push(Span::raw(" ".repeat(margin)));
    }

    RenderedRichBlock {
        lines: vec![Line::from(spans)],
        active_view,
        media: None,
    }
}

fn heading_surface(level: u8, theme: &ThemeConfig) -> Style {
    let group = match level {
        1 => "Heading1",
        2 => "Heading2",
        3 => "Heading3",
        _ => "Heading4",
    };
    let explicit = surface_style(theme, group);
    if explicit.bg.is_some() {
        explicit
    } else {
        match level {
            1 => surface_style(theme, "CodeBlock"),
            2 => surface_style(theme, "UserMessage"),
            _ => surface_style(theme, "Surface"),
        }
    }
}

fn render_rule(active_view: RichBlockView, width: usize, theme: &ThemeConfig) -> RenderedRichBlock {
    let inner = width
        .saturating_sub(DOCUMENT_MARGIN.saturating_mul(2))
        .max(1);
    let mut spans = Vec::new();
    if width > inner {
        spans.push(Span::raw(" ".repeat(DOCUMENT_MARGIN.min(width))));
    }
    spans.push(Span::styled("─".repeat(inner), theme_style(theme, "Muted")));
    RenderedRichBlock {
        lines: vec![Line::from(spans)],
        active_view,
        media: None,
    }
}

fn render_code(
    code: &RichCodeBlock,
    active_view: RichBlockView,
    views: Vec<RichBlockView>,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    if active_view == RichBlockView::Rendered && code.language_is("mermaid") {
        return render_mermaid(code, views, width, theme);
    }

    let surface = surface_style(theme, "CodeBlock");
    let mut lines = vec![block_toolbar(
        code.language.as_deref().unwrap_or("code"),
        &views,
        active_view,
        width,
        surface,
        theme,
    )];
    let content_width = width.saturating_sub(2).max(1);
    if code.source.is_empty() {
        lines.push(surface_line("", width, surface));
    } else {
        for raw in code.source.lines() {
            for fragment in wrap_text(raw, content_width) {
                let mut spans = vec![Span::styled("  ", surface)];
                if active_view == RichBlockView::Highlighted {
                    spans.extend(highlight_code_line(
                        code.language.as_deref(),
                        &fragment,
                        theme,
                    ));
                } else {
                    spans.push(Span::styled(fragment, theme_style(theme, "Normal")));
                }
                lines.push(padded_line(spans, width, surface));
            }
        }
    }
    lines.push(surface_line("", width, surface));
    RenderedRichBlock {
        lines,
        active_view,
        media: None,
    }
}

fn highlight_code_line(
    language: Option<&str>,
    line: &str,
    theme: &ThemeConfig,
) -> Vec<Span<'static>> {
    let comment_marker = match language.unwrap_or_default().to_ascii_lowercase().as_str() {
        "python" | "py" | "ruby" | "rb" | "nix" | "sh" | "bash" | "zsh" | "yaml" | "yml" => "#",
        _ => "//",
    };
    if let Some(index) = line.find(comment_marker) {
        let mut spans = highlight_code_tokens(&line[..index], theme);
        spans.push(Span::styled(
            line[index..].to_owned(),
            theme_style(theme, "Muted").add_modifier(Modifier::ITALIC),
        ));
        return spans;
    }
    highlight_code_tokens(line, theme)
}

fn highlight_code_tokens(line: &str, theme: &ThemeConfig) -> Vec<Span<'static>> {
    const KEYWORDS: &[&str] = &[
        "as",
        "async",
        "await",
        "break",
        "class",
        "const",
        "continue",
        "def",
        "else",
        "enum",
        "export",
        "false",
        "fn",
        "for",
        "from",
        "function",
        "if",
        "impl",
        "import",
        "in",
        "interface",
        "let",
        "match",
        "mod",
        "mut",
        "nil",
        "null",
        "pub",
        "return",
        "self",
        "static",
        "struct",
        "super",
        "this",
        "trait",
        "true",
        "type",
        "use",
        "var",
        "while",
    ];

    let mut spans = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    let flush_plain = |value: &mut String, output: &mut Vec<Span<'static>>| {
        if value.is_empty() {
            return;
        }
        let token = std::mem::take(value);
        let trimmed =
            token.trim_matches(|character: char| !character.is_alphanumeric() && character != '_');
        let style = if KEYWORDS.contains(&trimmed) {
            theme_style(theme, "Tool").add_modifier(Modifier::BOLD)
        } else if !trimmed.is_empty() && trimmed.chars().all(|character| character.is_ascii_digit())
        {
            theme_style(theme, "Warning")
        } else {
            theme_style(theme, "Normal")
        };
        output.push(Span::styled(token, style));
    };

    for character in line.chars() {
        if let Some(open) = quote {
            current.push(character);
            if character == open {
                spans.push(Span::styled(
                    std::mem::take(&mut current),
                    theme_style(theme, "Success"),
                ));
                quote = None;
            }
            continue;
        }
        if matches!(character, '"' | '\'') {
            flush_plain(&mut current, &mut spans);
            current.push(character);
            quote = Some(character);
            continue;
        }
        if character.is_whitespace() || "(){}[],:;=+-*/<>.!&|".contains(character) {
            flush_plain(&mut current, &mut spans);
            spans.push(Span::styled(
                character.to_string(),
                theme_style(theme, "Muted"),
            ));
        } else {
            current.push(character);
        }
    }
    if quote.is_some() {
        spans.push(Span::styled(current, theme_style(theme, "Success")));
    } else {
        flush_plain(&mut current, &mut spans);
    }
    spans
}

fn render_mermaid(
    code: &RichCodeBlock,
    views: Vec<RichBlockView>,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    let surface = surface_style(theme, "CodeBlock");
    let mut lines = vec![block_toolbar(
        "mermaid",
        &views,
        RichBlockView::Rendered,
        width,
        surface,
        theme,
    )];
    let rendered = render_mermaid_fallback(&code.source);
    if rendered.is_empty() {
        lines.push(padded_line(
            vec![Span::styled(
                "  Mermaid renderer could not project this diagram; switch to source.",
                theme_style(theme, "Muted"),
            )],
            width,
            surface,
        ));
    } else {
        for line in rendered {
            lines.push(padded_line(
                vec![Span::styled(
                    format!("  {line}"),
                    theme_style(theme, "Normal"),
                )],
                width,
                surface,
            ));
        }
    }
    lines.push(surface_line("", width, surface));
    RenderedRichBlock {
        lines,
        active_view: RichBlockView::Rendered,
        media: None,
    }
}

fn render_mermaid_fallback(source: &str) -> Vec<String> {
    let lines = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Vec::new();
    }
    let start = usize::from(lines[0].starts_with("flowchart") || lines[0].starts_with("graph"));
    let mut output = Vec::new();
    for line in lines.into_iter().skip(start) {
        let arrow = ["-.->", "==>", "-->", "---"]
            .into_iter()
            .find(|arrow| line.contains(arrow));
        let Some(arrow) = arrow else {
            continue;
        };
        let Some((left, right)) = line.split_once(arrow) else {
            continue;
        };
        let left = mermaid_node_label(left);
        let right = mermaid_node_label(right);
        if left.is_empty() || right.is_empty() {
            continue;
        }
        let glyph = if arrow == "---" {
            "──"
        } else {
            "──▶"
        };
        output.push(format!("{left} {glyph} {right}"));
    }
    output
}

fn mermaid_node_label(source: &str) -> String {
    let source = source.trim();
    let label = ['[', '(', '{']
        .into_iter()
        .filter_map(|marker| source.find(marker).map(|index| &source[index + 1..]))
        .next()
        .unwrap_or(source);
    label
        .trim_matches(|character| matches!(character, ']' | ')' | '}' | '"' | '\'' | ' '))
        .to_owned()
}

fn render_table(
    table: &RichTable,
    active_view: RichBlockView,
    views: Vec<RichBlockView>,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    let mut lines = vec![block_toolbar(
        "table",
        &views,
        active_view,
        width,
        Style::default(),
        theme,
    )];
    let inner_width = width
        .saturating_sub(DOCUMENT_MARGIN.saturating_mul(2))
        .max(1);
    let body = match active_view {
        RichBlockView::Grid => render_table_grid(table, inner_width, theme),
        _ => render_table_dense(table, inner_width, theme),
    };
    lines.extend(
        body.into_iter()
            .map(|line| inset_line(line, DOCUMENT_MARGIN)),
    );
    RenderedRichBlock {
        lines,
        active_view,
        media: None,
    }
}

fn render_table_dense(table: &RichTable, width: usize, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let widths = table_widths(table, width, TableLayout::Dense);
    if widths.is_empty() {
        return Vec::new();
    }
    let mut output = vec![table_line(&table.header, &widths, true, false, theme)];
    output.push(Line::styled(
        dense_rule(&widths),
        theme_style(theme, "Muted"),
    ));
    output.extend(
        table
            .rows
            .iter()
            .map(|row| table_line(row, &widths, false, false, theme)),
    );
    output
}

fn render_table_grid(table: &RichTable, width: usize, theme: &ThemeConfig) -> Vec<Line<'static>> {
    let widths = table_widths(table, width, TableLayout::Grid);
    if widths.is_empty() {
        return Vec::new();
    }
    let top = grid_rule('┌', '┬', '┐', &widths);
    let header_rule = grid_rule('├', '┼', '┤', &widths);
    let row_rule = grid_rule('├', '┼', '┤', &widths);
    let bottom = grid_rule('└', '┴', '┘', &widths);
    let structural = theme_style(theme, "Muted");
    let mut output = vec![Line::styled(top, structural)];
    output.push(table_line(&table.header, &widths, true, true, theme));
    output.push(Line::styled(header_rule, structural));
    for (index, row) in table.rows.iter().enumerate() {
        output.push(table_line(row, &widths, false, true, theme));
        if index + 1 < table.rows.len() {
            output.push(Line::styled(row_rule.clone(), structural));
        }
    }
    output.push(Line::styled(bottom, structural));
    output
}

#[derive(Clone, Copy)]
enum TableLayout {
    Dense,
    Grid,
}

fn table_widths(table: &RichTable, width: usize, layout: TableLayout) -> Vec<usize> {
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
    let fixed = match layout {
        TableLayout::Dense => columns.saturating_sub(1).saturating_mul(3),
        TableLayout::Grid => columns.saturating_mul(3).saturating_add(1),
    };
    let available = width.saturating_sub(fixed).max(columns);
    let mut widths = (0..columns)
        .map(|column| {
            std::iter::once(
                table
                    .header
                    .get(column)
                    .map_or_else(String::new, RichText::text),
            )
            .chain(
                table
                    .rows
                    .iter()
                    .map(|row| row.get(column).map_or_else(String::new, RichText::text)),
            )
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

    let mut column = 0usize;
    while widths.iter().sum::<usize>() < available {
        widths[column] = widths[column].saturating_add(1);
        column = (column + 1) % columns;
    }
    widths
}

fn dense_rule(widths: &[usize]) -> String {
    widths
        .iter()
        .map(|cell_width| "─".repeat(*cell_width))
        .collect::<Vec<_>>()
        .join("─┼─")
}

fn table_line(
    cells: &[RichText],
    widths: &[usize],
    header: bool,
    grid: bool,
    theme: &ThemeConfig,
) -> Line<'static> {
    let mut spans = Vec::new();
    if grid {
        spans.push(Span::styled("│", theme_style(theme, "Border")));
    }
    for (index, width) in widths.iter().copied().enumerate() {
        if index > 0 {
            spans.push(Span::styled(
                if grid { "│" } else { " │ " },
                theme_style(theme, "Border"),
            ));
        }
        let value = cells.get(index).map_or_else(String::new, RichText::text);
        let fitted = fit_cell(&value, width);
        let style = if header {
            theme_style(theme, "Accent").add_modifier(Modifier::BOLD)
        } else {
            theme_style(theme, "Normal")
        };
        if grid {
            spans.push(Span::styled(format!(" {fitted} "), style));
        } else {
            spans.push(Span::styled(fitted, style));
        }
    }
    if grid {
        spans.push(Span::styled("│", theme_style(theme, "Border")));
    }
    Line::from(spans)
}

fn grid_rule(left: char, join: char, right: char, widths: &[usize]) -> String {
    let body = widths
        .iter()
        .map(|width| "─".repeat(width.saturating_add(2)))
        .collect::<Vec<_>>()
        .join(&join.to_string());
    format!("{left}{body}{right}")
}

fn render_image(
    image: &RichImage,
    active_view: RichBlockView,
    views: Vec<RichBlockView>,
    width: usize,
    theme: &ThemeConfig,
) -> RenderedRichBlock {
    let surface = surface_style(theme, "MediaBlock");
    let title = if image.alt.is_empty() {
        "image"
    } else {
        image.alt.as_str()
    };
    let mut lines = vec![block_toolbar(
        title,
        &views,
        active_view,
        width,
        surface,
        theme,
    )];
    let media = if active_view == RichBlockView::Preview {
        for _ in 0..IMAGE_PREVIEW_ROWS {
            lines.push(surface_line("", width, surface));
        }
        Some(RichMedia::Image {
            alt: image.alt.clone(),
            source: image.source.clone(),
            rows: IMAGE_PREVIEW_ROWS,
        })
    } else {
        lines.push(padded_line(
            vec![
                Span::styled("  source  ", theme_style(theme, "Muted")),
                Span::styled(image.source.clone(), theme_style(theme, "Normal")),
            ],
            width,
            surface,
        ));
        None
    };
    RenderedRichBlock {
        lines,
        active_view,
        media,
    }
}

fn block_toolbar(
    label: &str,
    views: &[RichBlockView],
    active_view: RichBlockView,
    width: usize,
    surface: Style,
    theme: &ThemeConfig,
) -> Line<'static> {
    let mut spans = vec![Span::styled(
        format!(" {label} "),
        theme_style(theme, "Muted").add_modifier(Modifier::BOLD),
    )];
    if views.len() > 1 {
        spans.push(Span::styled("  ", theme_style(theme, "Muted")));
        for (index, view) in views.iter().copied().enumerate() {
            if index > 0 {
                spans.push(Span::styled(" ", theme_style(theme, "Muted")));
            }
            spans.push(Span::styled(
                if view == active_view {
                    format!("[{}]", view.label())
                } else {
                    view.label().to_owned()
                },
                if view == active_view {
                    theme_style(theme, "Accent")
                } else {
                    theme_style(theme, "Muted")
                },
            ));
        }
        spans.push(Span::styled(
            "  ·  [ / ] select · v/V view",
            theme_style(theme, "Muted"),
        ));
    }
    padded_line(spans, width, surface)
}

fn styled_rich_text(content: &RichText, base: Style, theme: &ThemeConfig) -> Vec<Span<'static>> {
    content
        .spans
        .iter()
        .map(|span| match span {
            RichSpan::Text(value) => Span::styled(value.clone(), base),
            RichSpan::Strong(value) => {
                Span::styled(value.clone(), base.add_modifier(Modifier::BOLD))
            }
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

fn on_surface(mut style: Style, surface: Style) -> Style {
    if let Some(background) = surface.bg {
        style.bg = Some(background);
    }
    style
}

fn inset_line(line: Line<'static>, margin: usize) -> Line<'static> {
    if margin == 0 {
        return line;
    }
    let style = line.style;
    let mut spans = Vec::with_capacity(line.spans.len() + 1);
    spans.push(Span::raw(" ".repeat(margin)));
    spans.extend(line.spans);
    Line::from(spans).style(style)
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
    let mut value = text.to_owned();
    let used = value.chars().count();
    if used < width {
        value.push_str(&" ".repeat(width - used));
    }
    Line::styled(value, surface)
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

fn fit_cell(value: &str, width: usize) -> String {
    let count = value.chars().count();
    if count <= width {
        let mut output = value.to_owned();
        output.push_str(&" ".repeat(width - count));
        return output;
    }
    if width <= 1 {
        return "…".chars().take(width).collect();
    }
    let mut output = value.chars().take(width - 1).collect::<String>();
    output.push('…');
    output
}

fn heading_style(level: u8, theme: &ThemeConfig) -> Style {
    let group = match level {
        1 => "Accent",
        2 => "Tool",
        3 => "Success",
        4 => "Warning",
        _ => "Muted",
    };
    theme_style(theme, group)
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
    fn heading_bands_form_a_nested_visual_tree() {
        let mut theme = ThemeConfig::default();
        let surface_background = theme.style("Surface").background;
        let normal_background = theme.style("Normal").background;
        theme.set(
            "Heading1",
            phenix_frontend_config::HighlightStyle {
                background: surface_background,
                ..Default::default()
            },
        );
        theme.set(
            "Heading2",
            phenix_frontend_config::HighlightStyle {
                background: normal_background,
                ..Default::default()
            },
        );
        let document = parse_markdown("# Root\n\n## Child");
        let blocks = render_document(&document, 30, &theme, |_| None);
        let root = line_text(&blocks[0].lines[0]);
        let child = line_text(&blocks[1].lines[0]);
        assert_eq!(root.chars().next(), Some(' '));
        assert!(child.starts_with(' '));
        assert_eq!(root.chars().count(), 30);
        assert_eq!(child.chars().count(), 30);
    }

    #[test]
    fn document_rule_runs_across_nearly_the_full_width() {
        let document = parse_markdown("---");
        let blocks = render_document(&document, 50, &ThemeConfig::default(), |_| None);
        assert!(line_text(&blocks[0].lines[0]).chars().count() >= 49);
    }

    #[test]
    fn table_exposes_dense_and_grid_views() {
        let document = parse_markdown("| Name | State |\n| --- | --- |\n| build | green |");
        let blocks = render_document(&document, 40, &ThemeConfig::default(), |_| None);
        assert_eq!(
            document.blocks[0].candidate_views(),
            &[RichBlockView::Dense, RichBlockView::Grid]
        );
        assert_eq!(blocks[0].active_view, RichBlockView::Dense);
    }

    #[test]
    fn grid_table_uses_the_available_width_and_rules_between_values() {
        let document = parse_markdown(
            "| Name | State |\n| --- | --- |\n| build | green |\n| test | pending |",
        );
        let blocks = render_document(&document, 50, &ThemeConfig::default(), |_| {
            Some(RichBlockView::Grid)
        });
        let text = blocks[0].lines.iter().map(line_text).collect::<Vec<_>>();
        assert!(text.iter().filter(|line| line.contains('┼')).count() >= 2);
        let top = text
            .iter()
            .find(|line| line.contains('┌'))
            .expect("top rule");
        assert!(top.chars().count() >= 49);
        assert!(text.iter().all(|line| line.chars().count() <= 50));
    }

    #[test]
    fn code_is_a_full_width_surface_block_with_discoverable_views() {
        let document = parse_markdown("```rust\nfn main() {}\n```");
        let blocks = render_document(&document, 48, &ThemeConfig::default(), |_| None);
        assert_eq!(blocks[0].active_view, RichBlockView::Highlighted);
        assert!(blocks[0]
            .lines
            .iter()
            .all(|line| line_text(line).chars().count() >= 48));
        assert!(line_text(&blocks[0].lines[0]).contains("v/V view"));
    }

    #[test]
    fn mermaid_has_source_highlighted_and_rendered_views() {
        let document = parse_markdown("```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```");
        let blocks = render_document(&document, 50, &ThemeConfig::default(), |_| None);
        assert_eq!(
            document.blocks[0].candidate_views(),
            &[
                RichBlockView::Source,
                RichBlockView::Highlighted,
                RichBlockView::Rendered,
            ]
        );
        assert_eq!(blocks[0].active_view, RichBlockView::Rendered);
        assert!(blocks[0]
            .lines
            .iter()
            .map(line_text)
            .any(|line| line.contains("Start") && line.contains("Done")));
    }

    #[test]
    fn image_preview_reserves_media_rows() {
        let document = parse_markdown("![architecture](./graph.png)");
        let blocks = render_document(&document, 40, &ThemeConfig::default(), |_| None);
        assert!(matches!(blocks[0].media, Some(RichMedia::Image { .. })));
        assert!(blocks[0].lines.len() > usize::from(IMAGE_PREVIEW_ROWS));
    }
}
