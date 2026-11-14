// The OS-permissions gate (Screen Recording + Input Monitoring) and its poll. The poll
// exists for the gate and stops once everything is granted — unless the Permissions view
// is deliberately open, where it keeps showing live state.

import { legalGatesSatisfied, state } from "./state.js";
import { invoke } from "./tauri.js";
import { reportUiError } from "./errors.js";
import { updateLayout } from "./views.js";
import {
  beginOnboardingTelemetry,
  trackOnboardingEvent,
} from "./onboarding-telemetry.js";

let permissionsPollInterval;
let permissionsRefreshVersion = 0;

function setPermissionRow(statusEl, granted) {
  if (!statusEl) return;
  statusEl.textContent = granted ? "✓" : "✗";
  statusEl.style.color = granted ? "#22a06b" : "#d4380d";
  statusEl.parentElement.dataset.granted = String(!!granted);
}

export async function refreshPermissions() {
  const refreshVersion = ++permissionsRefreshVersion;
  state.permissionsChecking = state.permissionStatus === null;
  updateLayout();
  try {
    const status = await invoke("permissions_status");
    if (refreshVersion !== permissionsRefreshVersion) return true;
    const wasOk = state.permissionsOk;
    state.permissionsOk = !!status.all_granted;
    state.permissionStatus = status;
    if (!state.permissionsOk && state.isAuthenticated && legalGatesSatisfied()) {
      beginOnboardingTelemetry();
    }
    setPermissionRow(document.getElementById("perm-screen-status"), status.screen_recording);
    setPermissionRow(document.getElementById("perm-input-status"), status.input_monitoring);
    const replayRow = document.getElementById("perm-replay-row");
    if (replayRow) {
      replayRow.style.display = status.replay_accessibility_required ? "flex" : "none";
    }
    setPermissionRow(
      document.getElementById("perm-replay-status"),
      status.replay_accessibility,
    );
    // Polling exists for the gate, so it normally stops the moment everything is granted.
    // Keep it running while the Permissions view is deliberately open, otherwise that view
    // shows a snapshot from whenever the gate last cleared and a revoke made in System
    // Settings would not appear.
    if (state.permissionsOk && state.chosenView !== "permissions") {
      stopPermissionsPolling();
    }
    if (state.permissionsOk && !wasOk) {
      await trackOnboardingEvent("onboarding.permissions.completed");
      updateLayout();
      if (state.permissionsOk) {
        window.dispatchEvent(new Event("loggy3-permissions-ready"));
      }
    }
    return true;
  } catch (error) {
    if (refreshVersion !== permissionsRefreshVersion) return false;
    reportUiError("permission_check_failed", error);
    state.permissionsOk = false;
    return false;
  } finally {
    if (refreshVersion === permissionsRefreshVersion) {
      state.permissionsChecking = false;
      updateLayout();
    }
  }
}

export function markPermissionsGranted() {
  permissionsRefreshVersion += 1;
  state.permissionsChecking = false;
  const wasOk = state.permissionsOk;
  state.permissionsOk = true;
  state.permissionStatus = null;
  if (!wasOk) void trackOnboardingEvent("onboarding.permissions.completed");
  if (state.chosenView !== "permissions") stopPermissionsPolling();
  updateLayout();
  if (!wasOk) window.dispatchEvent(new Event("loggy3-permissions-ready"));
}

export function startPermissionsPolling() {
  if (permissionsPollInterval) return;
  permissionsPollInterval = setInterval(refreshPermissions, 1500);
}

export function stopPermissionsPolling() {
  if (permissionsPollInterval) {
    clearInterval(permissionsPollInterval);
    permissionsPollInterval = null;
  }
}

export async function initPermissionsGate() {
  const statusAvailable = await refreshPermissions();
  if (!statusAvailable) {
    startPermissionsPolling();
    return;
  }
  if (!state.permissionsOk) {
    beginOnboardingTelemetry();
    // Fire the one-time OS prompts (no-op if already denied once); from here the user
    // grants via System Settings and the poll picks it up.
    try { await invoke("request_permissions"); } catch (_) {}
    startPermissionsPolling();
    updateLayout();
  }
}
