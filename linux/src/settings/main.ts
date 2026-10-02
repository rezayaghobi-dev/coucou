// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "./settings.css";
import { Bridge, onEvent, type HookStatus, type ModelInfo, type OpenCodeStatus } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h, clear } from "../views/dom";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there."
          : "Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing.",
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "Relay" }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: "coucou-hook.exe is not in place yet. Restart Coucou; if it still fails, build it with `cargo build -p coucou-hook`.",
      }));
    }

    const actions = h("div", { class: "row" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? "Reinstall hooks…" : "Install hooks…",
      onclick: () => showPreview(true),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = "The relay isn't installed yet.";
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall hooks…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.hooksPreview(install);
    } catch (err) {
      // An unreadable or invalid settings.json stops here rather than being
      // treated as empty and written over.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    if (!preview) return;
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is exactly what will change in your settings.json. Your own hooks are left untouched."
          : "This removes Coucou's entries only. Your own hooks are left untouched.",
      }),
      renderDiff(preview.diff),
      h("div", { class: "row" },
        h("span", { class: "path", text: `Backup → ${preview.backup}` }),
      ),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.hooksApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: `Done. Previous settings saved as ${backup}. Open a new Claude Code session to pick the hooks up.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── OpenCode section ──────────────────────────────────────────────────────

function openCodeSection(status: OpenCodeStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    h("h2", {}, statusDot(status.installed), h("span", { text: "OpenCode" })),
    body,
  );

  const rebuild = async () => {
    const fresh = await Bridge.opencodeStatus();
    if (fresh) Object.assign(status, fresh);
    clear(body);
    draw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "OpenCode" }));
  };

  function draw() {
    body.append(
      h("div", {
        class: "hint",
        text: status.installed
          ? "Coucou's plugin is installed for OpenCode, in every project. Sessions, tool calls and permission requests show up in the island, and you can answer them there."
          : "Install the plugin to see your OpenCode sessions in the island and approve permissions without leaving what you are doing. One file, every project.",
      }),
      h("div", { class: "row" },
        h("label", { text: "Plugin" }),
        h("span", { class: "path", text: status.pluginPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: "OpenCode on PATH" }),
        statusDot(status.opencodeFound),
      ),
    );

    if (!status.opencodeFound) {
      body.append(h("div", {
        class: "notice warn",
        text: "opencode wasn't found on your PATH. The plugin can be installed, but OpenCode will only load it once the command exists.",
      }));
    }

    const actions = h("div", { class: "row" });
    actions.append(h("button", {
      class: "primary",
      text: status.installed ? "Reinstall plugin…" : "Install plugin…",
      onclick: () => showPreview(true),
    }));
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: "Uninstall plugin…",
        onclick: () => showPreview(false),
      }));
    }
    body.append(actions);
  }

  async function showPreview(install: boolean) {
    let preview;
    try {
      preview = await Bridge.opencodePreview(install);
    } catch (err) {
      // A foreign file with the plugin's name, or an unreadable one, stops here
      // rather than being overwritten.
      clear(body);
      body.append(
        h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
        h("div", { class: "row" }, h("button", {
          text: "Back",
          onclick: () => { clear(body); draw(); },
        })),
      );
      return;
    }
    clear(body);
    body.append(
      h("div", {
        class: "hint",
        text: install
          ? "This is the exact file that will be written. Restart OpenCode afterwards to load it."
          : "This removes Coucou's plugin only. Nothing else in the folder is touched.",
      }),
      renderDiff(preview.diff),
      preview.backup
        ? h("div", { class: "row" }, h("span", { class: "path", text: `Backup → ${preview.backup}` }))
        : h("div", { class: "row" }, h("span", { class: "hint", text: "Nothing to back up — no file there yet." })),
    );
    const confirm = h("button", {
      class: install ? "primary" : "danger",
      text: install ? "Back up and write" : "Back up and remove",
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      try {
        const backup = await Bridge.opencodeApply(install, preview.fingerprint);
        clear(body);
        body.append(h("div", {
          class: "notice ok",
          text: install
            ? `Done.${backup ? ` Previous file saved as ${backup}.` : ""} Restart OpenCode to pick the plugin up.`
            : `Done. Previous file saved as ${backup}.`,
        }));
        window.setTimeout(() => void rebuild(), 2600);
      } catch (err) {
        confirm.disabled = false;
        body.append(h("div", { class: "notice err", text: `Could not write: ${String(err)}` }));
      }
    });
    body.append(h("div", { class: "row" }, confirm, h("button", {
      text: "Cancel",
      onclick: () => { clear(body); draw(); },
    })));
  }

  draw();
  return section;
}

// ── Chat provider section ─────────────────────────────────────────────────────

const ANTHROPIC_MODELS: [string, string][] = [
  ["claude-opus-5", "Claude Opus 5"],
  ["claude-sonnet-5", "Claude Sonnet 5"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
];

/** Models fetched from the custom endpoint this session, kept so switching the
 *  provider back and forth does not fire another request. */
let customModels: ModelInfo[] = [];

/** The active provider only. Switching starts a fresh conversation, because the
 *  two backends cannot read each other's history. */
function chatSection(present: Record<string, boolean>): HTMLElement {
  const panel = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const anthropicBtn = h("button", { text: "Anthropic" });
  const customBtn = h("button", { text: "Custom" });

  function paint() {
    anthropicBtn.classList.toggle("primary", settings.provider === "anthropic");
    customBtn.classList.toggle("primary", settings.provider === "custom");
    clear(panel);
    panel.append(settings.provider === "custom" ? customPanel(present) : anthropicPanel(present));
  }

  function pick(provider: "anthropic" | "custom") {
    if (settings.provider === provider) return;
    settings.provider = provider;
    // The island hears settings-changed and drops the old bubbles; saving alone
    // is enough, there is no separate reset to send.
    void save();
    paint();
  }
  anthropicBtn.addEventListener("click", () => pick("anthropic"));
  customBtn.addEventListener("click", () => pick("custom"));

  paint();
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "Chat" })),
    h("div", {
      class: "hint",
      text: "Which model answers when you ask Mochi something. Switching providers starts a fresh conversation.",
    }),
    h("div", { class: "row", style: "gap:8px" }, anthropicBtn, customBtn),
    panel,
  );
}

function anthropicPanel(present: Record<string, boolean>): HTMLElement {
  const hasKey = present["anthropic-api-key"] ?? false;
  const dot = statusDot(hasKey);
  const state = h("span", {
    class: "hint",
    text: hasKey ? "Key saved in the credential manager." : "No key yet — the chat needs one.",
  });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: "Save key" });
  const clearBtn = h("button", { class: "danger", text: "Remove" });
  const feedback = h("div", {});

  async function refresh() {
    const presentKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    present["anthropic-api-key"] = presentKey;
    dot.style.background = presentKey ? "#22c55e" : "#f4505e";
    state.textContent = presentKey
      ? "Key saved in the credential manager."
      : "No key yet — the chat needs one.";
    field.placeholder = presentKey ? "••••••••••••  (stored)" : "sk-ant-...";
    clearBtn.style.display = presentKey ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: "Saved. It never touches disk." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not save: ${String(err)}` }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: "Key removed." }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: `Could not remove: ${String(err)}` }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of ANTHROPIC_MODELS) model.append(h("option", { value: id, text: label }));
  if (!ANTHROPIC_MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  return h(
    "div",
    { style: "display:flex;flex-direction:column;gap:12px" },
    state,
    h("div", { class: "row" }, h("label", { text: "API key" }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    feedback,
  );
}

function customPanel(present: Record<string, boolean>): HTMLElement {
  const hasKey = present["custom-api-key"] ?? false;

  const endpointInput = h("input", {
    type: "text",
    value: settings.customBaseUrl,
    placeholder: "https://router.example.com/v1",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  endpointInput.addEventListener("change", () => {
    settings.customBaseUrl = endpointInput.value.trim();
    void save();
  });

  const keyInput = h("input", {
    type: "password",
    placeholder: hasKey ? "••••••••••••  (stored)" : "sk-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const keyDot = statusDot(hasKey);
  const keySave = h("button", { class: "primary", text: "Save key" });
  const keyClear = h("button", { class: "danger", text: "Remove" });
  keyClear.style.display = hasKey ? "" : "none";

  const model = h("select", {}) as HTMLSelectElement;
  const status = h("div", {});

  function feedback(cls: string, text: string) {
    clear(status);
    status.append(h("div", { class: cls, text }));
  }

  function fillModels() {
    clear(model);
    for (const m of customModels) model.append(h("option", { value: m.id, text: m.name }));
    // A previously picked model may not be in a fresh list; keep it selectable.
    if (settings.customModel && !customModels.some((m) => m.id === settings.customModel)) {
      model.append(h("option", { value: settings.customModel, text: settings.customModel }));
    }
    model.value = settings.customModel;
  }
  fillModels();

  model.addEventListener("change", () => {
    settings.customModel = model.value;
    void save();
  });

  keySave.addEventListener("click", async () => {
    const value = keyInput.value.trim();
    if (!value) return;
    try {
      await Bridge.secretSet("custom-api-key", value);
      present["custom-api-key"] = true;
      keyInput.value = "";
      keyInput.placeholder = "••••••••••••  (stored)";
      keyDot.style.background = "#22c55e";
      keyClear.style.display = "";
      feedback("notice ok", "Saved. It never touches disk.");
    } catch (err) {
      feedback("notice err", `Could not save: ${String(err)}`);
    }
  });

  keyClear.addEventListener("click", async () => {
    try {
      await Bridge.secretClear("custom-api-key");
      present["custom-api-key"] = false;
      keyInput.placeholder = "sk-...";
      keyDot.style.background = "#f4505e";
      keyClear.style.display = "none";
      feedback("notice ok", "Key removed.");
    } catch (err) {
      feedback("notice err", `Could not remove: ${String(err)}`);
    }
  });

  const loadBtn = h("button", { class: "primary", text: "Load models" });
  loadBtn.addEventListener("click", async () => {
    settings.customBaseUrl = endpointInput.value.trim();
    // A key typed but not yet saved still counts for this one request.
    const typed = keyInput.value.trim();
    loadBtn.disabled = true;
    feedback("hint", "Loading…");
    try {
      await save();
      const models = await Bridge.customModels(settings.customBaseUrl, typed);
      customModels = models;
      fillModels();
      feedback(
        models.length ? "notice ok" : "notice warn",
        models.length
          ? `Loaded ${models.length} model${models.length === 1 ? "" : "s"}.`
          : "The endpoint returned no models.",
      );
    } catch (err) {
      feedback("notice err", String(err).replace(/^Error:\s*/, ""));
    } finally {
      loadBtn.disabled = false;
    }
  });

  return h(
    "div",
    { style: "display:flex;flex-direction:column;gap:12px" },
    h("div", {
      class: "hint",
      text: "Any OpenAI-compatible endpoint. Models are read from GET {endpoint}/models, answers from POST {endpoint}/chat/completions.",
    }),
    h("div", { class: "row" }, h("label", { text: "Endpoint" }), endpointInput),
    h("div", { class: "row" }, h("label", { text: "API key" }), keyInput, keySave, keyClear, keyDot),
    h("div", { class: "row" }, loadBtn,
      h("span", { class: "hint", text: "then pick one below" })),
    h("div", { class: "row" }, h("label", { text: "Model" }), model),
    status,
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: "Secret key", placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: "Token", placeholder: "ghp_…", secret: true }] },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: "Token", placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: "Instance URL", placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: "API key", placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: "API key", placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: "Integration token", placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: "API key", placeholder: "cal_…", secret: true }] },
];

const MAX_ACTIVE = 4;

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = `Pick up to ${MAX_ACTIVE} pills to show next to Mochi — ${used}/${MAX_ACTIVE} in use. Keys are stored in the OS keyring, never on disk.`;
  }

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      updateNote();
      void save();
    });

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? "••••••••  (stored)" : field.placeholder,
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: "Save" });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? "••••••••  (stored)" : field.placeholder;
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: field.label }),
          input, saveBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          h("i", { class: "dot", style: `background:${def.color}` }),
          h("span", { style: "font-size:12.5px", text: def.name }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: "Integrations" })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  const autoClose = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  autoClose.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(autoClose.value) || 15));
    autoClose.value = String(settings.autoCloseInterval);
    void save();
  });

  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: "Main display" }),
    h("option", { value: "cursor", text: "Display under the cursor" }),
  );
  screen.value = settings.screen;
  screen.addEventListener("change", () => {
    settings.screen = screen.value as Settings["screen"];
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: "General" })),
    h("div", { class: "row" },
      h("label", { text: "Sound" }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    h("div", { class: "row" },
      h("label", { text: "Auto-close" }),
      autoClose,
      h("span", { class: "hint", text: "seconds after you leave the island" }),
    ),
    h("div", { class: "row" },
      h("label", { text: "Island lives on" }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: "Launch at startup" }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
  }
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const opencode = (await Bridge.opencodeStatus()) ?? {
    installed: false, pluginPath: "", opencodeFound: false,
  };

  const keys = [
    "anthropic-api-key", "custom-api-key",
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  clear(root);
  root.append(
    h("h1", {}, h("span", { text: "Coucou" }), h("span", { class: "version", text: version })),
    claudeSection(status),
    openCodeSection(opencode),
    chatSection(present),
    integrationsSection(present),
    generalSection(),
    h("div", {
      class: "hint",
      text: "No telemetry. Network requests only go to the services you configure yourself.",
    }),
  );

  void onEvent<Settings>("settings-changed", (s) => {
    settings = { ...settings, ...s };
  });
}

void main();
