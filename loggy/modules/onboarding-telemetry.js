import { guidedOnboardingPending, state } from "./state.js";
import { invoke } from "./tauri.js";

const FLOW_VERSION = 2;

let active = false;
let flowCompleted = false;
let flowId = null;
let sendQueue = Promise.resolve();
const emittedEvents = new Set();

function programType() {
  if (state.selfServeUser) return "self_serve";
  if (state.isAuthenticated && state.agreementSatisfied) return "non_self_serve";
  return "unknown";
}

function emitOnce(event, detail = {}) {
  if (!active || emittedEvents.has(event)) return Promise.resolve();
  emittedEvents.add(event);
  const payload = {
    event,
    flowId,
    detail: {
      flow_version: FLOW_VERSION,
      program_type: programType(),
      ...detail,
    },
  };
  sendQueue = sendQueue.then(() => invoke("log_onboarding_event", payload)).catch(() => {});
  return sendQueue;
}

export function beginOnboardingTelemetry() {
  if (active) return false;
  if (flowCompleted) {
    emittedEvents.clear();
    flowCompleted = false;
  }
  flowId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  active = true;
  return true;
}

export function resetOnboardingTelemetry() {
  active = false;
  flowCompleted = false;
  flowId = null;
  emittedEvents.clear();
}

export function trackOnboardingView(view) {
  if (view === "sessions" && guidedOnboardingPending()) beginOnboardingTelemetry();
  if (!active) return;
  if (view === "legal" && state.legalAcceptancePending) {
    const page = state.currentLegalPage === "privacy" ? "privacy" : "terms";
    void emitOnce(`onboarding.${page}.viewed`);
  } else if (view === "auth") {
    void emitOnce("onboarding.sign_in.viewed");
  } else if (view === "recording-consent") {
    void emitOnce("onboarding.recording_consent.viewed");
  } else if (view === "permissions") {
    void emitOnce("onboarding.permissions.viewed");
  } else if (view === "identity") {
    void emitOnce("onboarding.identity.viewed");
  } else if (view === "sessions" && guidedOnboardingPending()) {
    void emitOnce("onboarding.first_recording.viewed");
  } else if (view === "sessions") {
    const completedFlowId = flowId;
    void trackOnboardingEvent("onboarding.flow.completed").then(() => {
      if (flowId !== completedFlowId) return;
      active = false;
      flowCompleted = true;
    });
  }
}

export function trackOnboardingEvent(event, detail = {}) {
  return emitOnce(event, detail);
}

export function trackIdentityStatus(status) {
  const events = {
    not_started: "onboarding.identity.not_started",
    action_required: "onboarding.identity.action_required",
    retry_required: "onboarding.identity.retry_required",
    processing: "onboarding.identity.processing",
    needs_review: "onboarding.identity.needs_review",
    approved: "onboarding.identity.approved",
    exempt: "onboarding.identity.exempt",
    declined: "onboarding.identity.declined",
  };
  const event = events[status];
  if (event) void emitOnce(event);
  if (status === "approved" || status === "exempt") {
    void emitOnce("onboarding.identity.completed", { result: status });
  }
}
