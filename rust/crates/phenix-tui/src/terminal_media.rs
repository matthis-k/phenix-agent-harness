use base64::Engine;
use image::DynamicImage;
use ratatui::backend::{Backend, CrosstermBackend};
use ratatui::buffer::Buffer;
use ratatui::crossterm::{cursor, execute};
use ratatui::layout::{Rect, Size};
use ratatui::widgets::Widget;
use ratatui_image::picker::Picker;
use ratatui_image::protocol::Protocol;
use ratatui_image::{Image, Resize};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::path::Path;

const MAX_CACHED_PROTOCOLS: usize = 48;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TerminalImagePlacement {
    pub x: u16,
    pub y: u16,
    pub columns: u16,
    pub rows: u16,
    pub source: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ImageCacheKey {
    source: String,
    columns: u16,
    rows: u16,
}

pub(crate) struct TerminalMediaRenderer {
    picker: Picker,
    protocols: HashMap<ImageCacheKey, Protocol>,
    failed: HashSet<ImageCacheKey>,
}

impl Default for TerminalMediaRenderer {
    fn default() -> Self {
        // `RatatuiRenderer::initialize` creates this after entering the alternate
        // screen and before the terminal event reader starts, which is exactly the
        // safe query window required by ratatui-image.
        Self {
            picker: Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks()),
            protocols: HashMap::new(),
            failed: HashSet::new(),
        }
    }
}

impl TerminalMediaRenderer {
    /// Render rich-media placements through ratatui-image. The transcript reserves
    /// these cells in the normal Ratatui frame, then this adapter draws the image
    /// buffer into the same terminal surface. Protocol detection/encoding is fully
    /// delegated to ratatui-image (Kitty, Sixel, iTerm2 or halfblocks).
    pub fn render(&mut self, placements: &[TerminalImagePlacement]) -> io::Result<()> {
        let mut stdout = io::stdout();
        execute!(stdout, cursor::SavePosition)?;
        {
            let mut backend = CrosstermBackend::new(&mut stdout);
            for placement in placements {
                self.render_placement(&mut backend, placement)?;
            }
            backend.flush()?;
        }
        execute!(stdout, cursor::RestorePosition)?;
        stdout.flush()
    }

    /// Clearing no longer emits protocol-specific deletion escape sequences.
    /// The normal Ratatui frame redraw owns the surface; the image widget marks
    /// protocol-covered cells appropriately and the next frame replaces them.
    pub fn clear(&mut self) -> io::Result<()> {
        self.protocols.clear();
        self.failed.clear();
        Ok(())
    }

    fn render_placement<W: Write>(
        &mut self,
        backend: &mut CrosstermBackend<W>,
        placement: &TerminalImagePlacement,
    ) -> io::Result<()> {
        if placement.columns == 0 || placement.rows == 0 {
            return Ok(());
        }
        let key = ImageCacheKey {
            source: placement.source.clone(),
            columns: placement.columns,
            rows: placement.rows,
        };
        if self.failed.contains(&key) {
            return Ok(());
        }
        if !self.protocols.contains_key(&key) {
            if self.protocols.len() >= MAX_CACHED_PROTOCOLS {
                self.protocols.clear();
                self.failed.clear();
            }
            let protocol = decode_image(&placement.source).and_then(|image| {
                self.picker
                    .new_protocol(
                        image,
                        Size::new(placement.columns, placement.rows),
                        Resize::Fit(None),
                    )
                    .map_err(|error| error.to_string())
            });
            match protocol {
                Ok(protocol) => {
                    self.protocols.insert(key.clone(), protocol);
                }
                Err(_) => {
                    // A missing local file, unsupported remote URL or malformed
                    // payload is a media-preview failure, not a fatal UI error.
                    // Metadata view still exposes the source for inspection.
                    self.failed.insert(key);
                    return Ok(());
                }
            }
        }

        let protocol = self
            .protocols
            .get(&key)
            .expect("cached protocol exists after insertion");
        let area = Rect::new(
            placement.x,
            placement.y,
            placement.columns,
            placement.rows,
        );
        if protocol.needs_placeholder(area).is_some() {
            return Ok(());
        }

        let mut buffer = Buffer::empty(area);
        Image::new(protocol)
            .allow_clipping(true)
            .render(area, &mut buffer);
        backend.draw(
            area.positions()
                .zip(buffer.content.iter())
                .map(|(position, cell)| (position.x, position.y, cell)),
        )?;
        Ok(())
    }
}

fn decode_image(source: &str) -> Result<DynamicImage, String> {
    if let Some(data) = source.strip_prefix("data:") {
        let (metadata, payload) = data
            .split_once(',')
            .ok_or_else(|| "invalid image data URI".to_owned())?;
        if !metadata.starts_with("image/") || !metadata.ends_with(";base64") {
            return Err("only base64 image data URIs are supported".to_owned());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .map_err(|error| format!("invalid image base64: {error}"))?;
        return image::load_from_memory(&bytes)
            .map_err(|error| format!("cannot decode transcript image: {error}"));
    }

    if source.starts_with("http://") || source.starts_with("https://") {
        return Err("remote transcript images are not fetched by the TUI".to_owned());
    }
    let path = source.strip_prefix("file://").unwrap_or(source);
    image::open(Path::new(path))
        .map_err(|error| format!("cannot open transcript image {path}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_uri_decoder_accepts_standard_acp_image_payloads() {
        // 1x1 transparent PNG.
        let source = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2WQAAAABJRU5ErkJggg==";
        let image = decode_image(source).expect("PNG data URI");
        assert_eq!(image.width(), 1);
        assert_eq!(image.height(), 1);
    }

    #[test]
    fn remote_images_are_not_implicitly_network_fetched() {
        assert!(decode_image("https://example.test/image.png")
            .expect_err("remote source must be rejected")
            .contains("not fetched"));
    }
}
