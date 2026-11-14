import { state } from "./state.js";
import { writeClipboardText } from "./tauri.js";

export async function copyCurrentUserEmail() {
  const email = state.currentUser?.email;
  const emailEl = document.getElementById("tab-login-label");
  if (!email || !emailEl) return;

  const originalTitle = emailEl.getAttribute("title") || "";
  try {
    await writeClipboardText(email);
    emailEl.setAttribute("title", "Copied!");
  } catch (_) {
    emailEl.setAttribute("title", "Copy failed");
  } finally {
    emailEl.querySelector(".clipboard-flash")?.remove();
    const flash = document.createElement("span");
    flash.className = "clipboard-flash";
    flash.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    emailEl.appendChild(flash);
    setTimeout(() => {
      if (flash.parentNode === emailEl) flash.remove();
    }, 800);
    setTimeout(() => emailEl.setAttribute("title", originalTitle || "Click to copy"), 1200);
  }
}

export function updateAccountSidebar() {
  const accountRow = document.getElementById("tab-login");
  const label = document.getElementById("tab-login-label");
  const authenticated = state.isAuthenticated && !!state.currentUser;
  const restoring = accountRow?.dataset.authBusy === "true" && !authenticated;
  const signingOut = state.logoutBtn?.dataset.authBusy === "true";

  if (label) {
    label.textContent = restoring
      ? "Checking session…"
      : authenticated ? state.currentUser.email || "Signed In" : "Sign In";
    label.classList.toggle("sidebar-email", authenticated);
    label.setAttribute("title", authenticated ? "Click to copy" : "Sign in");
  }
  if (accountRow) {
    accountRow.classList.toggle("sidebar-static-item", authenticated);
    accountRow.classList.toggle("sidebar-auth-busy", restoring);
    accountRow.setAttribute(
      "aria-label",
      restoring
        ? "Checking session"
        : authenticated ? "Account" : "Sign in",
    );
    accountRow.disabled = accountRow.dataset.authBusy === "true";
  }
  if (state.logoutBtn) {
    state.logoutBtn.disabled = signingOut
      || state.recordingCommandInFlight
      || state.recordingControlBusyCount > 0
      || state.authTransitionBusyCount > 0
      || state.logoutInFlight
      || state.replayCheckBusy
      || state.updateInstalling
      || !authenticated;
    const logoutLabel = state.logoutBtn.querySelector(".sidebar-label");
    if (logoutLabel && !signingOut) {
      logoutLabel.textContent = "Sign Out";
    }
  }
}
import { state } from "./state.js";
import { writeClipboardText } from "./tauri.js";

export async function copyCurrentUserEmail() {
  const email = state.currentUser?.email;
  const emailEl = document.getElementById("tab-login-label");
  if (!email || !emailEl) return;

  const originalTitle = emailEl.getAttribute("title") || "";
  try {
    await writeClipboardText(email);
    emailEl.setAttribute("title", "Copied!");
  } catch (_) {
    emailEl.setAttribute("title", "Copy failed");
  } finally {
    emailEl.querySelector(".clipboard-flash")?.remove();
    const flash = document.createElement("span");
    flash.className = "clipboard-flash";
    flash.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    emailEl.appendChild(flash);
    setTimeout(() => {
      if (flash.parentNode === emailEl) flash.remove();
    }, 800);
    setTimeout(() => emailEl.setAttribute("title", originalTitle || "Click to copy"), 1200);
  }
}

export function updateAccountSidebar() {
  const accountRow = document.getElementById("tab-login");
  const label = document.getElementById("tab-login-label");
  const authenticated = state.isAuthenticated && !!state.currentUser;
  const restoring = accountRow?.dataset.authBusy === "true" && !authenticated;
  const signingOut = state.logoutBtn?.dataset.authBusy === "true";

  if (label) {
    label.textContent = restoring
      ? "Checking session…"
      : authenticated ? state.currentUser.email || "Signed In" : "Sign In";
    label.classList.toggle("sidebar-email", authenticated);
    label.setAttribute("title", authenticated ? "Click to copy" : "Sign in");
  }
  if (accountRow) {
    accountRow.classList.toggle("sidebar-static-item", authenticated);
    accountRow.classList.toggle("sidebar-auth-busy", restoring);
    accountRow.setAttribute(
      "aria-label",
      restoring
        ? "Checking session"
        : authenticated ? "Account" : "Sign in",
    );
    accountRow.disabled = accountRow.dataset.authBusy === "true";
  }
  if (state.logoutBtn) {
    state.logoutBtn.disabled = signingOut
      || state.recordingCommandInFlight
      || state.recordingControlBusyCount > 0
      || state.authTransitionBusyCount > 0
      || state.logoutInFlight
      || state.replayCheckBusy
      || state.updateInstalling
      || !authenticated;
    const logoutLabel = state.logoutBtn.querySelector(".sidebar-label");
    if (logoutLabel && !signingOut) {
      logoutLabel.textContent = "Sign Out";
    }
  }
}
