<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Coucou icon">

# Coucou for Linux

**Mochi doesn't get a notch on a desktop — so it lives at the top of your screen instead.**

Approve Claude Code permissions, watch your session work, drop a file, chat with Claude, keep an eye on your services — without leaving what you're doing.

![Linux](https://img.shields.io/badge/Linux-x86__64-FCC624?logo=linux&logoColor=black)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

<img src="screenshots/greeting.png" width="640" alt="Mochi waving hello at launch">

---

## Install

Requires an X11 session (Wayland is not supported yet).

Download the `.deb` (Debian, Ubuntu, Mint) or the AppImage from the
[releases page](../../releases):

```bash
sudo apt install ./Coucou-latest-amd64.deb      # Debian / Ubuntu / Mint

chmod +x Coucou-latest-x86_64.AppImage            # AppImage (needs libfuse2)
./Coucou-latest-x86_64.AppImage
```

## Using it

<img src="screenshots/compact.png" width="292" alt="The compact island, with the integration pills as mini Mochis">
<img src="screenshots/overview.png" width="640" alt="The overview: the focused integration on the left, the other pills on the right">
<img src="screenshots/approval.png" width="640" alt="A Claude Code permission request, with Deny and Allow">
<img src="screenshots/chat.png" width="640" alt="Chatting with Claude from the island">
<img src="screenshots/drop.png" width="640" alt="Mochi turned into a box, waiting for a file">

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Mochi peeks out |
| Click the small island | It opens |
| Click Mochi | It gets annoyed. Three times in a row and it goes dizzy |
| Rest the pointer on Mochi for two seconds | Hearts |
| Drag a file onto the island | Mochi turns into a box, swallows it, then offers to answer questions about it |
| `Esc` | Closes the island |
| Tray icon | Open, Settings…, Pause, Quit |

Everything else happens on its own: a Claude Code permission request opens the
island with **Deny / Allow**, a finished session shows what it did, and your
integrations sit in the coloured pills next to Mochi.

## Claude Code

<img src="screenshots/settings.png" width="562" alt="The settings window">

Open **Settings… → Claude Code → Install hooks…**. You get the exact diff of what
will change in `~/.claude/settings.json`, the path of the dated backup that will
be taken, and nothing is written until you click. Your own hooks are never
touched, and uninstalling removes only Coucou's entries.

The relay is a tiny executable, `coucou-hook`, copied to
`~/.local/share/coucou/bin/` at launch. It is given 300 ms to reach Coucou and
exits cleanly if the app is closed, slow or crashed — **a Claude Code session is
never blocked or slowed down by Coucou.** If nobody answers a permission request
in time, Coucou stays quiet and Claude Code asks in the terminal as usual.

It works from any terminal — GNOME Terminal, Konsole, xterm, VS Code.

## OpenCode

Coucou also speaks to [OpenCode](https://opencode.ai), through a plugin instead
of hooks: **Settings… → OpenCode → Install plugin…**. Same care as the hooks —
you see the exact file that will be written, a dated backup is taken, and nothing
is written until you click. The plugin lands in `~/.config/opencode/plugins/` and
works in every project; uninstalling removes only Coucou's file. Restart OpenCode
after installing.

The plugin talks to the island over the same socket protocol as `coucou-hook`, and
follows the same hard rule — Coucou closed, paused or slow means OpenCode asks in
the terminal, and nothing ever blocks a session.

| OpenCode | What you get |
|---|---|
| **v1.x (verified on 1.18.34)** | Sessions, prompts, tool steps and completion in the island. Permission approval stays in the terminal — v1 has no plugin permission API (its `permission.ask` hook is defined but never triggered). |
| **v2.x** | Everything above **plus Allow / Deny from the island**, via `permission.evaluate`. |

## Chat and keys

**Settings… → Chat** picks the provider. **Anthropic** takes an Anthropic API
key and model. **Custom** takes any OpenAI-compatible endpoint (a base URL like
`https://host/v1`) and its API key, then **Load models** reads `GET {endpoint}/models`
so you can pick one. Only one provider is active at a time, and switching starts
a fresh conversation.

Keys live in the Secret Service keyring (gnome-keyring on Mint), never on disk
and never in the interface — the island can only ask whether a key exists. The
custom endpoint URL is not a secret, so it is stored with the other preferences
in `~/.config/coucou/settings.json`. Same for every integration key.

No telemetry. The only network requests Coucou makes are to the services you
configure yourself.

## Build it yourself

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the GTK /
WebKitGTK development packages:

```bash
sudo apt install build-essential curl wget file pkg-config \
  libdbus-1-dev libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libsecret-1-dev libxdo-dev

cd linux
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # builds the bundles and drops them in linux/release/
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks. It also serves `dev/upload-preview.html`, which
replays the whole file-drop choreography on a loop — the one part of the UI that
otherwise needs a real drag to see. Neither page ships in the app.

`npm run pack` leaves four files in `linux/release/`, the same names the release
workflow publishes:

```
Coucou-X.Y.Z-amd64.deb            the versioned package
Coucou-latest-amd64.deb           the same file under the rolling name
Coucou-X.Y.Z-x86_64.AppImage      the versioned AppImage
Coucou-latest-x86_64.AppImage     the same file under the rolling name
```

Installing is optional — `target/release/coucou` runs on its own. There is no
window in the taskbar and no console: the island at the top of the screen and the
Mochi in the notification area are the whole app, and Quit lives in its menu.

The 28 sounds are the macOS app's own files; they are never duplicated in this
folder. The path is declared once, in `SOUNDS_DIR` at the top of `vite.config.ts`
— when they move to `shared/sounds/`, change that one line.

The app icon and the tray icon are drawn in code, like Mochi itself:

```bash
npm run icons          # regenerates src-tauri/icons from scripts/gen-icons.mjs
```

### Layout

```
linux/
  src/                 island front end (TypeScript, no framework)
    mochi/             Mochi and the launch greeting, in Canvas 2D
    island/            state machine, hooks, integrations
    views/             every island view
    settings/          the settings window
  src-tauri/           Rust backend: window, Unix socket, Claude API, pollers
    src/linux_island.rs  X11 window, click-through and cursor polling
  hook/                coucou-hook, the Claude Code relay
  scripts/             icon generator and packaging
```

### Log

`~/.local/share/coucou/coucou.log` — hook events, permission decisions, poller
problems. It stays on your machine.

## What's different from the Mac version

- No notch, so the island lives at the top centre of the screen and retracts into
  the top edge instead of hiding in a notch.
- Permission approval works from **any** terminal; the Mac build only listens to
  VS Code sessions.
- Not in this version: sending a file by email, and dragging Mochi onto a window
  to attach it as context.
- "Open terminal" opens a terminal emulator in the session's working folder;
  the ↗ button opens that folder in VS Code when `code` is on your `PATH`.
- Cal.com shows the next bookings as a list rather than the Mac's calendar.
