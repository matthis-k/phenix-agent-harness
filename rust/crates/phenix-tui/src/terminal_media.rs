use base64::Engine;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

const KITTY_CHUNK_BYTES: usize = 4096;
const IMAGE_ID_BASE: u32 = 0x5048_0000;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TerminalImagePlacement {
    pub x: u16,
    pub y: u16,
    pub columns: u16,
    pub rows: u16,
    pub source: String,
}

#[derive(Debug)]
pub(crate) struct TerminalMediaRenderer {
    kitty: bool,
    image_ids: Vec<u32>,
}

impl Default for TerminalMediaRenderer {
    fn default() -> Self {
        Self {
            kitty: kitty_graphics_enabled(),
            image_ids: Vec::new(),
        }
    }
}

impl TerminalMediaRenderer {
    pub fn render(&mut self, placements: &[TerminalImagePlacement]) -> io::Result<()> {
        if !self.kitty {
            return Ok(());
        }
        let stdout = io::stdout();
        let mut output = stdout.lock();
        self.clear_with(&mut output)?;

        for (index, placement) in placements.iter().enumerate() {
            let Some(payload) = png_payload(&placement.source) else {
                continue;
            };
            let Some(image_id) =
                IMAGE_ID_BASE.checked_add(u32::try_from(index).unwrap_or(u32::MAX))
            else {
                continue;
            };
            if image_id == 0 {
                continue;
            }
            write!(
                output,
                "\x1b[s\x1b[{};{}H",
                placement.y.saturating_add(1),
                placement.x.saturating_add(1)
            )?;
            send_png(
                &mut output,
                image_id,
                placement.columns.max(1),
                placement.rows.max(1),
                &payload,
            )?;
            output.write_all(b"\x1b[u")?;
            self.image_ids.push(image_id);
        }
        output.flush()
    }

    pub fn clear(&mut self) -> io::Result<()> {
        if !self.kitty || self.image_ids.is_empty() {
            return Ok(());
        }
        let stdout = io::stdout();
        let mut output = stdout.lock();
        self.clear_with(&mut output)?;
        output.flush()
    }

    fn clear_with(&mut self, output: &mut impl Write) -> io::Result<()> {
        for image_id in self.image_ids.drain(..) {
            write!(output, "\x1b_Ga=d,d=I,i={image_id},q=2\x1b\\")?;
        }
        Ok(())
    }
}

fn send_png(
    output: &mut impl Write,
    image_id: u32,
    columns: u16,
    rows: u16,
    payload: &str,
) -> io::Result<()> {
    let chunks = payload
        .as_bytes()
        .chunks(KITTY_CHUNK_BYTES)
        .collect::<Vec<_>>();
    if chunks.is_empty() {
        return Ok(());
    }
    for (index, chunk) in chunks.iter().enumerate() {
        let more = usize::from(index + 1 < chunks.len());
        if index == 0 {
            write!(
                output,
                "\x1b_Ga=T,f=100,t=d,i={image_id},c={columns},r={rows},C=1,q=2,m={more};"
            )?;
        } else {
            write!(output, "\x1b_Gq=2,m={more};")?;
        }
        output.write_all(chunk)?;
        output.write_all(b"\x1b\\")?;
    }
    Ok(())
}

fn png_payload(source: &str) -> Option<String> {
    if let Some(payload) = source.strip_prefix("data:image/png;base64,") {
        return valid_base64(payload).then(|| payload.to_owned());
    }

    let path = source.strip_prefix("file://").unwrap_or(source);
    let path = Path::new(path);
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
    {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn valid_base64(payload: &str) -> bool {
    !payload.is_empty()
        && payload.len().is_multiple_of(4)
        && payload
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

fn kitty_graphics_enabled() -> bool {
    match env::var("PHENIX_TERMINAL_IMAGES") {
        Ok(value) if value.eq_ignore_ascii_case("off") => return false,
        Ok(value) if value.eq_ignore_ascii_case("kitty") => return true,
        _ => {}
    }
    if env::var_os("KITTY_WINDOW_ID").is_some() || env::var_os("GHOSTTY_RESOURCES_DIR").is_some() {
        return true;
    }
    env::var("TERM")
        .ok()
        .is_some_and(|term| term.to_ascii_lowercase().contains("kitty"))
        || env::var("TERM_PROGRAM")
            .ok()
            .is_some_and(|program| program.eq_ignore_ascii_case("ghostty"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_uri_png_payload_is_reused_without_decoding() {
        assert_eq!(
            png_payload("data:image/png;base64,Zm9v"),
            Some("Zm9v".to_owned())
        );
        assert_eq!(png_payload("data:image/jpeg;base64,Zm9v"), None);
    }

    #[test]
    fn kitty_png_is_chunked_without_oversized_payloads() {
        let payload = "A".repeat(KITTY_CHUNK_BYTES * 2 + 4);
        let mut output = Vec::new();
        send_png(&mut output, 42, 20, 8, &payload).expect("kitty encoding");
        let rendered = String::from_utf8(output).expect("ascii protocol");
        assert!(rendered.contains("a=T,f=100,t=d,i=42,c=20,r=8,C=1,q=2,m=1"));
        assert!(rendered.ends_with("m=0;AAAA\u{1b}\\"));
    }
}
