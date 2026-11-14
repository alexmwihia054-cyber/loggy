// The DEBUG tools: the replay-test game (with its per-run log view) and the log/env
// browser. Always available, including release builds — the game and the logs are how a
// field failure gets diagnosed on a machine that has no terminal attached.

import { legalGatesSatisfied, state } from "./state.js";
import { invoke, writeClipboardText } from "./tauri.js";
import { setChosenView, updateLayout } from "./views.js";

let logAutoTimer = null;
let logLines = [];
// Wall-clock start of the current game run, so its log can be shown without the noise of
// every earlier run in the same app-log.
let gameStartedMs = 0;
let gameLogVisible = false;
let lastDebugReport = null;

function loadGame() {
  const frame = document.getElementById("game-frame");
  if (!frame) return;
  gameStartedMs = Date.now();
  setGameLogVisible(false);
  const seed = Math.floor(Math.random() * 100000);
  const platform = navigator.userAgent.includes("Windows") ? "windows" : "macos";
  frame.src = `assets/e2e.html?seed=${seed}&r=14&phase=record&platform=${platform}`;
}

/// Toggle between the game and this run's log, keeping the panel the same height.
function setGameLogVisible(visible) {
  gameLogVisible = visible;
  const frame = document.getElementById("game-frame");
  const body = document.getElementById("game-log-body");
  const btn = document.getElementById("game-log");
  if (frame) frame.style.display = visible ? "none" : "block";
  if (body) body.style.display = visible ? "block" : "none";
  if (btn) btn.textContent = visible ? "Hide Log" : "Copy Log";
}

/// Show and copy everything logged since this game run started.
///
/// Not just the game's own reports: if the recorder died or the drive vanished mid-run,
/// that is the line that explains the run, and it is written by the GUI rather than the
/// game. So the filter is the time window, not the event kind.
async function showGameLog() {
  const body = document.getElementById("game-log-body");
  const status = document.getElementById("game-status");
  const btn = document.getElementById("game-log");
  if (!body) return;

  let lines = [];
  try {
    lines = await invoke("read_log", { which: "app", maxLines: 2000 });
  } catch (e) {
    setGameLogVisible(true);
    body.textContent = `cannot read app-log: ${e}`;
    return;
  }

  const mine = lines.filter((l) => {
    try {
      const event = JSON.parse(l);
      return (event.occurred_at_ms || event.wall_ms || 0) >= gameStartedMs;
    } catch {
      // A line that will not parse cannot be placed in time; keeping it would attribute
      // it to a run it may not belong to.
      return false;
    }
  });

  setGameLogVisible(true);
  body.textContent = mine.length
    ? mine.join("\n")
    : "Nothing logged for this run yet. The game reports at each stage and on completion;\n" +
      "start recording first if you want the reports tied to a session.";
  body.scrollTop = body.scrollHeight;

  if (mine.length) {
    try {
      await writeClipboardText(mine.join("\n"));
      if (status) status.textContent = `${mine.length} lines copied`;
    } catch {
      if (status) status.textContent = "copy failed — select and copy manually";
    }
  } else if (status) {
    status.textContent = "";
  }
  if (btn) btn.textContent = "Hide Log";
}

/// Show one of the two DEBUG tools, stopping the log poll when the logs are not visible.
function showDebugPane(pane) {
  const panes = { game: "dbg-pane-game", logs: "dbg-pane-logs" };
  for (const [name, id] of Object.entries(panes)) {
    const el = document.getElementById(id);
    if (el) el.style.display = name === pane ? "block" : "none";
  }
  if (pane === "game") {
    stopLogAuto();
    // Loaded lazily and kept afterwards, so switching to the logs and back does not
    // discard the run in progress.
    const frame = document.getElementById("game-frame");
    if (frame && !frame.src) loadGame();
  } else {
    refreshEnv();
    refreshLogs();
    syncLogAuto();
  }
}

/// Sidebar click handler for both DEBUG items.
function selectDebugPane(pane) {
  if (pane === "logs") {
    if (!state.isAuthenticated || !state.tosAcceptedThisRun) return;
  } else if (!legalGatesSatisfied()) return;
  if (pane === "game" && !state.permissionsOk) return;
  state.debugPane = pane;
  setChosenView("debug");
  showDebugPane(pane);
  updateLayout();
}

const LOG_SOURCES = ["app", "kernel", "sessions"];

/// Fields that are either shown in their own column or are the same on every line, so
/// repeating them in the detail tail is noise.
const LOG_FIELDS_HIDDEN = new Set([
  "wall_ms", "occurred_at_ms", "kind", "event", "message", "source", "severity",
  "platform", "app_version", "schema_version", "fields",
  // View-only fields this module attaches; echoing _raw would duplicate the whole entry.
  "_src", "_raw",
]);

function logTime(ms) {
  if (!ms) return "--:--:--";
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/// Render one entry as an aligned line instead of a JSON blob.
///
/// Raw JSON is what the file holds, but reading it means finding `message` inside sixty
/// characters of framing on every line. The interesting fields lead; whatever else the
/// entry carries follows as `key=value`, so nothing is dropped — turn on `raw` to see the
/// original.
function formatLogEntry(e) {
  const src = e._src ? e._src.padEnd(8) : "";
  const kind = (e.event || e.kind || "-").padEnd(32);
  const severity = (e.severity || "info").padEnd(6);
  const rest = Object.keys(e)
    .filter((k) => !LOG_FIELDS_HIDDEN.has(k) && e[k] !== null && e[k] !== undefined)
    .map((k) => {
      const v = e[k];
      return `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`;
    })
    .join("  ");
  const fieldTail = e.fields && typeof e.fields === "object"
    ? Object.entries(e.fields).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`).join("  ")
    : "";
  const tails = [rest, fieldTail].filter(Boolean).join("  ");
  return `${logTime(e.occurred_at_ms || e.wall_ms)}  ${src}${severity}${kind}${e.message || ""}${tails ? "   " + tails : ""}`;
}

function renderLogs() {
  const body = document.getElementById("log-body");
  const meta = document.getElementById("log-meta");
  if (!body) return;
  const filterEl = document.getElementById("log-filter");
  const rawEl = document.getElementById("log-raw");
  const raw = !!(rawEl && rawEl.checked);
  const needle = (filterEl ? filterEl.value : "").trim().toLowerCase();

  // Filter on the rendered text, so what you type matches what you see.
  const rendered = logLines.map((e) => (raw ? e._raw : formatLogEntry(e)));
  const shown = needle
    ? rendered.filter((l) => l.toLowerCase().includes(needle))
    : rendered;

  // Newest first: when something has just gone wrong, the relevant line is the last one
  // written, and scrolling to the bottom of a few thousand lines to find it is friction.
  body.textContent = shown.slice().reverse().join("\n");
  body.scrollTop = 0;
  if (meta) {
    const suffix = needle ? ` matching "${needle}"` : "";
    meta.textContent = `${shown.length} of ${logLines.length} entries${suffix} — newest first`;
  }
}

/// Parse one log file's lines into entries tagged with their source.
///
/// A line that will not parse is still shown rather than dropped — a truncated write is
/// itself a symptom, and silently hiding it would make the log look healthy.
function parseLogLines(lines, src) {
  return lines.map((raw) => {
    let e;
    try {
      e = JSON.parse(raw);
      if (typeof e !== "object" || e === null) e = { message: raw };
    } catch {
      e = { kind: "unparsed", message: raw };
    }
    e._src = src;
    e._raw = raw;
    return e;
  });
}

async function refreshLogs() {
  const which = (document.getElementById("log-which") || {}).value || "all";
  const meta = document.getElementById("log-meta");
  const wanted = which === "all" ? LOG_SOURCES : [which];
  try {
    const perSource = await Promise.all(
      wanted.map((src) =>
        invoke("read_log", { which: src, maxLines: 2000 }).then((l) => parseLogLines(l, src)),
      ),
    );
    // Interleaved by time: the whole point of "all logs" is seeing that the kernel died
    // right when the GUI noticed the drive go away.
    logLines = perSource.flat().sort(
      (a, b) => (a.occurred_at_ms || a.wall_ms || 0) - (b.occurred_at_ms || b.wall_ms || 0),
    );
    renderLogs();
    if (logLines.length === 0 && meta) {
      const dir = await invoke("log_location").catch(() => null);
      meta.textContent = dir ? `nothing logged yet in ${dir}` : "nothing logged yet";
    }
  } catch (e) {
    logLines = [];
    renderLogs();
    // The usual cause is the external sessions drive being unplugged, which is worth
    // saying out loud rather than showing an empty pane.
    if (meta) meta.textContent = `cannot read logs: ${e}`;
  }
}

/// Render the environment snapshot as a flat key/value grid.
function renderEnv(report) {
  const el = document.getElementById("log-env");
  if (!el) return;
  el.innerHTML = "";
  const flat = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, key);
      else flat.push([key, v === null || v === undefined ? "—" : String(v)]);
    }
  };
  walk(report, "");
  for (const [k, v] of flat) {
    const kEl = document.createElement("span");
    kEl.textContent = k;
    kEl.style.color = "var(--vlc-muted)";
    kEl.style.whiteSpace = "nowrap";
    const vEl = document.createElement("span");
    vEl.textContent = v;
    vEl.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    vEl.style.wordBreak = "break-all";
    // Anything that stops a recording should be findable without reading every row.
    const bad = v === "false" && /permissions|available/.test(k);
    const preflightFail = k.includes("preflight.") && !v.startsWith("ok") && v !== "—";
    if (bad || preflightFail || (k.endsWith("last_error") && v !== "—")) {
      vEl.style.color = "#e53e3e";
    }
    el.append(kEl, vEl);
  }
}

async function refreshEnv() {
  try {
    lastDebugReport = await invoke("debug_report");
    renderEnv(lastDebugReport);
  } catch (e) {
    lastDebugReport = { error: String(e) };
    renderEnv(lastDebugReport);
  }
}

/// Everything, unfiltered, in one paste: the environment snapshot then every log in full
/// raw form. This is the button for handing a problem to someone else, so it must not be
/// narrowed by whatever filter happens to be typed.
async function copyAllLogs() {
  const parts = [
    "===== loggy3 debug report =====",
    JSON.stringify(lastDebugReport || {}, null, 2),
  ];
  for (const src of LOG_SOURCES) {
    let lines = [];
    try {
      lines = await invoke("read_log", { which: src, maxLines: 5000 });
    } catch (e) {
      lines = [`<unreadable: ${e}>`];
    }
    parts.push(`\n===== ${src}-log.jsonl (${lines.length} lines) =====`);
    parts.push(lines.length ? lines.join("\n") : "<empty>");
  }
  return parts.join("\n");
}

export function stopLogAuto() {
  if (logAutoTimer) {
    clearInterval(logAutoTimer);
    logAutoTimer = null;
  }
}

function syncLogAuto() {
  stopLogAuto();
  const auto = document.getElementById("log-auto");
  if (auto && auto.checked && state.chosenView === "debug" && state.debugPane === "logs") {
    logAutoTimer = setInterval(refreshLogs, 2000);
  }
}

export function initDebugTools() {
  for (const pane of ["game", "logs"]) {
    const tab = document.getElementById(`tab-debug-${pane}`);
    if (tab) tab.addEventListener("click", () => selectDebugPane(pane));
  }
  const restart = document.getElementById("game-restart");
  if (restart) restart.addEventListener("click", loadGame);
  const gameLog = document.getElementById("game-log");
  if (gameLog) {
    gameLog.addEventListener("click", () => {
      if (gameLogVisible) setGameLogVisible(false);
      else showGameLog();
    });
  }

  const which = document.getElementById("log-which");
  if (which) which.addEventListener("change", refreshLogs);
  const filter = document.getElementById("log-filter");
  if (filter) filter.addEventListener("input", renderLogs);
  const refresh = document.getElementById("log-refresh");
  if (refresh) {
    refresh.addEventListener("click", () => { refreshEnv(); refreshLogs(); });
  }
  const auto = document.getElementById("log-auto");
  if (auto) auto.addEventListener("change", syncLogAuto);
  const rawToggle = document.getElementById("log-raw");
  if (rawToggle) rawToggle.addEventListener("change", renderLogs);

  const flash = (btn, text) => {
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
  };

  const copy = document.getElementById("log-copy");
  if (copy) {
    copy.addEventListener("click", async () => {
      const body = document.getElementById("log-body");
      if (!body) return;
      try {
        // Copies exactly what is on screen, so a filter doubles as "copy just these".
        await writeClipboardText(body.textContent);
        flash(copy, "Copied");
      } catch {
        flash(copy, "Copy failed");
      }
    });
  }
  const copyAll = document.getElementById("log-copy-all");
  if (copyAll) {
    copyAll.addEventListener("click", async () => {
      try {
        await refreshEnv();
        await writeClipboardText(await copyAllLogs());
        flash(copyAll, "Copied all");
      } catch {
        flash(copyAll, "Copy failed");
      }
    });
  }
  const exportButton = document.getElementById("log-export");
  if (exportButton) {
    exportButton.addEventListener("click", async () => {
      exportButton.disabled = true;
      try {
        const path = await invoke("export_diagnostics");
        flash(exportButton, path ? "Exported" : "Cancelled");
      } catch {
        flash(exportButton, "Export failed");
      } finally {
        exportButton.disabled = false;
      }
    });
  }
}
