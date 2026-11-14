// View routing: which panel is on screen, which sidebar item looks selected, and the
// one function (updateLayout) that renders the choice. Every navigation entry point
// funnels through setChosenView so views cannot strand each other's highlights.

import {
  guidedOnboardingPending,
  identityAllowsAccess,
  legalGatesSatisfied,
  onboardingIntroPending,
  recorderNeedsControl,
  referralCodePending,
  referralCodeUnknown,
  referralsAvailable,
  state,
} from "./state.js";
import { stopLogAuto } from "./debug.js";
import { reportUiError } from "./errors.js";
import { trackOnboardingView } from "./onboarding-telemetry.js";
import {
  refreshPermissions,
  startPermissionsPolling,
  stopPermissionsPolling,
} from "./permissions.js";
import { invoke } from "./tauri.js";
import { renderRateTier } from "./rates.js";

// Shown on each legal screen when the account accepted an earlier version.
export const LEGAL_DOCUMENTS_UPDATED_NOTICE =
  "Our policies have been updated. Please review and accept again to continue.";
// Shown in place of the Terms while the server that serves them can't be reached.
export const LEGAL_DOCUMENTS_UNAVAILABLE_NOTICE = "Can’t reach Loggy3. Retrying automatically…";

let agreementWindowExpanded = false;
let transitionTimer = null;
let transitionAccount = null;

function pendingCheck() {
  if (!state.isAuthenticated || state.accountBanned || state.logoutInFlight
      || recorderNeedsControl() || state.replayCheckNeedsControl) return "";
  if (guidedOnboardingPending() && !state.onboardingWelcomePending
      && (state.recordingHistoryStatus === "loading" || state.localSessionsStatus === "loading")
      && !state.lastSessions.some((session) => session.owned_by_current_user)) {
    return "Checking your recordings…";
  }
  if (!state.tosAcceptedThisRun || state.legalAcceptancePending) return "";
  if (referralCodeUnknown()) return "Checking your account…";
  if (state.authTransitionBusyCount > 0
      || state.agreementChecking || state.identityChecking || state.permissionsChecking) {
    return "Checking your account…";
  }
  return "";
}

function holdPendingTransition() {
  const message = pendingCheck();
  const account = state.currentUser?.id;
  const indicator = document.getElementById("onboarding-transition-status");
  if (transitionAccount !== account || !message) {
    if (transitionTimer !== null) window.clearTimeout(transitionTimer);
    transitionTimer = null;
    indicator.hidden = true;
    transitionAccount = account;
  }
  const pending = !!message;
  if (pending !== state.onboardingTransitionPending) {
    state.onboardingTransitionPending = pending;
    document.querySelectorAll(
      ".main-panel > :not(#onboarding-transition-status), .sidebar button:not(#logout-btn), #tos-controls",
    ).forEach((element) => { element.inert = pending; });
    if (state.recordBtn) state.recordBtn.inert = pending;
  }
  if (!pending) return false;
  document.getElementById("onboarding-transition-copy").textContent = message;
  if (transitionTimer === null) {
    transitionTimer = window.setTimeout(() => {
      if (state.onboardingTransitionPending && transitionAccount === state.currentUser?.id) {
        indicator.hidden = false;
      }
    }, 300);
  }
  return true;
}

function syncAgreementWindowSize(expanded) {
  if (agreementWindowExpanded === expanded) return;
  agreementWindowExpanded = expanded;
  invoke("set_agreement_window_expanded", { expanded }).catch((error) => {
    reportUiError("agreement_window_resize_failed", error);
  });
}

function currentView() {
  if (!state.isAuthenticated) {
    return state.chosenView === "legal" ? "legal" : "auth";
  }
  if (onboardingIntroPending()) return "intro";
  if (state.legalAcceptancePending) return "legal";
  if (state.authTransitionBusyCount > 0 && !state.logoutInFlight
      && !state.tosAcceptedThisRun) return "auth";
  if (!state.tosAcceptedThisRun) return "legal";
  if (state.recordingConsentPending && state.agreementSatisfied) {
    return "recording-consent";
  }
  if (state.chosenView === "legal") return "legal";
  if (state.chosenView === "debug" && state.debugPane === "logs") return "debug";
  // Right after the Terms, before the agreement: a new account's one chance to enter a code.
  if (referralCodePending()) return "referral-code";
  if (!state.agreementSatisfied) return "agreement";
  if (state.chosenView === "agreement-review") return "agreement-review";
  if (!identityAllowsAccess()) return "identity";
  if (!state.permissionsOk) return "permissions";
  if (guidedOnboardingPending()) return "sessions";
  if (state.chosenView === "auth") return "sessions";
  if (state.chosenView === "faq" && !state.selfServeUser) return "sessions";
  if (state.chosenView === "referrals" && !referralsAvailable()) return "sessions";
  if (state.buildChannel !== "staging"
      && (state.chosenView === "replay-check"
        || (state.chosenView === "debug" && state.debugPane === "game"))) {
    return "sessions";
  }
  if (state.chosenView) return state.chosenView;
  return "sessions";
}

/// The single owner of which sidebar item looks selected.
///
/// This used to be set inside each of updateLayout()'s early-return branches, which meant
/// every new view had to remember to clear all the others — and repeatedly did not. Adding
/// a view here cannot strand a stale highlight.
function syncSidebarHighlight() {
  const view = currentView();
  const onLegal = view === "legal";
  for (const [tab, active] of [
    [state.tabPermissions, view === "permissions"],
    [state.tabFaq, view === "faq"],
    [state.tabReferrals, view === "referrals"],
    [document.getElementById("tab-debug-game"), view === "debug" && state.debugPane === "game"],
    [document.getElementById("tab-debug-logs"), view === "debug" && state.debugPane === "logs"],
    [state.tabTerms, onLegal && state.currentLegalPage === "terms"],
    [state.tabPrivacy, onLegal && state.currentLegalPage === "privacy"],
    [state.tabContributorAgreement, view === "agreement" || view === "agreement-review"],
    [document.getElementById("tab-sessions"), view === "sessions"],
    [document.getElementById("tab-login"), view === "auth"],
    [document.getElementById("tab-replay-check"), view === "replay-check"],
  ]) {
    if (tab) tab.classList.toggle("active", active);
  }
}

function syncLegalGateControls() {
  const termsLocked = !state.isAuthenticated || !state.tosAcceptedThisRun;
  const postAgreementLocked = state.agreementSatisfied
    && state.recordingConsentPending;
  const locked = termsLocked || !state.agreementSatisfied || postAgreementLocked;
  const identityLocked = locked || !identityAllowsAccess();
  const sessionsLocked = identityLocked || !state.permissionsOk;
  for (const [id, disabled] of [
    ["tab-terms", postAgreementLocked],
    ["tab-privacy", postAgreementLocked],
    ["tab-contributor-agreement", termsLocked || postAgreementLocked],
    ["tab-permissions", identityLocked],
    ["tab-debug-logs", termsLocked || postAgreementLocked],
    ["tab-sessions", sessionsLocked],
    ["tab-faq", sessionsLocked],
    ["tab-referrals", sessionsLocked],
    ["tab-replay-check", sessionsLocked],
  ]) {
    const button = document.getElementById(id);
    if (button) button.disabled = disabled;
  }
}

function setTransportVisible(visible) {
  if (state.transportControls) {
    state.transportControls.style.display = visible ? "flex" : "none";
  }
  if (state.elapsedTimerEl) {
    state.elapsedTimerEl.style.display = visible ? "block" : "none";
  }
  const bottomBar = state.transportControls?.closest(".bottom-bar");
  const replayGateControls = document.getElementById("replay-gate-controls");
  const termsVisible = state.tosControls?.style.display !== "none";
  const replayGateVisible = replayGateControls?.style.display === "flex";
  if (bottomBar) {
    bottomBar.style.display = visible || termsVisible || replayGateVisible ? "flex" : "none";
  }
}

/// Make `name` the only view the sidebar has chosen; null means the default (the legal
/// pages before ToS acceptance, local sessions after).
///
/// Every entry point goes through here. Each of these views is rendered by its own early
/// return in updateLayout(), so a selection that forgets to close the others leaves one
/// item highlighted while a different panel is on screen — which is exactly how the last
/// several navigation bugs happened. One function means a new view cannot forget.
export function setChosenView(name) {
  if (name !== "debug" && state.chosenView === "debug") stopLogAuto();
  state.chosenView = name;
  window.dispatchEvent(new CustomEvent("loggy3-view-changed", { detail: { name } }));

  // The permission poll exists for the gate and normally stops once everything is granted.
  // Keep it running while the Permissions view is open so it shows live state, and stop it
  // again on the way out — but never while the gate itself still needs it.
  if (state.chosenView === "permissions") {
    refreshPermissions();
    startPermissionsPolling();
  } else if (state.permissionsOk) {
    stopPermissionsPolling();
  }
}

export function updateLayout() {
  if (holdPendingTransition()) return;
  renderLayout();
  window.dispatchEvent(new CustomEvent("loggy3-layout-changed", {
    detail: { view: currentView() },
  }));
}

function renderLayout() {
  const banned = state.isAuthenticated && state.accountBanned;
  if (state.tabFaq) state.tabFaq.hidden = !state.isAuthenticated || !state.selfServeUser;
  if (state.tabReferrals) state.tabReferrals.hidden = !referralsAvailable();
  renderRateTier();
  document.body.classList.toggle("account-banned", banned);
  if (state.banScreen) state.banScreen.hidden = !banned;
  if (banned) {
    syncAgreementWindowSize(false);
    if (state.tosControls) state.tosControls.style.display = "none";
    stopLogAuto();
    stopPermissionsPolling();
    return;
  }

  const view = currentView();
  document.body.classList.toggle("auth-screen", !state.isAuthenticated || view === "auth");
  // The first-recording guide tracks its view after the history check resolves.
  if (view !== "sessions" || !guidedOnboardingPending()) trackOnboardingView(view);
  const sessionsTimezone = document.getElementById("sessions-timezone");
  if (sessionsTimezone) sessionsTimezone.hidden = view !== "sessions";
  const sessionsRangeToggle = document.getElementById("sessions-range-toggle");
  if (sessionsRangeToggle) sessionsRangeToggle.hidden = view !== "sessions";
  syncAgreementWindowSize(
    view === "agreement" || view === "agreement-review" || view === "recording-consent",
  );

  const mainHeader = state.mainTitle?.closest(".main-header");
  const replayGateControls = document.getElementById("replay-gate-controls");
  const debugSection = document.getElementById("debug-tools-section");
  if (mainHeader) mainHeader.style.display = "flex";
  for (const section of [
    state.replayCheckSection, state.authSection, state.agreementSection,
    state.recordingConsentSection, state.identitySection, state.permissionsSection,
    state.legalContent, state.sessionsSection, state.faqSection, debugSection,
    state.referralCodeSection, state.referralsSection,
  ]) {
    if (section) section.style.display = "none";
  }
  if (replayGateControls) {
    const gateLocked = !legalGatesSatisfied() || !state.permissionsOk;
    replayGateControls.style.display = gateLocked && state.replayCheckNeedsControl
      ? "flex"
      : "none";
  }

  syncLegalGateControls();
  if (state.tosControls) {
    state.tosControls.style.display = state.legalAcceptancePending
      ? "flex"
      : "none";
  }
  const termsPage = state.currentLegalPage === "terms";
  if (state.termsAcceptControl) {
    state.termsAcceptControl.style.display = termsPage ? "inline-flex" : "none";
  }
  if (state.privacyAcceptControl) {
    state.privacyAcceptControl.style.display = termsPage ? "none" : "inline-flex";
  }
  if (state.acceptLegalBtn) {
    state.acceptLegalBtn.textContent = state.authTransitionBusyCount > 0
      ? "Please wait…"
      : termsPage ? "Accept Terms and Continue" : "Acknowledge Privacy and Continue";
    state.acceptLegalBtn.disabled = state.authTransitionBusyCount > 0
      || (termsPage
        ? !state.termsAcceptCheckbox?.checked
        : !state.privacyAcceptCheckbox?.checked);
  }
  const needsRecorderControl = recorderNeedsControl();
  const recordingAllowed = legalGatesSatisfied() && state.permissionsOk && identityAllowsAccess();

  if (view === "intro") {
    if (mainHeader) mainHeader.style.display = "none";
    if (state.tosControls) state.tosControls.style.display = "none";
    setTransportVisible(false);
    return;
  }

  // Legal acceptance follows sign-in and remains available as a read-only sidebar
  // page after authentication.
  if (view === "legal") {
    if (state.chosenView === "debug") stopLogAuto();
    if (state.legalContent) state.legalContent.style.display = "block";
    setTransportVisible(recordingAllowed || needsRecorderControl);
    if (state.mainTitle) {
      state.mainTitle.textContent = state.legalDocumentsUnavailable && !state.tosAcceptedThisRun
        ? state.legalDocumentsError
          ? `${state.legalDocumentsError.replace(/[.\s]+$/, "")}. Retrying automatically…`
          : LEGAL_DOCUMENTS_UNAVAILABLE_NOTICE
        : state.legalAcceptancePending
          ? state.legalDocumentsUpdated
            ? LEGAL_DOCUMENTS_UPDATED_NOTICE
            : "Please review and agree to continue."
          : state.currentLegalPage === "privacy" ? "Privacy Notice" : "Terms";
    }
    syncSidebarHighlight();
    return;
  }

  if (view === "agreement" || view === "agreement-review") {
    const readOnly = view === "agreement-review";
    if (mainHeader) mainHeader.style.display = "none";
    if (state.agreementSection) state.agreementSection.style.display = "flex";
    setTransportVisible((readOnly && recordingAllowed) || needsRecorderControl);
    if (state.mainTitle) state.mainTitle.textContent = "User Service Agreement";
    syncSidebarHighlight();
    return;
  }

  if (view === "recording-consent") {
    if (mainHeader) mainHeader.style.display = "none";
    if (state.recordingConsentSection) state.recordingConsentSection.style.display = "flex";
    setTransportVisible(needsRecorderControl);
    if (state.mainTitle) state.mainTitle.textContent = "Recording Consent";
    syncSidebarHighlight();
    return;
  }

  if (view === "permissions" && !state.permissionsOk) {
    if (state.permissionsSection) state.permissionsSection.style.display = "block";
    setTransportVisible(needsRecorderControl);
    if (state.mainTitle) state.mainTitle.textContent = "Grant permissions to continue.";
    // Permissions can be revoked while a DEBUG tool is open. Close the panel because
    // debug capture cannot continue while the permissions gate is active.
    if (state.chosenView === "debug" && state.debugPane !== "logs") {
      stopLogAuto();
    }
    state.chosenView = null;
    syncSidebarHighlight();
    return;
  }
  syncSidebarHighlight();
  if (view === "auth") {
    if (mainHeader) mainHeader.style.display = "none";
    if (state.authSection) state.authSection.style.display = "flex";
    setTransportVisible(needsRecorderControl);
    if (state.mainTitle) state.mainTitle.textContent = "Sign In";
    return;
  }

  if (view === "identity") {
    if (mainHeader) mainHeader.style.display = "none";
    if (state.identitySection) state.identitySection.style.display = "flex";
    setTransportVisible(needsRecorderControl);
    if (state.mainTitle) state.mainTitle.textContent = "Identity Verification";
    return;
  }

  if (view === "referral-code") {
    if (mainHeader) mainHeader.style.display = "none";
    if (state.referralCodeSection) state.referralCodeSection.style.display = "flex";
    setTransportVisible(needsRecorderControl);
    if (state.mainTitle) state.mainTitle.textContent = "Referral Code";
    return;
  }

  if (view === "permissions") {
    if (state.permissionsSection) state.permissionsSection.style.display = "block";
    // Recording is ToS-gated, so only offer the transport when it can actually be used.
    setTransportVisible(legalGatesSatisfied());
    if (state.mainTitle) state.mainTitle.textContent = "Permissions";
    return;
  }

  if (view === "faq") {
    if (debugSection) debugSection.style.display = "none";
    if (state.legalContent) state.legalContent.style.display = "none";
    if (state.sessionsSection) state.sessionsSection.style.display = "none";
    if (state.faqSection) state.faqSection.style.display = "flex";
    if (state.mainTitle) state.mainTitle.textContent = "FAQ";
    setTransportVisible(true);
    return;
  }

  if (view === "referrals") {
    if (state.referralsSection) state.referralsSection.style.display = "flex";
    if (state.mainTitle) state.mainTitle.textContent = "Referrals";
    setTransportVisible(true);
    return;
  }

  if (view === "replay-check") {
    if (state.replayCheckSection) state.replayCheckSection.style.display = "flex";
    // The check has its own Record/Stop button. Keep the global transport hidden unless
    // it owns an active recorder whose Stop control must remain available.
    setTransportVisible(needsRecorderControl);
    if (state.mainTitle) state.mainTitle.textContent = "Replay Check";
    return;
  }
  if (view === "debug") {
    if (debugSection) debugSection.style.display = "block";
    // Logs can bypass the permission gate. An active recorder also keeps its Stop
    // control available if permissions change while this panel is open.
    setTransportVisible(state.permissionsOk || needsRecorderControl);
    if (state.mainTitle) {
      state.mainTitle.textContent = state.debugPane === "logs" ? "Logs" : "Replay Test Game";
    }
    return;
  }
  // After onboarding, the default view is Sessions.
  if (state.sessionsSection) state.sessionsSection.style.display = "flex";
  if (state.mainTitle) state.mainTitle.textContent = "Sessions";
  setTransportVisible(true);
}
