// Uncaught-error reporting and the non-blocking error banner. Imported first from
// main.js, so the handlers install (module side effect) before any code that can throw —
// including the DOMContentLoaded handler, whose failures used to leave no trace at all.

import { invoke } from "./tauri.js";

const MAX_REPORTS = 20;
const seen = new Set();
let reported = 0;
const trim = (value) => (value ? String(value).slice(0, 2000) : "");

export function reportUiError(kind, error, context = {}) {
  const detail = {
    message: error && error.message ? String(error.message) : String(error || "unknown"),
    source: context.source || "",
    line: context.line || 0,
    column: context.column || 0,
    stack: trim(error && error.stack),
  };
  const key = `${kind}:${detail.message}@${detail.source}:${detail.line}`;
  if (seen.has(key) || reported >= MAX_REPORTS) return;
  seen.add(key);
  reported += 1;
  try {
    invoke("log_ui_error", { kind, detail }).catch(() => {});
  } catch {}
}

// Report uncaught frontend errors to app-log.jsonl.
//
// `unhandledrejection` is the one that matters: init is an async function full of awaits,
// so a throw inside it becomes a rejected promise, which `error` never sees.
(function installErrorReporting() {
  window.addEventListener("error", (e) => {
    reportUiError("error", e && (e.error || e.message), {
      source: (e && e.filename) || "",
      line: (e && e.lineno) || 0,
      column: (e && e.colno) || 0,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    reportUiError("unhandledrejection", r);
  });
})();

// Non-blocking error surface for every failure path in the frontend. alert() blocks the
// JS event loop, which stops the 2s ui_heartbeat — so the watchdog concluded the webview
// was dead and reloaded the window out from under the dialog the user was reading.
// Stays until dismissed; repeated calls reuse the one banner.
export function showErrorBanner(message) {
  let el = document.getElementById("error-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "error-banner";
    el.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:1000;" +
      "max-width:80%;padding:10px 14px;border-radius:8px;background:#e53e3e;color:#fff;" +
      "font-size:13px;display:flex;gap:12px;align-items:center;" +
      "box-shadow:0 4px 12px rgba(0,0,0,.35)";
    const text = document.createElement("span");
    text.id = "error-banner-text";
    const close = document.createElement("button");
    close.textContent = "×";
    close.style.cssText =
      "background:none;border:none;color:#fff;font-size:16px;cursor:pointer;line-height:1";
    close.addEventListener("click", () => el.remove());
    el.append(text, close);
    document.body.appendChild(el);
  }
  el.querySelector("#error-banner-text").textContent = message;
}
