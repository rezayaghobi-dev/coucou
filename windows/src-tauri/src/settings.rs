// Preferences, stored as plain JSON in XDG config dir (Linux) / %APPDATA% (Windows).
// No secret ever lands here — API keys live in the platform keyring.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// Which chat backend the island talks to: "anthropic" (default) or "custom".
    #[serde(default = "default_provider")]
    pub provider: String,
    /// Base URL of the OpenAI-compatible provider, e.g. https://host/v1.
    /// Not a secret, so it lives here rather than in the keyring.
    #[serde(default)]
    pub custom_base_url: String,
    /// Model id picked from the custom endpoint's /models list.
    #[serde(default)]
    pub custom_model: String,
}

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_provider() -> String {
    "anthropic".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            provider: default_provider(),
            custom_base_url: String::new(),
            custom_model: String::new(),
        }
    }
}

/// Config directory: $XDG_CONFIG_HOME/coucou (Linux) or %APPDATA%/Coucou (Windows)
pub fn config_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("coucou")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("Coucou")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Coucou")
    }
}

/// Local data directory: $XDG_DATA_HOME/coucou (Linux) or %LOCALAPPDATA%/Coucou (Windows)
pub fn local_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("coucou")
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("Coucou")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Coucou")
    }
}

pub fn hook_exe_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        local_dir().join("bin").join("coucou-hook.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        local_dir().join("bin").join("coucou-hook")
    }
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
