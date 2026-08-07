use base64::Engine;
use image::DynamicImage;
use ratatui::layout::{Rect, Size};
use ratatui::Frame;
use ratatui_image::picker::Picker;
use ratatui_image::protocol::Protocol;
use ratatui_image::{Image, Resize};
use std::collections::HashMap;
use std::path::Path;

const MAX_CACHED_PROTOCOLS: usize = 48;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ImageCacheKey {
    source: String,
    width: u16,
    height: u16,
}

pub(crate) struct TranscriptImageRenderer {
    picker: Picker,
    protocols: HashMap<ImageCacheKey, Protocol>,
}

impl TranscriptImageRenderer {
    /// Query graphics capabilities after Ratatui has entered the alternate screen,
    /// but before the terminal input thread starts. Halfblocks are a deterministic
    /// fallback when the terminal does not answer capability queries.
    pub fn initialize() -> Self {
        Self {
            picker: Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks()),
            protocols: HashMap::new(),
        }
    }

    pub fn reset(&mut self) {
        self.protocols.clear();
        self.picker = Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks());
    }

    pub fn render(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        source: &str,
    ) -> Result<(), String> {
        if area.width == 0 || area.height == 0 {
            return Ok(());
        }

        let key = ImageCacheKey {
            source: source.to_owned(),
            width: area.width,
            height: area.height,
        };
        if !self.protocols.contains_key(&key) {
            if self.protocols.len() >= MAX_CACHED_PROTOCOLS {
                self.protocols.clear();
            }
            let decoded = decode_image(source)?;
            let protocol = self
                .picker
                .new_protocol(
                    decoded,
                    Size::new(area.width, area.height),
                    Resize::Fit(None),
                )
                .map_err(|error| error.to_string())?;
            self.protocols.insert(key.clone(), protocol);
        }

        let protocol = self
            .protocols
            .get(&key)
            .ok_or_else(|| "image protocol cache lost the inserted entry".to_owned())?;
        if protocol.needs_placeholder(area).is_none() {
            frame.render_widget(Image::new(protocol).allow_clipping(true), area);
        }
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
