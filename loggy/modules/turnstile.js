import { reportUiError } from "./errors.js";
import { invoke } from "./tauri.js";

let onTokenChange = () => {};
let origin = "";
let widgetUrl = "";
let loadTimeout;
let active = false;
let loadGeneration = 0;
const LOAD_ERROR = "Security check couldn’t load";

function element(id) {
  return document.getElementById(id);
}

function clearLoadTimeout() {
  if (loadTimeout) clearTimeout(loadTimeout);
  loadTimeout = null;
}

function setStatus(message, state, showFrame = state === "ready" || state === "error", detail = "") {
  const container = element("auth-turnstile");
  const status = element("auth-turnstile-status");
  const description = element("auth-turnstile-detail");
  const frame = element("auth-turnstile-frame");
  const retry = element("auth-turnstile-retry");
  if (container) container.dataset.state = state;
  if (status) status.textContent = message;
  if (description) {
    description.textContent = detail;
    description.hidden = !detail;
  }
  if (frame) frame.hidden = !showFrame;
  if (retry) retry.hidden = state !== "error";
}

function beginLoad(message = "Loading…") {
  clearLoadTimeout();
  setStatus(message, "loading");
  loadTimeout = window.setTimeout(() => {
    reportUiError("auth_turnstile_load_timeout", new Error("Security check did not become ready"));
    setStatus(LOAD_ERROR, "error", false, "Check your connection, then try again.");
  }, 12_000);
}

function handleMessage(event) {
  const frame = element("auth-turnstile-frame");
  if (
    !active
    || !frame
    || !origin
    || event.origin !== origin
    || event.source !== frame.contentWindow
    || event.data?.source !== "loggy3-turnstile"
  ) return;

  if (event.data.type === "token") {
    const token = event.data.token;
    if (typeof token !== "string" || token.length === 0 || token.length > 2048) return;
    clearLoadTimeout();
    setStatus("Complete", "complete");
    onTokenChange(token);
    return;
  }
  if (event.data.type === "error") {
    clearLoadTimeout();
    const code = typeof event.data.code === "string" && /^[a-z0-9_-]{1,64}$/i.test(event.data.code)
      ? event.data.code : "unknown";
    reportUiError("auth_turnstile_widget_error", new Error(`Security check failed: ${code}`));
    setStatus(
      code === "script_load_failed" ? LOAD_ERROR : "Let’s try that check again",
      "error", code !== "script_load_failed",
      code === "script_load_failed" ? "Check your connection, then try again."
        : "Please retry. If it keeps failing, contact support@loggy3.com.",
    );
    onTokenChange("");
    return;
  }
  if (event.data.type === "expired") {
    clearLoadTimeout();
    setStatus("Complete the check below.", "ready");
    onTokenChange("");
    return;
  }
  if (event.data.type === "ready" || event.data.type === "reset") {
    clearLoadTimeout();
    setStatus("Complete the check below.", "ready");
  }
}

export function initTurnstileController(tokenChanged) {
  onTokenChange = tokenChanged;
  window.addEventListener("message", handleMessage);
  element("auth-turnstile-retry")?.addEventListener("click", startTurnstile);
}

export function setTurnstileVisible(visible) {
  const container = element("auth-turnstile");
  if (container) container.hidden = !visible;
}

export async function startTurnstile() {
  const frame = element("auth-turnstile-frame");
  if (!frame) return;

  active = true;
  onTokenChange("");
  const generation = ++loadGeneration;
  beginLoad();
  try {
    if (!widgetUrl) widgetUrl = await invoke("turnstile_widget_url");
    if (!active || generation !== loadGeneration) return;
    const parsed = new URL(widgetUrl);
    if (parsed.protocol !== "https:") throw new Error("Security check URL must use HTTPS");
    origin = parsed.origin;
    parsed.searchParams.set("attempt", String(Date.now()));
    frame.src = parsed.toString();
  } catch (error) {
    if (!active || generation !== loadGeneration) return;
    clearLoadTimeout();
    reportUiError("auth_turnstile_load_failed", error);
    setStatus(LOAD_ERROR, "error", false, "Check your connection, then try again.");
  }
}

export function resetTurnstile() {
  if (!active) return;
  onTokenChange("");
  beginLoad("Refreshing…");
  const frame = element("auth-turnstile-frame");
  if (frame?.contentWindow && origin) {
    frame.contentWindow.postMessage(
      { source: "loggy3-turnstile-parent", type: "reset" },
      origin,
    );
  } else {
    startTurnstile();
  }
}

export function stopTurnstile() {
  active = false;
  loadGeneration += 1;
  origin = "";
  clearLoadTimeout();
  onTokenChange("");
  const frame = element("auth-turnstile-frame");
  if (frame) frame.removeAttribute("src");
  setStatus("Loading…", "loading");
}
