// Local wall-clock time, used for log stamps and dated backups.
//
// libc's localtime_r is cheap and dependency-light, and needs no timezone crate.

#[derive(Clone, Copy)]
pub struct LocalTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

pub fn local_time() -> LocalTime {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // localtime_r is thread-safe and cannot fail for a valid time_t.
    unsafe { libc::localtime_r(&secs, &mut tm) };
    LocalTime {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

/// `YYYYMMDD-HHMMSS` — down to the second, so installing then uninstalling in
/// the same minute never quietly overwrites the first backup.
pub fn backup_stamp() -> String {
    let t = local_time();
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

/// `YYYY-MM-DD HH:MM:SS`, used for log lines.
pub fn log_stamp() -> String {
    let t = local_time();
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}
