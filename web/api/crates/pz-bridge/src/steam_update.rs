//! Reader for the game server's boot-time update report.
//!
//! `steam-update-check.sh` writes `.update_status` into the shared data
//! directory on every boot. It is the only place a failed SteamCMD update
//! shows up: the base image reports success either way, and a stale build is
//! indistinguishable from a healthy one from the outside.
//!
//! Like every reader here, a missing or unreadable file is a state, not an
//! error — and specifically a state that must never read as "broken", or a
//! fresh install would look condemned before it has booted once.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// What the last boot concluded about the install.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateVerdict {
    /// Installed build matches what Steam expects.
    Ok,
    /// Steam knows a newer build exists and this install does not have it.
    /// Clients that auto-updated cannot join.
    Behind,
    /// Steam flagged the install as needing an update.
    UpdateRequired,
    /// The pinned depot manifest was retired. Retries cannot recover; only a
    /// clean reinstall of the game directory does.
    ManifestRetired,
    /// No game binary at all.
    Missing,
    /// The manifest is there but could not be read well enough to judge.
    /// Boots, but must not read as healthy - losing the ability to detect a
    /// stale build is itself the failure this change exists to surface.
    Unverifiable,
    /// No report yet, or one this build does not understand.
    #[default]
    Unknown,
}

impl UpdateVerdict {
    /// Whether the server can actually serve players.
    ///
    /// `Unknown` counts as healthy on purpose: absence of evidence is not
    /// evidence of a broken install.
    pub fn is_healthy(self) -> bool {
        matches!(self, Self::Ok | Self::Unknown)
    }

    fn from_tag(tag: &str) -> Self {
        match tag {
            "ok" => Self::Ok,
            "behind" => Self::Behind,
            "update_required" => Self::UpdateRequired,
            "manifest_retired" => Self::ManifestRetired,
            "missing" => Self::Missing,
            "unverifiable" => Self::Unverifiable,
            _ => Self::Unknown,
        }
    }
}

/// Deserialised as written by the script. Every field is optional so a report
/// from a newer script still parses.
#[derive(Debug, Default, Deserialize)]
struct RawReport {
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    installed_build: Option<String>,
    #[serde(default)]
    target_build: Option<String>,
    #[serde(default)]
    state_flags: Option<i64>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    pinned_manifest: Option<String>,
    #[serde(default)]
    last_updated: Option<i64>,
    #[serde(default)]
    checked_at: Option<i64>,
    #[serde(default)]
    booted: bool,
    #[serde(default)]
    auto_repaired: bool,
    #[serde(default)]
    diagnosis: Option<String>,
}

/// The full report. Staff-only — `diagnosis` can name filesystem paths and
/// echo SteamCMD errors.
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateReport {
    pub verdict: UpdateVerdict,
    pub installed_build: Option<String>,
    pub target_build: Option<String>,
    pub state_flags: Option<i64>,
    pub branch: Option<String>,
    pub pinned_manifest: Option<String>,
    pub last_updated: Option<i64>,
    pub checked_at: Option<i64>,
    /// Whether the check let the server start. `false` with a non-`Ok` verdict
    /// means the container is up but deliberately holding the game down —
    /// which from outside looks identical to a slow world load.
    pub booted: bool,
    pub auto_repaired: bool,
    pub diagnosis: Option<String>,
}

/// The subset that is safe on an unauthenticated endpoint.
///
/// Build ids are public Steam data. The diagnosis is not.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PublicUpdate {
    pub verdict: UpdateVerdict,
    pub healthy: bool,
    pub installed_build: Option<String>,
    pub target_build: Option<String>,
}

impl UpdateReport {
    /// Read the report, or a default `Unknown` one when it is absent or
    /// unreadable. Never returns an error.
    pub async fn read(path: impl AsRef<Path>) -> Self {
        match tokio::fs::read_to_string(path.as_ref()).await {
            Ok(contents) => Self::parse(&contents),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(source) => {
                tracing::warn!(%source, "update report unreadable");
                Self::default()
            }
        }
    }

    fn parse(contents: &str) -> Self {
        let raw: RawReport = match serde_json::from_str(contents) {
            Ok(raw) => raw,
            Err(source) => {
                tracing::warn!(%source, "update report is not valid JSON");
                return Self::default();
            }
        };

        Self {
            verdict: UpdateVerdict::from_tag(&raw.verdict),
            installed_build: raw.installed_build,
            target_build: raw.target_build,
            state_flags: raw.state_flags,
            branch: raw.branch,
            pinned_manifest: raw.pinned_manifest,
            last_updated: raw.last_updated,
            checked_at: raw.checked_at,
            booted: raw.booted,
            auto_repaired: raw.auto_repaired,
            diagnosis: raw.diagnosis,
        }
    }

    /// The view safe for players and for unauthenticated monitoring.
    pub fn public(&self) -> PublicUpdate {
        PublicUpdate {
            verdict: self.verdict,
            healthy: self.verdict.is_healthy(),
            installed_build: self.installed_build.clone(),
            target_build: self.target_build.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BEHIND: &str = r#"{"verdict":"behind","installed_build":"24775771",
"target_build":"24801442","state_flags":6,"branch":"public",
"pinned_manifest":"4041863939978451180","last_updated":1787089316,
"checked_at":1787100000,"booted":false,"auto_repaired":true,
"diagnosis":"Installed build 24775771, but Steam expects 24801442."}"#;

    #[test]
    fn parses_a_full_report() {
        let report = UpdateReport::parse(BEHIND);

        assert_eq!(report.verdict, UpdateVerdict::Behind);
        assert_eq!(report.installed_build.as_deref(), Some("24775771"));
        assert_eq!(report.target_build.as_deref(), Some("24801442"));
        assert_eq!(report.state_flags, Some(6));
        assert!(report.auto_repaired);
        assert!(!report.booted);
        assert!(report.diagnosis.is_some());
    }

    #[test]
    fn absent_report_is_unknown_and_not_an_error() {
        let report = UpdateReport::default();

        assert_eq!(report.verdict, UpdateVerdict::Unknown);
        assert!(report.verdict.is_healthy());
    }

    #[test]
    fn garbage_does_not_panic_or_condemn_the_server() {
        let report = UpdateReport::parse("not json at all");

        assert_eq!(report.verdict, UpdateVerdict::Unknown);
        assert!(report.verdict.is_healthy());
    }

    /// Boots, but is not healthy. If this ever flips to healthy, a corrupt
    /// manifest goes back to booting stale in silence.
    #[test]
    fn unverifiable_boots_but_is_not_healthy() {
        let report = UpdateReport::parse(r#"{"verdict":"unverifiable","booted":true}"#);

        assert_eq!(report.verdict, UpdateVerdict::Unverifiable);
        assert!(report.booted);
        assert!(!report.verdict.is_healthy());
    }

    /// A newer script may grow a verdict this build has never heard of. That
    /// must not read as a failure, or a panel upgrade lag would take the
    /// server offline in the UI for no reason.
    #[test]
    fn unrecognised_verdict_falls_back_to_unknown() {
        let report = UpdateReport::parse(r#"{"verdict":"something_new"}"#);

        assert_eq!(report.verdict, UpdateVerdict::Unknown);
    }

    /// The public shape must never carry the diagnosis: `/health/detailed` is
    /// unauthenticated in this stack.
    #[test]
    fn public_view_drops_the_diagnosis() {
        let public = UpdateReport::parse(BEHIND).public();

        assert_eq!(public.verdict, UpdateVerdict::Behind);
        assert!(!public.healthy);
        assert_eq!(public.installed_build.as_deref(), Some("24775771"));

        let json = serde_json::to_string(&public).expect("serialises");
        assert!(!json.contains("diagnosis"));
        assert!(!json.contains("Steam expects"));
    }

    /// Verbatim line emitted by `steam-update-check.sh` on a healthy boot.
    /// Regression guard against the report shape drifting out from under the
    /// hand-written `parses_a_full_report` fixture above.
    #[test]
    fn parses_the_real_ok_report_verbatim() {
        let report = UpdateReport::parse(
            r#"{"verdict":"ok","installed_build":"24775771","target_build":"24775771","state_flags":4,"branch":"public","pinned_manifest":"4041863939978451180","last_updated":1787089316,"checked_at":1787172724,"booted":true,"auto_repaired":false,"diagnosis":"Installed build 24775771 matches what Steam expects."}"#,
        );

        assert_eq!(report.verdict, UpdateVerdict::Ok);
        assert!(report.verdict.is_healthy());
        assert_eq!(report.installed_build.as_deref(), Some("24775771"));
        assert_eq!(report.target_build.as_deref(), Some("24775771"));
        assert_eq!(report.state_flags, Some(4));
        assert_eq!(report.branch.as_deref(), Some("public"));
        assert_eq!(
            report.pinned_manifest.as_deref(),
            Some("4041863939978451180")
        );
        assert_eq!(report.last_updated, Some(1787089316));
        assert_eq!(report.checked_at, Some(1787172724));
        assert!(report.booted);
        assert!(!report.auto_repaired);
    }

    /// Verbatim line emitted when the manifest could not be parsed: every
    /// field the script could not determine is explicit JSON `null`, not
    /// merely absent. This is the shape that would blow up a field typed as
    /// `String` instead of `Option<String>` - the sparse fixtures elsewhere
    /// in this file (missing keys, defaulted by serde) do not exercise that.
    #[test]
    fn parses_the_real_unverifiable_report_with_null_fields() {
        let report = UpdateReport::parse(
            r#"{"verdict":"unverifiable","installed_build":null,"target_build":null,"state_flags":null,"branch":"public","pinned_manifest":null,"last_updated":null,"checked_at":1787172871,"booted":true,"auto_repaired":false,"diagnosis":"The install could not be verified: the manifest could not be parsed..."}"#,
        );

        assert_eq!(report.verdict, UpdateVerdict::Unverifiable);
        assert!(!report.verdict.is_healthy());
        assert_eq!(report.installed_build, None);
        assert_eq!(report.target_build, None);
        assert_eq!(report.state_flags, None);
        assert_eq!(report.branch.as_deref(), Some("public"));
        assert_eq!(report.pinned_manifest, None);
        assert_eq!(report.last_updated, None);
        assert_eq!(report.checked_at, Some(1787172871));
        assert!(report.booted);
        assert!(!report.auto_repaired);
        assert!(report.diagnosis.is_some());

        // The public view must serialise cleanly even when every build id is
        // null, and must still withhold the diagnosis.
        let public = report.public();
        assert_eq!(public.installed_build, None);
        assert_eq!(public.target_build, None);
        let json = serde_json::to_string(&public).expect("serialises");
        assert!(!json.contains("diagnosis"));
    }
}
