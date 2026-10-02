// Island window for Linux: Wayland layer-shell (primary) + X11 fallback.
// Transparent, borderless, always-on-top window at top-center of screen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, KeyButMask, PropMode, Window};
use x11rb::rust_connection::RustConnection;
// `change_property32` (and friends) live on the wrapper trait, not xproto's.
use x11rb::wrapper::ConnectionExt as _;

use crate::log;

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible strip that wakes the island when it is hidden.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into platform APIs when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

/// Let the island take keyboard focus while a text field is on screen, then hand
/// focus back to the window manager. `setup_platform_window` starts it
/// unfocusable so the island never steals the keyboard when it is just showing a
/// session.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    let _ = win.set_focusable(activating);
    if activating {
        let _ = win.set_focus();
    }
}

/// Platform-specific window setup (X11; Wayland is not implemented yet).
/// Called after the Tauri window is created.
pub fn setup_platform_window(app: &AppHandle) {
    let Some(win) = window(app) else { return };

    if is_wayland() {
        // Wayland has no global cursor query and needs layer-shell for the island
        // to sit above everything. Not implemented: fall back to Tauri's flags.
        log::line("Wayland detected — layer-shell not implemented, using window flags");
    } else {
        setup_x11_window(app);
    }

    // GTK/Tauri flags. `set_focusable(false)` is undone on demand when a text
    // field needs the keyboard (see the `focus_window` command).
    win.set_decorations(false).ok();
    win.set_always_on_top(true).ok();
    win.set_skip_taskbar(true).ok();
    win.set_resizable(false).ok();
    win.set_maximizable(false).ok();
    win.set_minimizable(false).ok();
    win.set_closable(false).ok();
    win.set_focusable(false).ok();
}

fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false)
}

// ── X11 (native) ──────────────────────────────────────────────────────────────

struct X11 {
    conn: RustConnection,
    root: Window,
}

/// One shared X connection for the whole process. The cursor poll runs at 60 Hz;
/// opening a fresh X connection on every tick is a lot of sockets for no reason.
fn x11() -> Option<&'static X11> {
    static CONN: OnceLock<Option<X11>> = OnceLock::new();
    CONN.get_or_init(|| {
        let (conn, screen_num) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen_num)?.root;
        Some(X11 { conn, root })
    })
    .as_ref()
}

fn intern(x: &X11, name: &str) -> Option<u32> {
    x.conn
        .intern_atom(false, name.as_bytes())
        .ok()?
        .reply()
        .ok()
        .map(|r| r.atom)
}

/// The island's X11 window: ours by PID, and titled "Coucou". The settings window
/// shares our PID and WM_CLASS but is titled "Settings — Coucou", so the title is
/// what tells the two apart.
fn island_window_id(x: &X11) -> Option<Window> {
    let pid_atom = intern(x, "_NET_WM_PID")?;
    let name_atom = intern(x, "_NET_WM_NAME")?;
    let me = std::process::id();

    // _NET_CLIENT_LIST is the EWMH list of top-level windows as the
    // window manager sees them. Window managers (Muffin on Mint) wrap
    // client windows in frames, so _NET_WM_PID sits on the inner
    // window and the root's direct children are frames, not ours.
    let listed = intern(x, "_NET_CLIENT_LIST").and_then(|atom| {
        x.conn
            .get_property(false, x.root, atom, AtomEnum::WINDOW, 0, 1024)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .and_then(|reply| reply.value32().map(|it| it.collect::<Vec<Window>>()))
    });

    // A window manager that does not provide _NET_CLIENT_LIST: scan
    // the root's direct children, like before.
    let candidates = listed.unwrap_or_else(|| {
        x.conn
            .query_tree(x.root)
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .map(|reply| reply.children)
            .unwrap_or_default()
    });
    for win in candidates {
        let pid = x
            .conn
            .get_property(false, win, pid_atom, AtomEnum::CARDINAL, 0, 1)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|r| r.value32().and_then(|mut it| it.next()));
        if pid != Some(me) {
            continue;
        }
        let name = x
            .conn
            .get_property(false, win, name_atom, AtomEnum::ANY, 0, 1024)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| String::from_utf8_lossy(&r.value).into_owned());
        if name.as_deref() == Some("Coucou") {
            return Some(win);
        }
    }
    None
}

/// Make the island behave like a panel: above normal windows, out of the taskbar
/// and pager, and present on every workspace.
///
/// Only the state/desktop properties are set — not `_NET_WM_WINDOW_TYPE`, which a
/// window manager reads at map time and ignores when it changes later. These are
/// watched live, so they take effect on the already-mapped window.
fn setup_x11_window(app: &AppHandle) {
    let _ = app;
    let Some(x) = x11() else {
        log::line("X11 unavailable — relying on Tauri window flags");
        return;
    };
    let Some(win) = island_window_id(x) else {
        log::line("island X11 window not found — relying on Tauri window flags");
        return;
    };

    if let Some(desktop) = intern(x, "_NET_WM_DESKTOP") {
        let all_workspaces = u32::MAX; // 0xFFFFFFFF per EWMH
        let _ = x.conn.change_property32(
            PropMode::REPLACE,
            win,
            desktop,
            AtomEnum::CARDINAL,
            &[all_workspaces],
        );
    }
    if let Some(state) = intern(x, "_NET_WM_STATE") {
        let mut list: Vec<u32> = Vec::new();
        for name in [
            "_NET_WM_STATE_ABOVE",
            "_NET_WM_STATE_SKIP_TASKBAR",
            "_NET_WM_STATE_SKIP_PAGER",
            "_NET_WM_STATE_STICKY",
        ] {
            if let Some(atom) = intern(x, name) {
                list.push(atom);
            }
        }
        let _ = x.conn.change_property32(PropMode::REPLACE, win, state, AtomEnum::ATOM, &list);
    }
    let _ = x.conn.flush();
    log::line(format!("X11: island 0x{win:x} pinned above, all workspaces"));
}

/// Cursor position in physical screen coordinates (X11 root coordinates).
fn cursor_physical() -> Option<(f64, f64)> {
    let x = x11()?;
    let reply = x.conn.query_pointer(x.root).ok()?.reply().ok()?;
    Some((reply.root_x as f64, reply.root_y as f64))
}

/// Cursor position in physical screen coordinates (X11 root
/// coordinates) plus whether the left button is held — one
/// query_pointer serves both the cursor and the drag detection.
fn pointer_state() -> Option<(f64, f64, bool)> {
    let x = x11()?;
    let reply = x.conn.query_pointer(x.root).ok()?.reply().ok()?;
    let down = u16::from(reply.mask) & u16::from(KeyButMask::BUTTON1) != 0;
    Some((reply.root_x as f64, reply.root_y as f64, down))
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// The display the island lives on: the primary one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the panel.
pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();

    let (lw, lh) = if collapsed { (STRIP_W, STRIP_H) } else { (PANEL_W, PANEL_H) };
    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;
    let x = mp.x + (ms.width as i32 - pw as i32) / 2;
    let y = mp.y;

    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);
}

/// Set click-through (ignore cursor events) based on whether mouse is over island.
pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    thread::spawn(move || {
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            while gate.is_active() {
                thread::sleep(Duration::from_millis(16));

                // Monitor layout changes
                ticks = ticks.wrapping_add(1);
                if ticks % 30 == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy, down)) = pointer_state() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                // Click-through: the window only takes the mouse over the island shape
                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A held button means a drag may be starting: keep the panel taking
                // the mouse so the drop still reaches the webview.
                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                let accept = on_island || dragging;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}
