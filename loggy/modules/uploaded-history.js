// Uploads from every machine on the account. The sessions chart adds the ones that aren't on this
// disk, the estimate prices them all, and onboarding uses the all-time total to recognize a
// returning contributor. Only sessions that started or finished uploading from `since` onward are
// fetched; the window widens as the chart pages back.
// The response also carries the tier history that prices the chart's estimate: it is refetched
// when the tier changes, and history ahead of the account asks for the account to be checked.
// It carries the referral program too (state.referrals), whose bonuses are paid with uploads.

import { state } from "./state.js";
import { invoke } from "./tauri.js";
import { paysLike, rateKey } from "./rates.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Onboarding holds a new account after the Terms until the referral program loads (referralCodeUnknown in state.js),
// so the code screen keeps its place. An account's first load that fails is tried again after these delays before
// onboarding goes on without the screen, which would otherwise come back on a later, successful load.
const FIRST_LOAD_RETRY_MS = [2000, 6000];

let accountKey = null;
let accountRate = null;
let generation = 0;
let coveredSince = null;
let latestRequest = null;
let inFlight = null;
let lastRefreshAt = -Infinity;
let firstLoadRetries = 0;
let firstLoadRetryTimer = null;

function currentAccountKey() {
  if (!state.isAuthenticated || !state.currentUser) return null;
  return state.currentUser.id || state.currentUser.email || null;
}

// The chart opens on this week, this month or this UTC pay period; two extra days cover UTC days
// that straddle the first local day.
function defaultSince() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const payPeriod = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() <= 14 ? 1 : 15);
  return Math.min(monday.getTime(), firstOfMonth.getTime(), payPeriod) - 2 * DAY_MS;
}

function cancelFirstLoadRetry() {
  if (firstLoadRetryTimer === null) return;
  window.clearTimeout(firstLoadRetryTimer);
  firstLoadRetryTimer = null;
}

function announce(detail) {
  window.dispatchEvent(new CustomEvent("loggy3-uploaded-history-changed", { detail }));
}

// Refetches the current window, or widens it to `since` (epoch ms) when that is earlier.
export async function refreshUploadedHistory({ since, ifStale = false } = {}) {
  const key = currentAccountKey();
  if (!key || (ifStale && Date.now() - lastRefreshAt < 60 * 1000)) return;
  const from = Math.min(Number.isFinite(since) ? since : Infinity, coveredSince ?? defaultSince());
  if (inFlight?.key === key && inFlight.generation === generation && inFlight.since <= from) {
    await inFlight.promise.catch(() => {});
    return;
  }

  lastRefreshAt = Date.now();
  const request = {
    key,
    generation,
    since: from,
    promise: invoke("get_uploaded_sessions", { since: new Date(from).toISOString() }),
  };
  inFlight = request;
  latestRequest = request;
  coveredSince = from;
  // A newer request always covers at least as much, so only the latest one may answer.
  const isCurrent = () => request === latestRequest && request.generation === generation
    && key === currentAccountKey();
  announce({ accountKey: key, status: "loading" });
  try {
    const history = await request.promise;
    if (!Array.isArray(history?.sessions) || !Number.isFinite(history.total_seconds)) {
      throw new Error("Invalid uploaded recordings");
    }
    if (isCurrent()) {
      const rateHistory = history.rate_history || [];
      state.referrals = history.referrals ?? null;
      state.referralsStatus = "ready";
      announce({
        accountKey: key,
        status: "ready",
        since: from,
        totalSeconds: history.total_seconds,
        earliestSessionAt: history.earliest_session_at,
        sessions: history.sessions,
        rateHistory,
      });
      // The account's tier followed by a later one: the account hasn't caught up with a change.
      const tier = state.currentUser?.rateTier;
      if (!paysLike(rateHistory.at(-1), tier) && rateHistory.some((period) => paysLike(period, tier))) {
        void invoke("refresh_account_status_soon").catch(() => {});
      }
    }
  } catch (_) {
    // Keep the last loaded history.
    if (isCurrent()) {
      if (state.referralsStatus !== "ready" && firstLoadRetries < FIRST_LOAD_RETRY_MS.length) {
        // Still loading, as far as anyone waiting on it can tell.
        cancelFirstLoadRetry();
        firstLoadRetryTimer = window.setTimeout(() => {
          firstLoadRetryTimer = null;
          if (key === currentAccountKey() && state.referralsStatus !== "ready") void refreshUploadedHistory();
        }, FIRST_LOAD_RETRY_MS[firstLoadRetries]);
        firstLoadRetries += 1;
        return;
      }
      if (state.referralsStatus !== "ready") state.referralsStatus = "error";
      announce({ accountKey: key, status: "error" });
    }
  } finally {
    if (inFlight === request) inFlight = null;
  }
}

// Fetches again, dropping any request in flight: its answer may predate a change the caller just
// made on the server.
export function reloadUploadedHistory() {
  generation += 1;
  return refreshUploadedHistory();
}

window.addEventListener("loggy3-account-access-changed", () => {
  const key = currentAccountKey();
  const rate = rateKey(state.currentUser?.rateTier);
  if (key === accountKey) {
    // History from before a tier change, even a request in flight, can't price recordings since.
    if (key && rate !== accountRate) {
      generation += 1;
      void refreshUploadedHistory();
    }
    accountRate = rate;
    return;
  }
  accountKey = key;
  accountRate = rate;
  generation += 1;
  state.referrals = null;
  state.referralsStatus = key ? "loading" : null;
  state.referralCodeApplied = false;
  firstLoadRetries = 0;
  cancelFirstLoadRetry();
  coveredSince = null;
  lastRefreshAt = -Infinity;
  latestRequest = null;
  inFlight = null;
  if (key) void refreshUploadedHistory();
});
