// Linux: Unix domain socket path for coucou-hook.

use std::path::PathBuf;

pub fn socket_path() -> PathBuf {
    // Primary: $XDG_RUNTIME_DIR/coucou.sock
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(runtime_dir).join("coucou.sock");
    }
    // Fallback: ~/.local/share/coucou/coucou.sock
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("coucou")
        .join("coucou.sock")
}