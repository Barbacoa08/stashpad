use crate::model::{error, Result};
/// Keep this policy aligned with domain/markdown.ts. Never allow local paths or programs.
pub fn validate_url(source: &str) -> Result<()> {
    if source.is_empty()
        || source.len() > 4096
        || source.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(error(
            "invalid_link",
            "This external link is not supported.",
        ));
    }
    let url = tauri::Url::parse(source)
        .map_err(|_| error("invalid_link", "This external link is not supported."))?;
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err(error(
            "invalid_link",
            "Only HTTP, HTTPS, and mailto links can be opened.",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restrict_external_destinations() {
        for url in [
            "https://example.com/a?q=x",
            "http://example.com",
            "mailto:joe@example.com",
        ] {
            assert!(validate_url(url).is_ok());
        }
        for url in [
            "file:///tmp/x",
            "javascript:alert(1)",
            "data:text/html,x",
            "/tmp/x",
            "//example.com",
            "https://",
            "https://example.com\n",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
        assert!(validate_url(&format!("https://{}", "a".repeat(4096))).is_err());
    }
}
