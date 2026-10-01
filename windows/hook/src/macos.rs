// macOS: Unix domain socket path for coucou-hook.

use std::path::PathBuf;

pub fn socket_path() -> PathBuf {
    // ~/Library/Application Support/Coucou/coucou.sock
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("Library/Application Support/Coucou/coucou.sock")
}