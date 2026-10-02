// Who we are, for the relay socket name.
// Uses UID/username to keep accounts separate on the same machine.
// Kept as a small utility module; not all of it is wired up yet.
#![allow(dead_code)]

use std::process::Command;

/// Returns a unique identifier for the current user, used in the socket name.
/// Format: `uid-<uid>` or `user-<username>` as fallback.
pub fn current_user_id() -> String {
    // Primary: UID (stable, unique per user)
    let uid = unsafe { libc::getuid() };
    format!("uid-{}", uid)
}

/// Returns the username for display/fallback purposes.
pub fn current_username() -> String {
    if let Ok(user) = std::env::var("USER") {
        if !user.is_empty() {
            return user;
        }
    }
    Command::new("whoami")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("user-{}", unsafe { libc::getuid() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_user_id_not_empty() {
        let id = current_user_id();
        assert!(!id.is_empty());
        assert!(id.starts_with("uid-"));
    }

    #[test]
    fn current_username_not_empty() {
        let name = current_username();
        assert!(!name.is_empty());
    }
}