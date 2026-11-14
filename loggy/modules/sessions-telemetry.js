import { guidedOnboardingPending, state } from "./state.js";
import { invoke } from "./tauri.js";

let snapshot, sent, timer;
let remote = { status: "unknown", refreshedAt: null };
const account = () => state.isAuthenticated && state.currentUser?.id ? `${state.currentUser?.id}:${state.currentTokenId}` : null;
let owner = account();

function flush() {
  if (!snapshot?.account || snapshot.account !== account() || !state.tosAcceptedThisRun
      || state.logoutInFlight || state.accountBanned || state.onboardingTransitionPending
      || guidedOnboardingPending() || document.visibilityState !== "visible"
      || !state.sessionsSection?.getClientRects().length) {
    sent = null;
    return;
  }
  const detail = { ...snapshot.detail, local_history_status: state.localSessionsStatus || "unknown",
    remote_history_status: remote.status };
  const key = JSON.stringify(detail);
  if (sent?.key === key && Date.now() - sent.at < 5 * 60 * 1000) return;
  const attempt = { key, at: Date.now() };
  sent = attempt;
  void invoke("log_sessions_display_snapshot", {
    userId: state.currentUser.id, detail: { ...detail, remote_refreshed_at_ms: remote.refreshedAt, rendered_at_ms: snapshot.renderedAt },
  }).catch(() => { if (sent === attempt) sent = null; });
}

function queue() {
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, 750);
}

// The existing five-second Sessions refresh also drives unchanged heartbeats.
export function trackSessionsDisplay(detail) {
  snapshot = { account: account(), detail, renderedAt: Date.now() };
  queue();
}

window.addEventListener("loggy3-account-access-changed", () => {
  if (owner === account()) return;
  owner = account();
  snapshot = sent = null;
  remote = { status: "unknown", refreshedAt: null };
  window.clearTimeout(timer);
});
window.addEventListener("loggy3-uploaded-history-changed", ({ detail }) => {
  if (owner !== account() || detail.accountKey !== state.currentUser?.id) return;
  remote.status = detail.status;
  if (detail.status === "ready") remote.refreshedAt = Date.now();
  queue();
});
for (const event of ["loggy3-layout-changed", "loggy3-sessions-changed"]) window.addEventListener(event, queue);
document.addEventListener("visibilitychange", queue);
