use phenix_frontend_config::{ColorSpec, HighlightStyle, NamedColor, ThemeConfig};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::{Block, Borders};

pub(crate) fn panel(title: &str, focused: bool, theme: &ThemeConfig) -> Block<'static> {
    let surface = if focused { "SurfaceFocused" } else { "Surface" };
    Block::default()
        .borders(Borders::TOP)
        .title(Span::styled(
            format!(" {title} "),
            foreground_style(theme, if focused { "Accent" } else { "Muted" }),
        ))
        .border_style(foreground_style(
            theme,
            if focused { "BorderFocused" } else { "Border" },
        ))
        .style(surface_style(theme, surface))
}

fn foreground_style(theme: &ThemeConfig, group: &str) -> Style {
    theme_style(theme, group)
}

/// Resolve a semantic text style. Text always inherits the rectangular surface
/// underneath it; backgrounds are exclusively the responsibility of
/// `surface_style`.
pub(crate) fn theme_style(theme: &ThemeConfig, group: &str) -> Style {
    let mut style = raw_theme_style(theme, group);
    style.bg = None;
    style
}

/// Resolve a style for an actual rectangular surface.
///
/// Rich transcript surfaces have canonical derived defaults when a theme does
/// not override them explicitly:
/// - `UserMessage`: raised surface using the border/surface0 color
/// - `CodeBlock` / `MediaBlock`: crust-like canvas using `Normal`
///
/// A theme can override any of these groups explicitly.
pub(crate) fn surface_style(theme: &ThemeConfig, group: &str) -> Style {
    let explicit = raw_theme_style(theme, group);
    if explicit.bg.is_some() || matches!(group, "Normal" | "Surface" | "SurfaceFocused") {
        return explicit;
    }
    match group {
        "UserMessage" => {
            let mut style = raw_theme_style(theme, "Surface");
            style.bg = raw_theme_style(theme, "Border").fg;
            style
        }
        "CodeBlock" | "MediaBlock" => raw_theme_style(theme, "Normal"),
        _ => explicit,
    }
}

fn raw_theme_style(theme: &ThemeConfig, group: &str) -> Style {
    let HighlightStyle {
        foreground,
        background,
        bold,
        italic,
        underline,
        reversed,
    } = theme.style(group);
    let mut style = Style::default();
    if let Some(foreground) = foreground {
        style = style.fg(ratatui_color(foreground));
    }
    if let Some(background) = background {
        style = style.bg(ratatui_color(background));
    }
    let mut modifiers = Modifier::empty();
    if bold {
        modifiers |= Modifier::BOLD;
    }
    if italic {
        modifiers |= Modifier::ITALIC;
    }
    if underline {
        modifiers |= Modifier::UNDERLINED;
    }
    if reversed {
        modifiers |= Modifier::REVERSED;
    }
    style.add_modifier(modifiers)
}

fn ratatui_color(color: ColorSpec) -> Color {
    match color {
        ColorSpec::Default => Color::Reset,
        ColorSpec::Rgb { red, green, blue } => Color::Rgb(red, green, blue),
        ColorSpec::Indexed(index) => Color::Indexed(index),
        ColorSpec::Named(named) => match named {
            NamedColor::Black => Color::Black,
            NamedColor::Red => Color::Red,
            NamedColor::Green => Color::Green,
            NamedColor::Yellow => Color::Yellow,
            NamedColor::Blue => Color::Blue,
            NamedColor::Magenta => Color::Magenta,
            NamedColor::Cyan => Color::Cyan,
            NamedColor::White => Color::White,
            NamedColor::Gray => Color::Gray,
            NamedColor::DarkGray => Color::DarkGray,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_text_styles_do_not_paint_surface_backgrounds() {
        let theme = ThemeConfig::default();
        assert_eq!(theme_style(&theme, "Accent").bg, None);
        assert_eq!(theme_style(&theme, "Normal").bg, None);
        assert_eq!(theme_style(&theme, "Surface").bg, None);
    }

    #[test]
    fn explicit_surfaces_keep_their_background() {
        let style = surface_style(&ThemeConfig::default(), "Surface");
        assert!(style.bg.is_some());
    }

    #[test]
    fn rich_block_surfaces_have_distinct_backgrounds() {
        let theme = ThemeConfig::default();
        assert_ne!(
            surface_style(&theme, "UserMessage").bg,
            surface_style(&theme, "Surface").bg
        );
        assert_ne!(
            surface_style(&theme, "CodeBlock").bg,
            surface_style(&theme, "Surface").bg
        );
    }
}
