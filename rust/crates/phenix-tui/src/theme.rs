use phenix_frontend_config::{ColorSpec, HighlightStyle, NamedColor, ThemeConfig};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::{Block, Borders};

pub(crate) fn panel(title: &str, focused: bool, theme: &ThemeConfig) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            format!(" {title} "),
            theme_style(theme, if focused { "Accent" } else { "Muted" }),
        ))
        .border_style(theme_style(
            theme,
            if focused { "BorderFocused" } else { "Border" },
        ))
        .style(theme_style(theme, "Normal"))
}

pub(crate) fn theme_style(theme: &ThemeConfig, group: &str) -> Style {
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
}
