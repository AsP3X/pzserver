//! Sign in with Steam, which is OpenID 2.0 and not OAuth.
//!
//! Steam never adopted OpenID Connect, so there is no token exchange and no
//! client secret — which is why this needs no registration and no API key. The
//! flow is:
//!
//! 1. send the browser to [`authenticate_url`]
//! 2. Steam sends it back to our `return_to` with a pile of `openid.*` params
//! 3. we post those params straight back to Steam with `mode=check_authentication`
//! 4. Steam answers `is_valid:true`, and only then is the claimed id real
//!
//! Step 3 is the whole security model. The `openid.claimed_id` in the redirect
//! is attacker-controlled until Steam confirms the signature over it, so it
//! must never be trusted on its own.

use std::collections::BTreeMap;
use std::time::Duration;

pub const OPENID_ENDPOINT: &str = "https://steamcommunity.com/openid/login";

/// Steam identifies users by a 17-digit SteamID64.
const STEAM_ID_LENGTH: usize = 17;

const CLAIMED_ID_PREFIX: &str = "https://steamcommunity.com/openid/id/";

#[derive(Debug, thiserror::Error)]
pub enum SteamError {
    #[error("steam could not be reached: {0}")]
    Request(#[from] reqwest::Error),

    #[error("the sign-in response was not from a completed Steam login")]
    NotAnAssertion,

    #[error("steam rejected the sign-in")]
    Rejected,

    #[error("steam returned an id that is not a SteamID64")]
    BadIdentity,
}

/// Where to send the browser to start a Steam login.
///
/// `realm` is the origin the login is scoped to and must be a prefix of
/// `return_to`, or Steam refuses the request.
pub fn authenticate_url(realm: &str, return_to: &str) -> String {
    let params = [
        ("openid.ns", "http://specs.openid.net/auth/2.0"),
        ("openid.mode", "checkid_setup"),
        (
            "openid.identity",
            "http://specs.openid.net/auth/2.0/identifier_select",
        ),
        (
            "openid.claimed_id",
            "http://specs.openid.net/auth/2.0/identifier_select",
        ),
        ("openid.realm", realm),
        ("openid.return_to", return_to),
    ];

    let query = params
        .iter()
        .map(|(key, value)| format!("{}={}", key, urlencode(value)))
        .collect::<Vec<_>>()
        .join("&");

    format!("{OPENID_ENDPOINT}?{query}")
}

/// Percent-encode, keeping only the unreserved set from RFC 3986.
///
/// Hand-rolled rather than pulled in: the only inputs are our own URLs and the
/// fixed strings above, and this avoids a dependency for six call sites.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());

    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }

    out
}

/// Talks to Steam's OpenID endpoint.
///
/// Owns the HTTP client so that `reqwest` stays an implementation detail of
/// this crate, the same way [`crate::docker::DockerClient`] does.
#[derive(Debug, Clone, Default)]
pub struct SteamClient {
    http: reqwest::Client,
}

impl SteamClient {
    pub fn new() -> Self {
        Self::default()
    }

    /// Ask Steam whether it really signed this assertion, and for whom.
    pub async fn verify(&self, params: &BTreeMap<String, String>) -> Result<String, SteamError> {
        verify(&self.http, params).await
    }
}

/// Ask Steam whether it really signed this assertion, and for whom.
///
/// `params` is the query string Steam redirected back with, already parsed.
/// Every `openid.*` key is echoed back untouched apart from `mode`, because
/// the signature covers fields we do not interpret.
async fn verify(
    client: &reqwest::Client,
    params: &BTreeMap<String, String>,
) -> Result<String, SteamError> {
    if params.get("openid.mode").map(String::as_str) != Some("id_res") {
        return Err(SteamError::NotAnAssertion);
    }

    // Encoded by hand rather than with reqwest's `form`, which needs the
    // `urlencoded` feature this crate does not enable. The encoder above is
    // already here for the redirect URL.
    let mut pairs: Vec<String> = params
        .iter()
        .filter(|(key, _)| key.starts_with("openid.") && key.as_str() != "openid.mode")
        .map(|(key, value)| format!("{}={}", urlencode(key), urlencode(value)))
        .collect();

    pairs.push("openid.mode=check_authentication".to_owned());

    let body = client
        .post(OPENID_ENDPOINT)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .body(pairs.join("&"))
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    if !is_valid(&body) {
        return Err(SteamError::Rejected);
    }

    let claimed = params
        .get("openid.claimed_id")
        .ok_or(SteamError::BadIdentity)?;

    steam_id_from(claimed).ok_or(SteamError::BadIdentity)
}

/// Steam answers with a tiny key-value document, one pair per line.
///
/// Matched line by line rather than with `contains`, so a response that merely
/// mentions the string somewhere cannot be read as approval.
fn is_valid(body: &str) -> bool {
    body.lines()
        .map(str::trim)
        .any(|line| line == "is_valid:true")
}

/// Pull the SteamID64 out of a claimed identity URL.
fn steam_id_from(claimed_id: &str) -> Option<String> {
    let id = claimed_id.strip_prefix(CLAIMED_ID_PREFIX)?;

    if id.len() == STEAM_ID_LENGTH && id.bytes().all(|byte| byte.is_ascii_digit()) {
        Some(id.to_owned())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_authenticate_url_carries_the_openid_handshake() {
        let url = authenticate_url(
            "https://knox.example",
            "https://knox.example/api/v1/auth/steam/callback",
        );

        assert!(url.starts_with(OPENID_ENDPOINT));
        assert!(url.contains("openid.mode=checkid_setup"));
        assert!(url.contains("openid.realm=https%3A%2F%2Fknox.example"));
        assert!(url.contains("identifier_select"));
    }

    #[test]
    fn urlencoding_escapes_everything_outside_the_unreserved_set() {
        assert_eq!(
            urlencode("https://a.example/b?c=d&e"),
            "https%3A%2F%2Fa.example%2Fb%3Fc%3Dd%26e"
        );
        assert_eq!(urlencode("plain-Text_1.0~"), "plain-Text_1.0~");
        assert_eq!(urlencode("a b"), "a%20b");
    }

    #[test]
    fn a_claimed_id_yields_its_steam_id() {
        assert_eq!(
            steam_id_from("https://steamcommunity.com/openid/id/76561197960287930"),
            Some("76561197960287930".to_owned()),
        );
    }

    /// The claimed id is attacker-controlled until Steam signs off on it, so
    /// anything that is not exactly a SteamID64 under Steam's own prefix has to
    /// be refused rather than coerced into something plausible.
    #[test]
    fn a_claimed_id_from_anywhere_else_is_refused() {
        for hostile in [
            "https://evil.example/openid/id/76561197960287930",
            "http://steamcommunity.com/openid/id/76561197960287930",
            "https://steamcommunity.com/openid/id/765611979602879",
            "https://steamcommunity.com/openid/id/7656119796028793x",
            "https://steamcommunity.com/openid/id/",
            "76561197960287930",
        ] {
            assert_eq!(
                steam_id_from(hostile),
                None,
                "{hostile} must not be accepted"
            );
        }
    }

    #[test]
    fn only_an_exact_is_valid_line_counts_as_approval() {
        assert!(is_valid(
            "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n"
        ));
        assert!(is_valid("is_valid:true"));

        assert!(!is_valid("is_valid:false"));
        assert!(!is_valid(""));
        // A rejection that happens to mention the string must not pass.
        assert!(!is_valid(
            "error:is_valid:true is not what happened\nis_valid:false"
        ));
        assert!(!is_valid("is_valid:truex"));
    }
}
