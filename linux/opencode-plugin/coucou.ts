// coucou-opencode-plugin v1
//
// Coucou's OpenCode plugin. Mochi in the island shows what OpenCode is doing,
// and permission requests can be allowed or denied from the island.
//
// Protocol: exactly what `coucou-hook` speaks — one JSON line per event to
// Coucou's unix socket ($XDG_RUNTIME_DIR/coucou.sock, falling back to
// ~/.local/share/coucou/coucou.sock). The app answers a PermissionRequest with
// one bare word: "allow" or "deny".
//
// Hard rule (docs/CLAUDE.md): **never block the agent.**
// * If the socket does not exist — Coucou is closed — we return immediately and
//   OpenCode asks in the terminal as usual.
// * Every step is raced against a deadline, so a socket that accepts and then
//   stops reading cannot wedge a session either.
// * Only permission decisions wait for an answer; when the island is closed,
//   paused or slow, we hand the question straight back to the terminal.
//
// Shape: a dual-style plugin. OpenCode v1 loads `server(input)` and OpenCode v2
// loads `setup(ctx)`; extra keys are ignored by each loader. Both do the same
// job through their host's own API.

import net from "node:net";
import os from "node:os";
import path from "node:path";

/// Marker the installer looks for; bumped when this file changes meaningfully.
/// NOT exported: the v1 loader validates every export of the module as a
/// plugin function — a named string export makes it throw
/// "Plugin export is not a function" (found live on 1.18.34).
const COUCOU_PLUGIN_VERSION = "coucou-opencode-plugin v1";

/// Budget for getting a connection. Beyond this the terminal wins, always.
const CONNECT_TIMEOUT = 300;
/// Whole budget for an event nobody waits on.
const FIRE_AND_FORGET_BUDGET = 2_000;
/// How long a permission prompt may stay on screen before the terminal takes
/// over. Same number as coucou-hook's decision budget.
const DECISION_BUDGET = 110_000;
/// Upper bound on a single field forwarded to the island.
const MAX_FIELD_LEN = 2_000;

// ── Socket plumbing ───────────────────────────────────────────────────────────

function socketPath(): string {
  if (process.env["XDG_RUNTIME_DIR"]) {
    return path.join(process.env["XDG_RUNTIME_DIR"], "coucou.sock");
  }
  return path.join(os.homedir(), ".local/share/coucou", "coucou.sock");
}

/// Connects to the island, writes one JSON line, done. Resolves whatever
/// happens — callers never await an error, and nothing here can hang past the
/// fire-and-forget budget: a missing socket errors out at once, a wedged one
/// is cut off by the connect timeout, and an accepted-but-idle one by socket
/// inactivity.
function sendMessage(payload: Record<string, unknown>): void {
  const line = JSON.stringify(payload) + "\n";
  const socket = socketPath();
  try {
    const conn = net.connect(socket);
    conn.setTimeout(FIRE_AND_FORGET_BUDGET);
    conn.on("timeout", () => conn.destroy());
    conn.on("error", () => conn.destroy());
    conn.on("connect", () => {
      const connectTimer = setTimeout(() => conn.destroy(), CONNECT_TIMEOUT);
      try {
        conn.write(line, () => {
          clearTimeout(connectTimer);
          conn.end();
        });
      } catch {
        clearTimeout(connectTimer);
        conn.destroy();
      }
    });
  } catch {
    /* Coucou is not there; the session carries on untouched */
  }
}

/// Connects, sends a PermissionRequest, waits for the island's word.
/// Resolves null whenever the island cannot answer — the terminal takes over.
async function askPermission(payload: Record<string, unknown>): Promise<"allow" | "deny" | null> {
  const line = JSON.stringify(payload) + "\n";
  const socket = socketPath();
  return new Promise<"allow" | "deny" | null>((resolve) => {
    let settled = false;
    let buf = "";
    const finish = (answer: "allow" | "deny" | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      resolve(answer);
    };
    let conn: net.Socket;
    const timer = setTimeout(() => finish(null), DECISION_BUDGET);
    try {
      conn = net.connect(socket);
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    const connectTimer = setTimeout(() => {
      // Coucou has 300 ms to be there. Then the terminal asks instead.
      finish(null);
    }, CONNECT_TIMEOUT);
    conn.on("connect", () => {
      clearTimeout(connectTimer);
      try {
        conn.write(line);
      } catch {
        finish(null);
      }
    });
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const word = buf.slice(0, nl).trim();
      finish(word === "allow" || word === "deny" ? word : null);
    });
    conn.on("error", () => finish(null));
    conn.on("close", () => finish(null));
  });
}

// ── Payload shaping ───────────────────────────────────────────────────────────

/// OpenCode permission/tool names → the island's Claude-shaped tool labels.
const TOOL_NAMES: Record<string, string> = {
  shell: "Bash",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  task: "Task",
  todowrite: "TodoWrite",
  todoread: "TodoWrite",
  list: "LS",
};

function toolLabel(name: string | undefined | null): string {
  const raw = (name ?? "").toString();
  if (!raw) return "Tool";
  const known = TOOL_NAMES[raw.toLowerCase()];
  if (known) return known;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function cap(value: unknown): string {
  const s = (value ?? "").toString();
  if (s.length <= MAX_FIELD_LEN) return s;
  let end = MAX_FIELD_LEN;
  // Never split a UTF-16 surrogate pair in half.
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end) + "...";
}

/// Whatever identifies the thing being approved, in the island's field order.
function approvalInput(action: string, resources: string[]): Record<string, unknown> {
  const first = resources[0] ?? "";
  if (action === "shell" || action === "bash") return { command: first };
  if (["edit", "write", "patch"].includes(action)) return { file_path: first };
  if (action === "read" || action === "list") return { path: first };
  if (action === "webfetch") return { url: first };
  if (action === "grep" || action === "glob") return { pattern: first };
  return first ? { path: first } : {};
}

function basePayload(event: string, sessionID: string, cwd: string): Record<string, unknown> {
  return {
    hook_event_name: event,
    agent: "opencode",
    session_id: cap(sessionID),
    cwd: cap(cwd),
  };
}

/** User-prompt text out of whatever message shape the host hands over. */
function promptTextOf(info: any): string {
  const parts = info?.parts ?? info?.message?.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof info?.text === "string") return info.text;
  return "";
}

// ── Shared state ──────────────────────────────────────────────────────────────

/** Project directory for cwd; refined by whatever the host tells us. */
let projectDir = process.cwd();
/** The v1 host hands the plugin a project-scoped SDK client in its input. */
let v1Client: any = null;
/** The v2 setup context, when the host provides one. */
let v2Ctx: any = null;
/** Dedup for user prompts: message events fire more than once per message. */
const seenPrompts = new Set<string>();
/** message id → role, so text parts can be attributed to the user. */
const roles = new Map<string, string>();
/** Permission requests already answered, so no path ever answers twice. */
const answered = new Set<string>();

function rememberPrompt(key: string): boolean {
  if (seenPrompts.has(key)) return false;
  if (seenPrompts.size > 256) seenPrompts.clear();
  seenPrompts.add(key);
  return true;
}

function rememberRole(id: string, role: string): void {
  if (!id) return;
  if (roles.size > 512) roles.clear();
  roles.set(id, role);
}

function rememberAnswered(id: string): void {
  if (!id) return;
  if (answered.size > 256) answered.clear();
  answered.add(id);
}

/// Whoever can answer a permission request on this host. The v1 client exposes
/// the same call the TUI itself makes after a click; v2 contexts expose it
/// directly.
function replier(): ((requestID: string, reply: "once" | "reject") => Promise<unknown>) | null {
  if (typeof v1Client?.permission?.reply === "function") {
    return (requestID, reply) =>
      v1Client.permission.reply({ requestID, reply, directory: projectDir });
  }
  if (typeof v2Ctx?.permission?.reply === "function") {
    return (requestID, reply) => v2Ctx.permission.reply({ requestID, reply });
  }
  return null;
}

/** v1 event payloads live under `properties`; v2 puts them under `data`. */
function propsOf(event: any): Record<string, any> {
  return event?.properties ?? event?.data ?? event ?? {};
}

function sessionIDOf(props: any): string {
  return props?.sessionID ?? props?.info?.sessionID ?? props?.info?.id ?? props?.id ?? "";
}

/** The island said yes/no for an OpenCode permission request; tell the host. */
async function handlePermissionAsked(props: Record<string, any>): Promise<void> {
  // v1 calls the request id `id`; v2 names it `requestID`.
  const requestID = (props?.id ?? props?.requestID ?? "").toString();
  if (!requestID || answered.has(requestID)) return;
  if (!replier()) return; // no way to answer — the terminal asks as usual

  const action = (props?.permission ?? props?.action ?? "").toString();
  const resources = Array.isArray(props?.patterns)
    ? props.patterns.map(String)
    : Array.isArray(props?.resources)
      ? props.resources.map(String)
      : [];
  const sessionID = sessionIDOf(props);

  const p = basePayload("PermissionRequest", sessionID, projectDir);
  p["tool_name"] = toolLabel(action);
  p["tool_input"] = props?.metadata && Object.keys(props.metadata).length
    ? props.metadata
    : approvalInput(action, resources);

  const decision = await askPermission(p);
  if (!decision) return; // island closed, paused or slow — the terminal takes over
  rememberAnswered(requestID);
  try {
    await replier()!(requestID, decision === "allow" ? "once" : "reject");
  } catch {
    /* the terminal asks instead */
  }
}

function sendLifecycle(event: any): void {
  const type = event?.type ?? "";
  const props = propsOf(event);
  const sessionID = sessionIDOf(props);

  if (type === "permission.asked") {
    // Answered asynchronously — the event pump must never wait on a human.
    void handlePermissionAsked(props).catch(() => {});
    return;
  }
  if (type === "permission.replied") {
    answered.delete((props?.requestID ?? props?.id ?? "").toString());
    return;
  }
  if (!sessionID) return;

  if (type === "session.created") {
    sendMessage(basePayload("SessionStart", sessionID, projectDir));
  } else if (type === "session.idle") {
    sendMessage(basePayload("Stop", sessionID, projectDir));
  } else if (type === "session.deleted") {
    sendMessage(basePayload("SessionEnd", sessionID, projectDir));
  } else if (type === "session.execution.succeeded") {
    sendMessage(basePayload("Stop", sessionID, projectDir));
  } else if (type === "session.execution.failed") {
    const p = basePayload("StopFailure", sessionID, projectDir);
    p["message"] = cap(props?.error ?? "error");
    sendMessage(p);
  } else if (type === "session.execution.interrupted") {
    const p = basePayload("Stop", sessionID, projectDir);
    p["message"] = "interrupted";
    sendMessage(p);
  } else if (type === "message.updated") {
    const info = props?.info ?? {};
    if (info?.role) rememberRole(info.id, info.role);
    if (info?.role !== "user") return;
    // The user message object carries no text on v1; when it does (other
    // versions), take it straight away.
    const asked = promptTextOf(info);
    if (!asked) return;
    const key = `msg:${sessionID}:${info?.id ?? JSON.stringify(info).length}`;
    if (!rememberPrompt(key)) return;
    const p = basePayload("UserPromptSubmit", sessionID, projectDir);
    p["prompt"] = cap(asked);
    sendMessage(p);
  } else if (type === "message.part.updated") {
    // v1: the prompt text rides in as a text part; attribute it to the user
    // via the role learned from message.updated.
    const part = props?.part ?? props;
    if (part?.type !== "text") return;
    const messageID = (part?.messageID ?? part?.id ?? "").toString();
    if (roles.get(messageID) !== "user") return;
    const key = `part:${sessionID}:${messageID}`;
    if (!rememberPrompt(key)) return;
    const asked = typeof part?.text === "string" ? part.text : "";
    if (!asked) return;
    const p = basePayload("UserPromptSubmit", sessionID, projectDir);
    p["prompt"] = cap(asked);
    sendMessage(p);
  }
}

// ── v1 plugin (OpenCode 1.x: hooks returned from server(input)) ───────────────

async function server(input: any): Promise<Record<string, any>> {
  projectDir = input?.directory ?? projectDir;
  v1Client = input?.client ?? null;

  return {
    event: async ({ event }: { event: any }) => {
      try {
        sendLifecycle(event);
      } catch {
        /* never let observing break a session */
      }
    },

    "tool.execute.before": async (input: any, output: any) => {
      try {
        const p = basePayload("PreToolUse", input?.sessionID ?? "", projectDir);
        p["tool_name"] = toolLabel(input?.tool);
        p["tool_input"] = output?.args ?? {};
        sendMessage(p);
      } catch {
        /* never let observing break a session */
      }
    },

    "permission.ask": async (input: any, output: any) => {
      try {
        const action = (input?.permission ?? "").toString();
        const p = basePayload(
          "PermissionRequest",
          input?.sessionID ?? process.env["OPENCODE_SESSION_ID"] ?? "",
          projectDir,
        );
        p["tool_name"] = toolLabel(action);
        p["tool_input"] = input?.metadata && Object.keys(input.metadata).length
          ? input.metadata
          : approvalInput(action, (input?.patterns ?? []).map(String));
        const decision = await askPermission(p);
        if (decision) output.status = decision;
        // No decision: leave output.status as "ask" — the terminal prompts.
      } catch {
        /* the terminal asks instead */
      }
    },
  };
}

// ── v2 plugin (OpenCode 2.x: setup(ctx) registers on the context) ─────────────

async function setup(ctx: any): Promise<void> {
  // v1 hosts ≥1.17.10 also boot a v2 core, but hand plugins a registration-only
  // context without event/session/tool domains. Nothing to do there.
  if (!ctx) return;
  const hasEvents = typeof ctx?.event?.subscribe === "function";
  const hasPermission = typeof ctx?.permission?.hook === "function";
  if (!hasEvents && !hasPermission) return;
  v2Ctx = ctx;

  const dir = typeof ctx?.location === "string" ? ctx.location : ctx?.location?.directory;
  projectDir = dir ?? projectDir;

  if (hasEvents) {
    try {
      await ctx.event.subscribe((event: any) => {
        try {
          sendLifecycle(event);
        } catch {
          /* never let observing break a session */
        }
      });
    } catch {
      /* events stay unobserved; permissions still work below */
    }
  }

  // v2 has no message.updated role=user guarantee worth chasing: the prompt
  // hook fires once per admitted input.
  try {
    if (typeof ctx?.session?.hook === "function") {
      await ctx.session.hook("prompt", (input: any) => {
        try {
          const sessionID = input?.sessionID ?? process.env["OPENCODE_SESSION_ID"] ?? "";
          const asked = promptTextOf(input);
          if (!sessionID || !asked) return;
          const key = `prompt:${sessionID}:${input?.messageID ?? asked}`;
          if (!rememberPrompt(key)) return;
          const p = basePayload("UserPromptSubmit", sessionID, projectDir);
          p["prompt"] = cap(asked);
          sendMessage(p);
        } catch {
          /* never let observing break a session */
        }
      });
    }
  } catch {
    /* host refused the hook name — prompts stay unobserved */
  }

  try {
    if (typeof ctx?.tool?.hook === "function") {
      await ctx.tool.hook("execute.before", (input: any, output: any) => {
        try {
          const p = basePayload("PreToolUse", input?.sessionID ?? "", projectDir);
          p["tool_name"] = toolLabel(input?.tool);
          p["tool_input"] = output?.args ?? input?.args ?? {};
          sendMessage(p);
        } catch {
          /* never let observing break a session */
        }
      });
    }
  } catch {
    /* tool steps stay unobserved */
  }

  if (hasPermission) {
    try {
      await ctx.permission.hook("evaluate", async (event: any) => {
        try {
          const action = (event?.action ?? "").toString();
          const resources = Array.isArray(event?.resources) ? event.resources.map(String) : [];
          const p = basePayload(
            "PermissionRequest",
            event?.sessionID ?? process.env["OPENCODE_SESSION_ID"] ?? "",
            projectDir,
          );
          p["tool_name"] = toolLabel(action);
          p["tool_input"] = approvalInput(action, resources);
          const decision = await askPermission(p);
          if (decision) return { effect: decision };
          // No decision from the island: return nothing, the host asks as usual.
          return undefined;
        } catch {
          return undefined;
        }
      });
    } catch {
      /* host refused the hook — the terminal asks, as if Coucou were closed */
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
// Shape verified live on OpenCode 1.18.34: the default export must be a
// *function*, which the v1 loader calls as `server(input)` — an `{ id, server }
// object is silently skipped, and `setup` attached as a property is never
// invoked by a v1 host, so there is no double-load. A v2 host decodes the same
// function via its `{ id, setup }` shape and calls `setup(ctx)`: same events,
// same island, both hosts.

type CoucouPlugin = ((input: any) => Promise<Record<string, any>>) & {
  id: string;
  server: (input: any) => Promise<Record<string, any>>;
  setup: (ctx: any) => Promise<void>;
};

const plugin = server as unknown as CoucouPlugin;
plugin.id = "coucou";
plugin.server = server;
plugin.setup = setup;

export default plugin;
