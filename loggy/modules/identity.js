import { reportUiError } from "./errors.js";
import {
  identityAllowsAccess,
  identityStatusIsTerminal,
  legalGatesSatisfied,
  state,
} from "./state.js";
import { invoke, listen } from "./tauri.js";
import { setChosenView, updateLayout } from "./views.js";
import { updateAccountSidebar } from "./account-sidebar.js";
import {
  beginOnboardingTelemetry,
  trackIdentityStatus,
} from "./onboarding-telemetry.js";

let elements;
let pollTimer;
let pollDeadline = 0;
let activeRequest;
let visibleCommand;
let identityGeneration = 0;
let processingStartedAt = null;
let processingRefreshTimer;

function identityStatusShouldPoll(status = state.identityStatus) {
  return status === "action_required" || status === "processing" || status === "needs_review";
}

const copy = {
  unknown: {
    title: "Check your identity verification",
    get message() {
      return `${state.appName} needs a current verification status before recording can begin.`;
    },
    action: "",
  },
  not_started: {
    title: "Verify your identity to get paid",
    message: "A secure Persona page will open in your browser. Return here after you submit it.",
    action: "Verify my identity",
  },
  action_required: {
    title: "Finish your identity verification",
    get message() {
      return `Continue in the secure Persona page, then return to ${state.appName}.`;
    },
    action: "Continue with Persona",
  },
  retry_required: {
    title: "Try identity verification again",
    message: "The previous verification can’t be continued. Start a new secure Persona verification.",
    action: "Try again with Persona",
  },
  processing: {
    title: "Verification is processing",
    get message() {
      return `Persona is checking your submission. ${state.appName} updates automatically for a short time, and you can refresh the status anytime.`;
    },
    action: "",
  },
  needs_review: {
    title: "Verification needs review",
    message: "Verification may take 5–7 days. If it is still not approved after that, please contact support@loggy3.com.",
    action: "",
  },
  approved: {
    title: "Identity verified",
    message: "You’re ready to start recording.",
    action: "Go to recordings",
  },
  exempt: {
    title: "Identity verification not required",
    message: "",
    action: "",
  },
  declined: {
    title: "Verification was not approved",
    message: "If you believe this was in error, contact support@loggy3.com.",
    action: "",
  },
};

function render() {
  if (!elements) return;
  const content = copy[state.identityStatus] || copy.unknown;
  elements.title.textContent = content.title;
  elements.message.textContent = content.message;
  elements.message.hidden = !content.message;
  elements.error.textContent = state.identityError || "";
  elements.error.hidden = !state.identityError;
  elements.button.hidden = !content.action;
  elements.refresh.hidden = identityAllowsAccess() || state.identityStatus === "not_started";
  elements.button.disabled = state.identityLoading;
  elements.refresh.disabled = state.identityLoading;
  elements.button.textContent = state.identityLoading && visibleCommand === "start_identity_verification"
    ? "Opening Persona…"
    : content.action;
  elements.refresh.textContent = state.identityLoading && visibleCommand !== "start_identity_verification"
    ? "Refreshing…"
    : "Refresh status";
  elements.card.dataset.status = state.identityStatus;
  elements.card.setAttribute("aria-busy", String(state.identityLoading));
  const preparation = document.getElementById("onboarding-preparation");
  const why = document.getElementById("onboarding-identity-why");
  const next = document.getElementById("onboarding-identity-next");
  const ready = ["processing", "needs_review"].includes(state.identityStatus) && state.permissionsOk;
  why.hidden = identityAllowsAccess() || (!ready && !content.action);
  preparation.textContent = ready
    ? "Device setup is complete. You can close the app and return later. Recording unlocks when your identity is approved."
    : "We confirm every contributor is a real person so payouts reach the right person. Takes about 3 minutes.";
  document.getElementById("onboarding-identity-why-title").textContent = ready ? "Device ready" : "Why we ask";
  document.getElementById("onboarding-identity-next-title").textContent = content.action
    ? "What happens next" : "Verification status";
  document.getElementById("onboarding-identity-steps").hidden = state.identityStatus !== "not_started";
  document.getElementById("onboarding-identity-needs").hidden = state.identityStatus !== "not_started";
  next.hidden = identityAllowsAccess() && !content.message;
  if (state.identityStatus === "processing" && processingStartedAt === null) {
    processingStartedAt = Date.now();
    processingRefreshTimer = window.setTimeout(render, 10000);
  } else if (state.identityStatus !== "processing") {
    window.clearTimeout(processingRefreshTimer);
    processingStartedAt = null;
  }
  elements.card.classList.toggle("onboarding-processing-delayed", processingStartedAt !== null
    && (Date.now() - processingStartedAt >= 10000 || !!state.identityError));
}

function applyResponse(response) {
  const next = typeof response?.status === "string" && copy[response.status]
    ? response.status
    : "unknown";
  const previous = state.identityStatus;
  const previouslyAllowed = identityAllowsAccess();
  state.identityStatus = next;
  state.identityError = "";
  if (!identityAllowsAccess()) beginOnboardingTelemetry();
  trackIdentityStatus(next);
  if ((next === "exempt" && previous !== "exempt")
      || (previouslyAllowed && !identityAllowsAccess())) {
    setChosenView(null);
  }
  render();
  updateAccountSidebar();
  updateLayout();
  window.dispatchEvent(new CustomEvent("loggy3-identity-changed"));
  if (!identityStatusShouldPoll(next)) stopPolling();
  return response;
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  return error?.message || error?.error || "Identity verification is temporarily unavailable.";
}

function currentAccountKey() {
  if (!state.isAuthenticated || !state.currentUser) return null;
  return state.currentUser.id || state.currentUser.email || null;
}

function requestIsCurrent(request) {
  return request.generation === identityGeneration
    && request.accountKey === currentAccountKey();
}

async function run(command, { visible = true } = {}) {
  const accountKey = currentAccountKey();
  const generation = identityGeneration;
  if (!accountKey || (state.identityLoading && visible)) return null;
  if (!visible && activeRequest?.generation === generation) return null;
  if (visible) {
    state.identityLoading = true;
    visibleCommand = command;
    state.identityError = "";
    render();
  }
  if (activeRequest?.generation === generation) await activeRequest.promise.catch(() => null);
  if (generation !== identityGeneration || accountKey !== currentAccountKey()) return null;
  const request = {
    accountKey,
    generation,
    promise: invoke(command),
  };
  activeRequest = request;
  try {
    const response = await request.promise;
    return requestIsCurrent(request) ? applyResponse(response) : null;
  } catch (error) {
    if (!requestIsCurrent(request)) return null;
    reportUiError(`identity_${command}_failed`, error);
    if (visible) {
      state.identityError = errorMessage(error);
      render();
    }
    return null;
  } finally {
    if (activeRequest === request) activeRequest = null;
    if (visible && requestIsCurrent(request)) {
      state.identityLoading = false;
      visibleCommand = null;
      render();
    }
  }
}

export async function loadIdentityStatus(options) {
  return run("identity_status", options);
}

export async function refreshIdentityVerification(options) {
  return run("refresh_identity_verification", options);
}

async function startIdentityVerification() {
  const response = await run("start_identity_verification");
  if (response && identityStatusShouldPoll(response.status)) startPolling();
}

function poll() {
  if (Date.now() >= pollDeadline
      || !state.isAuthenticated
      || !legalGatesSatisfied()
      || !identityStatusShouldPoll()) {
    stopPolling();
    return;
  }
  loadIdentityStatus({ visible: false });
}

function startPolling() {
  stopPolling();
  if (!state.isAuthenticated || !legalGatesSatisfied() || !identityStatusShouldPoll()) return;
  pollDeadline = Date.now() + 2 * 60 * 1000;
  pollTimer = window.setInterval(poll, 2000);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  pollDeadline = 0;
}

export function openIdentityView() {
  if (!state.isAuthenticated || state.identityStatus === "exempt") return;
  setChosenView("identity");
  updateLayout();
}

export async function authenticatedIdentity() {
  if (!state.isAuthenticated || !legalGatesSatisfied()) return;
  identityGeneration += 1;
  const generation = identityGeneration;
  state.identityChecking = true;
  activeRequest = null;
  stopPolling();
  state.identityStatus = "unknown";
  state.identityLoading = false;
  state.identityError = "";
  visibleCommand = null;
  setChosenView(null);
  render();
  updateLayout();
  try {
    let response = await loadIdentityStatus();
    if (response && response.status !== "not_started" && !identityStatusIsTerminal(response.status)) {
      response = await refreshIdentityVerification({ visible: false }) || response;
    }
    if (generation !== identityGeneration) return;
    if (response && identityStatusShouldPoll(response.status)) startPolling();
  } finally {
    if (generation === identityGeneration) {
      state.identityChecking = false;
      updateLayout();
    }
  }
}

export function signedOutIdentity() {
  identityGeneration += 1;
  state.identityChecking = false;
  activeRequest = null;
  stopPolling();
  state.identityStatus = "unknown";
  state.identityLoading = false;
  state.identityError = "";
  visibleCommand = null;
  render();
  updateLayout();
}

export function initIdentityVerification() {
  elements = {
    card: document.getElementById("identity-card"),
    title: document.getElementById("identity-title"),
    message: document.getElementById("identity-message"),
    button: document.getElementById("identity-action"),
    refresh: document.getElementById("identity-refresh"),
    error: document.getElementById("identity-error"),
  };
  elements.button.addEventListener("click", () => {
    if (state.identityStatus === "approved") {
      setChosenView("sessions");
      updateLayout();
    } else if (state.identityStatus === "not_started"
        || state.identityStatus === "action_required"
        || state.identityStatus === "retry_required") {
      startIdentityVerification();
    } else {
      refreshIdentityVerification();
    }
  });
  elements.refresh.addEventListener("click", () => refreshIdentityVerification());
  window.addEventListener("focus", async () => {
    if (!state.isAuthenticated || !legalGatesSatisfied()) return;
    const response = await refreshIdentityVerification({ visible: false });
    if (response && identityStatusShouldPoll(response.status)) startPolling();
  });
  window.addEventListener("loggy3-view-changed", (event) => {
    if (event.detail?.name === "identity" && identityStatusShouldPoll()) startPolling();
    else if (!identityStatusShouldPoll()) stopPolling();
  });
  window.addEventListener("loggy3-authenticated", authenticatedIdentity);
  window.addEventListener("loggy3-signed-out", signedOutIdentity);
  listen("identity-status-changed", ({ payload }) => {
    if (payload?.userId !== currentAccountKey()) return;
    applyResponse(payload);
  }).catch((error) => reportUiError("identity_status_listener_failed", error));
  render();
}
