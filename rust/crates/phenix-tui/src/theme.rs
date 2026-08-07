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
        .style(theme_style(theme, surface))
}

fn foreground_style(theme: &ThemeConfig, group: &str) -> Style {
    let mut style = theme_style(theme, group);
    style.bg = None;
    style
}

pub(crate) fn theme_style(theme: &ThemeConfig, group: &str) -> Style {
    let group = if group == "SurfaceFocused" && !theme.highlights.contains_key(group) {
        "Surface"
    } else {
        group
    };
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
    fn semantic_theme_groups_map_to_ratatui_styles() {
        let style = theme_style(&ThemeConfig::default(), "Accent");
        assert!(style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn focused_surface_falls_back_to_surface_for_older_themes() {
        let theme = ThemeConfig::default();
        assert_eq!(
            theme_style(&theme, "SurfaceFocused"),
            theme_style(&theme, "Surface")
        );
    }
}
