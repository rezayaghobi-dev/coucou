// Coucou's OpenCode plugin installer.
//
// One file — ~/.config/opencode/plugins/coucou.ts — works in every project.
// The same care as the Claude Code hooks applies here: look, show the exact
// diff, take a dated backup, and write only after an explicit click. A file
// that exists but was not written by Coucou is never overwritten, and
// uninstalling removes only Coucou's plugin.
//
// The plugin source is embedded in the binary at build time, so an installed
// app always writes the plugin that ships with it.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::hooks::{fingerprint, unified_diff};
use crate::time;

/// The plugin that ships with this build of Coucou.
const PLUGIN_SOURCE: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../opencode-plugin/coucou.ts"));

/// Marker that identifies a file written by Coucou, and its version line.
const MARKER: &str = "coucou-opencode-plugin";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeStatus {
    pub installed: bool,
    pub plugin_path: String,
    /// Whether an `opencode` (or `opencode2`) command is on the user's PATH.
    pub opencode_found: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodePreview {
    pub diff: String,
    /// Empty when there is nothing to back up (a fresh install).
    pub backup: String,
    pub plugin_path: String,
    /// Identifies the bytes this diff was computed from; handed back to `write`
    /// so we only ever apply what the user actually looked at.
    pub fingerprint: String,
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn plugin_path() -> PathBuf {
    home().join(".config").join("opencode").join("plugins").join("coucou.ts")
}

/// Reads the current plugin file, if any. Like the Claude Code settings reader,
/// only a missing file means "nothing there" — every other error surfaces,
/// because not knowing is not the same as empty.
fn read_existing() -> Result<Option<String>, String> {
    let path = plugin_path();
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("Can't read {}: {err}", path.display())),
    }
}

fn is_ours(content: &str) -> bool {
    content.contains(MARKER)
}

fn backup_path() -> PathBuf {
    // Down to the second: installing then uninstalling in the same minute must
    // not quietly overwrite the first backup.
    let p = plugin_path();
    p.with_file_name(format!("coucou.ts.bak-{}", time::backup_stamp()))
}

fn preview_for(existing: Option<String>, next: String) -> Result<OpenCodePreview, String> {
    let path = plugin_path();
    let diff = unified_diff(existing.as_deref().unwrap_or_default(), &next);
    let fp = fingerprint(existing.as_ref().map_or(b"", |s| s.as_bytes()));
    Ok(OpenCodePreview {
        diff,
        backup: if existing.is_some() {
            backup_path().to_string_lossy().to_string()
        } else {
            String::new()
        },
        plugin_path: path.to_string_lossy().to_string(),
        fingerprint: fp,
    })
}

/// Is OpenCode available? PATH first — but the app is launched from the
/// desktop and does not source the shell's rc files, so the curl installer's
/// location (`~/.opencode/bin`) and the other usual spots are checked too.
/// A missed detection only ever produced a wrong warning; wrong warnings erode
/// trust in the dot next to them.
fn find_opencode() -> bool {
    if crate::find_on_path("opencode").is_some() || crate::find_on_path("opencode2").is_some() {
        return true;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for candidate in [
            home.join(".opencode/bin/opencode"),
            home.join(".local/bin/opencode"),
            home.join(".bun/bin/opencode"),
        ] {
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

pub fn status() -> OpenCodeStatus {
    let installed = match std::fs::read(plugin_path()) {
        Ok(bytes) => is_ours(&String::from_utf8_lossy(&bytes)),
        Err(_) => false,
    };
    OpenCodeStatus {
        installed,
        plugin_path: plugin_path().to_string_lossy().to_string(),
        opencode_found: find_opencode(),
    }
}

pub fn preview(install: bool) -> Result<OpenCodePreview, String> {
    let existing = read_existing()?;
    match (install, existing) {
        (true, None) => preview_for(None, plugin_source()),
        (true, Some(content)) if !is_ours(&content) => Err(format!(
            "{} exists and wasn't written by Coucou — Coucou won't overwrite it.",
            plugin_path().display()
        )),
        (true, Some(content)) => preview_for(Some(content), plugin_source()),
        (false, None) => Err("The Coucou plugin isn't installed for OpenCode.".into()),
        (false, Some(content)) if !is_ours(&content) => Err(format!(
            "{} wasn't written by Coucou — Coucou won't remove it.",
            plugin_path().display()
        )),
        (false, Some(content)) => preview_for(Some(content), String::new()),
    }
}

fn plugin_source() -> String {
    let mut text = PLUGIN_SOURCE.trim_end().to_string();
    text.push('\n');
    text
}

/// Writes the plugin (or removes it) after taking a dated backup.
///
/// `fingerprint` is the one the preview was computed from. If the file changed
/// in between we stop and make the user look at a fresh diff — the only thing
/// worse than not installing the plugin is silently reverting somebody's edit.
pub fn write(install: bool, expected: &str) -> Result<String, String> {
    let path = plugin_path();
    let existing = read_existing()?;

    let current_fp = fingerprint(existing.as_ref().map_or(b"", |s| s.as_bytes()));
    if current_fp != expected {
        return Err(format!(
            "{} changed since the preview. Nothing was written — review the new diff.",
            path.display()
        ));
    }

    let backup = backup_path();
    if existing.is_some() {
        std::fs::copy(&path, &backup).map_err(|e| format!("backup failed: {e}"))?;
    }

    if install {
        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(dir).map_err(|e| format!("write failed: {e}"))?;
        // Write beside the target and rename over it: a crash or a full disk
        // leaves whatever was there intact rather than half a plugin.
        let temp = path.with_extension(format!("ts.coucou-{}", std::process::id()));
        std::fs::write(&temp, plugin_source().as_bytes())
            .map_err(|e| format!("write failed: {e}"))?;
        if let Err(err) = std::fs::rename(&temp, &path) {
            let _ = std::fs::remove_file(&temp);
            return Err(format!("write failed: {err}"));
        }
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("remove failed: {e}"))?;
    }

    Ok(if existing.is_some() {
        backup.to_string_lossy().to_string()
    } else {
        String::new()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Everything filesystem-shaped lives in one test on purpose: it points
    /// HOME/USERPROFILE at a temp directory, and that is process-wide.
    #[test]
    fn install_preview_write_and_refuse_a_changed_file() {
        // The hooks test points HOME at its own temp dir, process-wide. One of
        // us runs at a time.
        let _guard = crate::hooks::FS_TEST_GUARD.lock().unwrap_or_else(|p| p.into_inner());
        let tmp = std::env::temp_dir().join(format!("coucou-opencode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join(".config/opencode/plugins")).unwrap();
        std::env::set_var("HOME", &tmp);
        std::env::set_var("USERPROFILE", &tmp);

        let path = plugin_path();
        assert!(path.starts_with(&tmp), "the test must not touch the real home");

        // Not installed yet: uninstall refuses, install previews a fresh write.
        assert!(!status().installed);
        assert!(preview(false).is_err());
        let plan = preview(true).expect("fresh install previews");
        assert!(plan.diff.contains(MARKER), "the diff must show the plugin");
        assert!(plan.backup.is_empty(), "nothing to back up yet");

        // Install.
        let backup = write(true, &plan.fingerprint).expect("install should succeed");
        assert!(backup.is_empty());
        assert!(status().installed);

        // A foreign file with the same name is never touched.
        std::fs::write(&path, "// somebody else's plugin\n").unwrap();
        assert!(!status().installed, "foreign content must not read as ours");
        assert!(preview(true).is_err());
        assert!(preview(false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"// somebody else's plugin\n");

        // Back to ours: a stale fingerprint refuses to write.
        std::fs::write(&path, plugin_source()).unwrap();
        let stale = preview(false).unwrap();
        std::fs::write(&path, "// edited since the preview\n").unwrap();
        let err = write(false, &stale.fingerprint).unwrap_err();
        assert!(err.contains("changed since the preview"), "got: {err}");
        assert_eq!(std::fs::read(&path).unwrap(), b"// edited since the preview\n");

        // A fresh preview, then uninstall — only our file goes away. The plugin
        // goes back in first: the "edited since the preview" bytes above look
        // foreign on purpose, and uninstalling a foreign file must refuse.
        std::fs::write(&path, plugin_source()).unwrap();
        let plan = preview(false).unwrap();
        let backup = write(false, &plan.fingerprint).expect("uninstall should succeed");
        assert!(backup.ends_with(".ts") || backup.contains("bak"), "got: {backup}");
        assert!(!path.exists());
        assert!(std::fs::read_to_string(backup).unwrap().contains(MARKER));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn embedded_source_carries_the_marker() {
        assert!(plugin_source().contains(MARKER));
    }
}
