// Sign-in/out orchestration. Each fresh login requires Terms and Privacy acceptance
// before the rest of onboarding can continue.

import { updateAccountSidebar } from "./account-sidebar.js";
import { reportUiError, showErrorBanner } from "./errors.js";
import { startStatusPolling, stopStatusPolling, updateUI } from "./recording.js";
import { refreshReplayCheckStatus } from "./replay-check.js";
import { signedOutIdentity } from "./identity.js";
import { resetAgreement } from "./agreement.js";
import {
  acceptLegalDocuments,
  fetchLegalDocuments,
  loadedLegalDocument,
} from "./legal-documents.js";
import {
  beginOnboardingTelemetry,
  resetOnboardingTelemetry,
  trackOnboardingEvent,
} from "./onboarding-telemetry.js";
import { state } from "./state.js";
import { invoke } from "./tauri.js";
import {
  initTurnstileController,
  resetTurnstile,
  setTurnstileVisible,
  startTurnstile,
  stopTurnstile,
} from "./turnstile.js";
import { setChosenView, updateLayout } from "./views.js";

const TERMS_AND_PRIVACY = ["terms", "privacy"];
// While the server can't be reached, the legal screen checks again after these delays.
const LEGAL_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
// Failures that mean the server couldn't be reached or failed for a moment (5xx).
const LEGAL_NETWORK_ERRORS = new Set(["request_failed", "legal_unavailable"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^\d{6}$/;
const TURNSTILE_REQUIRED = "Complete the security check before requesting a code.";
const TURNSTILE_RESEND_REQUIRED = "Complete the security check before requesting another code.";
const SECURITY_ERROR_MESSAGES = {
  security_check_failed: {
    title: "This check wasn’t accepted",
    message: "Complete the new security check, then send your code again.",
  },
  security_check_unavailable: {
    title: "Verification is temporarily unavailable",
    message: "Wait a moment, then try sending your code again.",
  },
  security_check_configuration_error: {
    title: "We couldn’t start sign-in",
    message: "There’s a problem on our side. Contact support@loggy3.com for help.",
  },
};

const authState = {
  step: "email",
  operation: null,
  email: "",
  code: "",
  requestedEmail: "",
  verificationToken: "",
  resendDeadline: 0,
  resendRemaining: 0,
  turnstileToken: "",
  turnstileVisible: true,
  message: "",
  error: "",
  errorTitle: "",
  errorSource: "",
  termsAcceptedThisLogin: false,
  completing: false,
};

const AUTH_OPERATIONS = {
  sending: { button: "send", label: "Sending…" },
  resending: { button: "resend", label: "Resending…" },
  verifying: { button: "verify", label: "Verifying…" },
};

let elements;
let resendInterval;
let authStatusRevision = 0;
let onAuthenticationCompleted = async () => {};
let legalRetryTimer = null;
let legalRetryAttempt = 0;

function clearLegalRetry() {
  if (legalRetryTimer !== null) window.clearTimeout(legalRetryTimer);
  legalRetryTimer = null;
}

// Leaves the "Can’t reach Loggy3" wait; the next one starts again from the shortest delay.
function stopWaitingForLegalDocuments() {
  clearLegalRetry();
  legalRetryAttempt = 0;
  state.legalDocumentsUnavailable = false;
}

const allAccepted = (documents) =>
  TERMS_AND_PRIVACY.every((name) => documents?.[name]?.accepted);
const acceptedEarlier = (documents) =>
  TERMS_AND_PRIVACY.some((name) => documents?.[name]?.previously_accepted);

function requiredElement(id) {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing required authentication element: ${id}`);
  return value;
}

function collectElements() {
  const section = requiredElement("auth-section");
  return {
    section,
    card: section.querySelector(".auth-card"),
    completing: requiredElement("auth-completing"),
    emailStep: requiredElement("auth-email-step"),
    emailForm: requiredElement("auth-email-form"),
    email: requiredElement("auth-email"),
    send: requiredElement("auth-send-code"),
    sendLabel: requiredElement("auth-send-code-label"),
    codeStep: requiredElement("auth-code-step"),
    codeForm: requiredElement("auth-code-form"),
    code: requiredElement("auth-code"),
    codeEmail: requiredElement("auth-code-email"),
    verify: requiredElement("auth-verify-code"),
    verifyLabel: requiredElement("auth-verify-code-label"),
    resend: requiredElement("auth-resend-code"),
    resendLabel: requiredElement("auth-resend-code-label"),
    changeEmail: requiredElement("auth-change-email"),
    message: requiredElement("auth-message"),
    error: requiredElement("auth-error"),
    errorNotice: requiredElement("auth-error-notice"),
    errorTitle: requiredElement("auth-error-title"),
  };
}

function authRetryAfter(error) {
  if (!error || typeof error !== "object") return 0;
  const seconds = Number(error.retry_after);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
}

function authErrorMessage(error) {
  const message = Object.prototype.hasOwnProperty.call(SECURITY_ERROR_MESSAGES, error?.code)
    ? SECURITY_ERROR_MESSAGES[error.code].message
    : typeof error === "string" ? error
      : typeof error?.message === "string" ? error.message
        : typeof error?.error === "string" ? error.error : "Authentication failed.";
  const retryAfter = authRetryAfter(error);
  if (!retryAfter || /try again in/i.test(message)) return message;
  return `${message.replace(/[.\s]+$/, "")}. Try again in ${retryAfter} seconds.`;
}

function showAuthError(error, source = "request") {
  authState.error = authErrorMessage(error);
  authState.errorTitle = Object.prototype.hasOwnProperty.call(SECURITY_ERROR_MESSAGES, error?.code)
    ? SECURITY_ERROR_MESSAGES[error.code].title : "";
  authState.errorSource = source;
  renderAuth();
}

function showUnavailableReason(reason) {
  showAuthError(reason, reason === TURNSTILE_REQUIRED || reason === TURNSTILE_RESEND_REQUIRED ? "turnstile" : "form");
}

function clearAuthError() {
  authState.error = "";
  authState.errorTitle = "";
  authState.errorSource = "";
}

function clearAuthFeedback() {
  authState.message = "";
  clearAuthError();
}

function normalizedEmail() {
  return String(authState.email || "").trim().toLowerCase();
}

function sendUnavailableReason() {
  const email = normalizedEmail();
  if (authState.resendRemaining > 0) {
    return `Try again in ${authState.resendRemaining} seconds.`;
  }
  if (!email) return "Enter your email address first.";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
  if (!authState.turnstileToken) return TURNSTILE_REQUIRED;
  return "";
}

function resendUnavailableReason() {
  if (authState.resendRemaining > 0) {
    return `You can resend the code in ${authState.resendRemaining} seconds.`;
  }
  if (!authState.verificationToken) return "Request a new sign-in code.";
  if (!authState.turnstileToken) {
    return TURNSTILE_RESEND_REQUIRED;
  }
  return "";
}

function verifyUnavailableReason() {
  if (!authState.verificationToken) return "Request a new sign-in code.";
  if (CODE_PATTERN.test(authState.code)) return "";
  return authState.code
    ? "Enter all six digits from your email."
    : "Enter the six-digit code from your email.";
}

function resendButtonLabel() {
  return authState.resendRemaining > 0
    ? `Resend code (${authState.resendRemaining}s)`
    : "Resend code";
}

function sendButtonLabel() {
  return authState.resendRemaining > 0
    ? `Send code (${authState.resendRemaining}s)`
    : "Send code";
}

function renderButton(button, label, name, idleLabel, unavailableReason = "") {
  const operation = authState.operation ? AUTH_OPERATIONS[authState.operation] : null;
  const loading = operation?.button === name;
  const busy = operation !== null;
  button.disabled = busy;
  button.setAttribute("aria-disabled", String(busy || !!unavailableReason));
  button.setAttribute("aria-busy", String(loading));
  button.classList.toggle("is-loading", loading);
  label.textContent = loading ? operation.label : idleLabel;
  if (unavailableReason) {
    button.dataset.disabledReason = unavailableReason;
    button.title = unavailableReason;
  } else {
    delete button.dataset.disabledReason;
    button.removeAttribute("title");
  }
}

function renderAuth() {
  if (!elements) return;
  const busy = authState.operation !== null;
  const showingEmail = authState.step === "email";
  const completing = authState.completing || (state.isAuthenticated
    && state.onboardingTransitionPending && !state.tosAcceptedThisRun);

  if (elements.card) elements.card.setAttribute("aria-busy", String(busy));
  elements.completing.hidden = !completing;
  elements.emailStep.hidden = completing || !showingEmail;
  elements.send.hidden = completing || !showingEmail;
  elements.codeStep.hidden = completing || showingEmail;
  elements.email.disabled = busy;
  elements.code.disabled = busy;
  elements.changeEmail.disabled = busy;
  if (elements.email.value !== authState.email) elements.email.value = authState.email;
  if (elements.code.value !== authState.code) elements.code.value = authState.code;
  elements.codeEmail.textContent = authState.requestedEmail;
  elements.message.textContent = authState.message;
  elements.error.textContent = authState.error;
  elements.error.hidden = !authState.error;
  elements.errorNotice.hidden = !authState.error;
  elements.errorNotice.classList.toggle("auth-security-error", !!authState.errorTitle);
  elements.errorTitle.textContent = authState.errorTitle;
  elements.errorTitle.hidden = !authState.errorTitle;
  setTurnstileVisible(!completing && authState.turnstileVisible);

  renderButton(elements.send, elements.sendLabel, "send", sendButtonLabel(), sendUnavailableReason());
  renderButton(
    elements.resend,
    elements.resendLabel,
    "resend",
    resendButtonLabel(),
    resendUnavailableReason(),
  );
  renderButton(
    elements.verify,
    elements.verifyLabel,
    "verify",
    "Continue",
    verifyUnavailableReason(),
  );
  window.dispatchEvent(new Event("loggy3-auth-screen-changed"));
}

function explainUnavailableButton(event) {
  const button = event.currentTarget;
  const reason = button?.dataset.disabledReason;
  if (button?.getAttribute("aria-disabled") !== "true" || !reason) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (button === elements.resend && authState.resendRemaining === 0 && !authState.turnstileToken) {
    authState.turnstileVisible = true;
    resetTurnstile();
  }
  showUnavailableReason(reason);
}

function showEmailStep(shouldFocus = true) {
  authState.step = "email";
  authState.turnstileVisible = true;
  clearAuthFeedback();
  renderAuth();
  if (shouldFocus) window.setTimeout(() => elements.email.focus(), 0);
}

function showCodeStep() {
  authState.step = "code";
  authState.code = "";
  authState.turnstileVisible = false;
  renderAuth();
  window.setTimeout(() => elements.code.focus(), 0);
}

function updateResendCountdown() {
  authState.resendRemaining = Math.max(
    0,
    Math.ceil((authState.resendDeadline - Date.now()) / 1000),
  );
  if (authState.resendRemaining === 0) {
    clearInterval(resendInterval);
    resendInterval = null;
    authState.resendDeadline = 0;
  }
  renderAuth();
}

function startResendCountdown(seconds) {
  if (resendInterval) clearInterval(resendInterval);
  const duration = Math.max(0, Math.ceil(Number(seconds) || 0));
  authState.resendDeadline = Math.max(
    authState.resendDeadline,
    Date.now() + duration * 1000,
  );
  updateResendCountdown();
  if (authState.resendRemaining > 0) {
    resendInterval = setInterval(updateResendCountdown, 1000);
  }
}

function clearResendCountdown() {
  if (resendInterval) clearInterval(resendInterval);
  resendInterval = null;
  authState.resendRemaining = 0;
  authState.resendDeadline = 0;
}

function clearEmailChallenge({ clearEmail = false } = {}) {
  authState.step = "email";
  authState.code = "";
  authState.requestedEmail = "";
  authState.verificationToken = "";
  authState.turnstileToken = "";
  authState.turnstileVisible = true;
  clearResendCountdown();
  clearAuthFeedback();
  if (clearEmail) authState.email = "";
}

export function getAuthStatusRevision() {
  return authStatusRevision;
}

export function applyAuthStatus(authStatus, { expectedRevision } = {}) {
  if (expectedRevision !== undefined && expectedRevision !== authStatusRevision) {
    return false;
  }

  const authenticated = !!authStatus?.authenticated && !!authStatus.user;
  const sameAccount = state.currentUser?.id === authStatus?.user?.id;
  state.selfServeUser = authenticated && (authStatus.user.programType
    ? authStatus.user.programType === "self_serve" : sameAccount && state.selfServeUser);
  state.isAuthenticated = authenticated;
  state.currentUser = authenticated ? authStatus.user : null;
  state.currentTokenId = authenticated ? authStatus.token_id : null;
  state.accountBanned = authenticated && !!authStatus.user.banned;
  authStatusRevision += 1;

  window.dispatchEvent(new Event("loggy3-account-access-changed"));
  updateAuthUI();
  updateUI();
  return true;
}

export function beginSignIn() {
  resetOnboardingTelemetry();
  resetAgreement();
  clearEmailChallenge({ clearEmail: true });
  authState.termsAcceptedThisLogin = false;
  state.legalAcceptancePending = false;
  state.tosAcceptedThisRun = false;
  stopWaitingForLegalDocuments();
  beginOnboardingTelemetry();
  setChosenView("auth");
  updateAuthUI();
}

// `updated` says the account accepted an earlier version, so the screens say the
// documents changed instead of asking for a first acceptance.
export function requireLegalAcceptance({ updated = false } = {}) {
  authState.termsAcceptedThisLogin = false;
  state.legalAcceptancePending = true;
  state.legalDocumentsUpdated = updated;
  state.tosAcceptedThisRun = false;
  stopWaitingForLegalDocuments();
  if (state.termsAcceptCheckbox) {
    state.termsAcceptCheckbox.checked = false;
    state.termsAcceptCheckbox.disabled = false;
  }
  if (state.privacyAcceptCheckbox) state.privacyAcceptCheckbox.checked = false;
  stopTurnstile();
  beginOnboardingTelemetry();
  setChosenView("legal");
  updateAuthUI();
}

export function acceptLoginTerms() {
  if (!state.isAuthenticated || !state.legalAcceptancePending) return false;
  authState.termsAcceptedThisLogin = true;
  if (state.termsAcceptCheckbox) state.termsAcceptCheckbox.disabled = true;
  if (state.privacyAcceptCheckbox) state.privacyAcceptCheckbox.checked = false;
  void trackOnboardingEvent("onboarding.terms.completed");
  return true;
}

export async function acknowledgeLoginPrivacy() {
  if (!state.isAuthenticated || !state.legalAcceptancePending
      || !authState.termsAcceptedThisLogin || state.authTransitionBusyCount > 0) return false;
  const tokenId = state.currentTokenId;
  let documentsChanged = false;
  state.authTransitionBusyCount += 1;
  updateAuthUI();
  try {
    await acceptLegalDocuments(Object.fromEntries(TERMS_AND_PRIVACY.map((name) =>
      [name, loadedLegalDocument(name)?.version])));
    if (!state.isAuthenticated || state.currentTokenId !== tokenId) return true;
    await invoke("accept_terms_and_privacy", { tokenId });
    if (!state.isAuthenticated || state.currentTokenId !== tokenId) return true;
    await trackOnboardingEvent("onboarding.privacy.completed");
    if (!state.isAuthenticated || state.currentTokenId !== tokenId) return true;
    state.legalAcceptancePending = false;
    state.tosAcceptedThisRun = true;
    state.legalAcceptances += 1;
    updateAccountSidebar();
    setChosenView(null);
    await onAuthenticationCompleted();
  } catch (error) {
    reportUiError("legal_acceptance_failed", error);
    showErrorBanner(`Could not save acceptance: ${authErrorMessage(error)}`);
    documentsChanged = error?.code === "legal_documents_changed";
  } finally {
    state.authTransitionBusyCount -= 1;
    updateUI();
    updateAccountSidebar();
  }
  // The server has a newer version than the one shown: load it and ask again.
  if (documentsChanged && state.isAuthenticated && state.currentTokenId === tokenId) {
    await onAuthenticationCompleted();
  }
  return true;
}

// Until the documents load nothing is skipped: the legal screen says why and the sign-in steps
// run again on their own. Network trouble reads "Can’t reach Loggy3"; any other answer (an update
// required, a sign-in problem, a response the app can't use) shows the server's own message.
function waitForLegalDocuments(error) {
  authState.termsAcceptedThisLogin = false;
  state.legalAcceptancePending = false;
  state.legalDocumentsUnavailable = true;
  state.legalDocumentsError = !error?.code || LEGAL_NETWORK_ERRORS.has(error.code)
    ? "" : authErrorMessage(error);
  state.tosAcceptedThisRun = false;
  setChosenView("legal");
  updateAuthUI();
  if (legalRetryTimer !== null) return;
  const tokenId = state.currentTokenId;
  const delay = LEGAL_RETRY_DELAYS_MS[Math.min(legalRetryAttempt, LEGAL_RETRY_DELAYS_MS.length - 1)];
  legalRetryAttempt += 1;
  legalRetryTimer = window.setTimeout(() => {
    legalRetryTimer = null;
    if (!state.isAuthenticated || state.accountBanned || state.currentTokenId !== tokenId
        || !state.legalDocumentsUnavailable) return;
    void onAuthenticationCompleted();
  }, delay);
}

// Decides at sign-in and app start whether the Terms and Privacy screens are needed, from the
// server's record of the versions it serves now. Returns true when both are accepted.
export async function resolveLegalAcceptance() {
  if (!state.isAuthenticated) return false;
  // A banned account can't load the documents; they are checked again if it is unbanned.
  if (state.accountBanned) {
    requireLegalAcceptance();
    return false;
  }
  const tokenId = state.currentTokenId;
  clearLegalRetry();
  let documents;
  try {
    documents = await fetchLegalDocuments();
  } catch (error) {
    if (!state.isAuthenticated || state.currentTokenId !== tokenId) return false;
    reportUiError("legal_documents_failed", error);
    waitForLegalDocuments(error);
    return false;
  }
  if (!state.isAuthenticated || state.currentTokenId !== tokenId) return false;
  if (!allAccepted(documents)) {
    requireLegalAcceptance({ updated: acceptedEarlier(documents) });
    return false;
  }
  // A login that accepted on this computer before already has the native gate open.
  try {
    const nativeGateOpen = await invoke("tos_state").catch(() => false);
    if (!nativeGateOpen) await invoke("accept_terms_and_privacy", { tokenId });
  } catch (error) {
    if (!state.isAuthenticated || state.currentTokenId !== tokenId) return false;
    reportUiError("legal_acceptance_failed", error);
    requireLegalAcceptance();
    return false;
  }
  if (!state.isAuthenticated || state.currentTokenId !== tokenId) return false;
  stopWaitingForLegalDocuments();
  authState.termsAcceptedThisLogin = true;
  state.legalAcceptancePending = false;
  state.tosAcceptedThisRun = true;
  state.legalAcceptances += 1;
  // Leave the legal screen that waiting or a ban put up, so the next step (the agreement, say) shows.
  if (state.chosenView === "legal") setChosenView(null);
  updateAccountSidebar();
  return true;
}

// For a check while the app is open, once sign-in has reached the Terms and Privacy screens or
// passed them: puts the screens back up when a version deployed since has not been accepted, and
// starts them over when the text already on them changed. Returns the server's documents and
// whether the screens were put up or started over (`restarted`), or null when there was nothing
// to check, the check failed or an acceptance happened while it ran, which changes nothing.
export async function recheckLegalAcceptance() {
  if (!state.isAuthenticated || state.accountBanned || state.authTransitionBusyCount > 0
      || (!state.tosAcceptedThisRun && !state.legalAcceptancePending)) return null;
  const tokenId = state.currentTokenId;
  const acceptances = state.legalAcceptances;
  const shown = TERMS_AND_PRIVACY.map((name) => loadedLegalDocument(name)?.version);
  let documents;
  try {
    documents = await fetchLegalDocuments();
  } catch (error) {
    reportUiError("legal_recheck_failed", error);
    return null;
  }
  if (!state.isAuthenticated || state.currentTokenId !== tokenId) return null;
  const changed = TERMS_AND_PRIVACY.some((name, index) => documents[name]?.version !== shown[index]);
  // Read before an acceptance that finished (or is still saving) meanwhile, the answer's records
  // predate it, so with the text unchanged it's set aside. Changed text still starts the screens
  // over: fetching it made it the text they show and accept.
  if (!changed && (state.legalAcceptances !== acceptances || state.authTransitionBusyCount > 0)) return null;
  const restarted = !allAccepted(documents) && (state.tosAcceptedThisRun || changed);
  if (restarted) requireLegalAcceptance({ updated: acceptedEarlier(documents) });
  return { documents, restarted };
}

// The native gate found the current Terms or Privacy Notice unaccepted while this login has them
// as accepted: a version deployed since the last check. Their screens come back at once, so nothing
// past them shows meanwhile, then start over with the current text once it loads (true). If it
// can't load, accepting the text already shown asks the server, whose answer that the documents
// changed loads the current ones.
export async function requireUpdatedLegalAcceptance() {
  requireLegalAcceptance({ updated: true });
  return (await recheckLegalAcceptance())?.restarted ?? false;
}

async function finishAuthentication(authStatus) {
  authState.completing = !!authStatus?.authenticated && !!authStatus.user;
  if (authStatus?.authenticated && authStatus.user) {
    clearEmailChallenge({ clearEmail: true });
    stopTurnstile();
    state.permissionsOk = false;
    state.permissionStatus = null;
  }
  authState.termsAcceptedThisLogin = false;
  state.legalAcceptancePending = false;
  state.tosAcceptedThisRun = false;
  stopWaitingForLegalDocuments();
  resetAgreement();
  if (state.termsAcceptCheckbox) {
    state.termsAcceptCheckbox.checked = false;
    state.termsAcceptCheckbox.disabled = false;
  }
  if (state.privacyAcceptCheckbox) state.privacyAcceptCheckbox.checked = false;
  renderAuth();
  setChosenView(null);
  applyAuthStatus(authStatus);
  updateAuthUI();
  try {
    if (authStatus?.authenticated && authStatus.user) {
      await trackOnboardingEvent("onboarding.sign_in.completed");
      await onAuthenticationCompleted();
    }
  } finally {
    authState.completing = false;
  }
}

async function requestCode(resend = false) {
  if (authState.operation) return;
  const reason = resend ? resendUnavailableReason() : sendUnavailableReason();
  if (reason) {
    showUnavailableReason(reason);
    return;
  }

  const email = resend ? authState.requestedEmail : normalizedEmail();
  const turnstileToken = authState.turnstileToken;
  authState.turnstileToken = "";
  clearAuthFeedback();
  authState.operation = resend ? "resending" : "sending";
  renderAuth();
  try {
    const result = await invoke("request_email_code", {
      email,
      turnstileToken,
      verificationToken: resend ? authState.verificationToken : null,
    });
    if (
      typeof result?.verification_token !== "string"
      || result.verification_token.length === 0
      || result.verification_token.length > 2048
    ) {
      throw new Error("The sign-in response was invalid. Request a new code.");
    }
    authState.requestedEmail = email;
    authState.verificationToken = result.verification_token;
    showCodeStep();
    const minutes = Math.max(1, Math.round((result.expires_in || 600) / 60));
    authState.message = `${resend ? "A new code was sent" : "Code sent"}. It expires in ${minutes} minutes.`;
    startResendCountdown(result.resend_after || 60);
  } catch (error) {
    reportUiError("auth_email_code_request_failed", error);
    const retryAfter = authRetryAfter(error);
    if (retryAfter) startResendCountdown(retryAfter);
    authState.turnstileVisible = true;
    showAuthError(error);
  } finally {
    authState.operation = null;
    renderAuth();
    resetTurnstile();
  }
}

async function verifyCode() {
  if (authState.operation || state.authTransitionBusyCount > 0) return;
  const reason = verifyUnavailableReason();
  if (reason) {
    showUnavailableReason(reason);
    return;
  }

  clearAuthFeedback();
  authState.operation = "verifying";
  state.authTransitionBusyCount += 1;
  renderAuth();
  updateUI();
  updateAccountSidebar();
  try {
    await finishAuthentication(await invoke("verify_email_code", {
      email: authState.requestedEmail,
      code: authState.code,
      verificationToken: authState.verificationToken,
    }));
  } catch (error) {
    reportUiError("auth_email_code_verify_failed", error);
    showAuthError(error);
  } finally {
    state.authTransitionBusyCount -= 1;
    authState.operation = null;
    renderAuth();
    updateUI();
    updateAccountSidebar();
  }
}

export function openAuthView() {
  if (state.isAuthenticated) return;
  if (state.chosenView !== "auth") {
    setChosenView("auth");
    updateLayout();
  }
  window.setTimeout(() => {
    (authState.step === "code" ? elements.code : elements.email).focus();
  }, 0);
}

export function initAuth(authenticationCompleted) {
  if (typeof authenticationCompleted === "function") {
    onAuthenticationCompleted = authenticationCompleted;
  }
  elements = collectElements();
  initTurnstileController((token) => {
    authState.turnstileToken = token;
    if (token && authState.errorSource === "turnstile") clearAuthError();
    renderAuth();
  });

  for (const button of [elements.send, elements.verify, elements.resend]) {
    button.addEventListener("click", explainUnavailableButton);
  }
  elements.emailForm.addEventListener("submit", (event) => {
    event.preventDefault();
    requestCode();
  });
  elements.email.addEventListener("input", () => {
    authState.email = elements.email.value;
    clearAuthError();
    renderAuth();
  });
  elements.codeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    verifyCode();
  });
  elements.code.addEventListener("input", () => {
    authState.code = elements.code.value.replace(/\D/g, "").slice(0, 6);
    clearAuthError();
    renderAuth();
  });
  elements.resend.addEventListener("click", () => requestCode(true));
  elements.changeEmail.addEventListener("click", () => {
    clearEmailChallenge();
    showEmailStep();
    resetTurnstile();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && authState.resendDeadline > 0) {
      updateResendCountdown();
    }
  });
  window.addEventListener("loggy3-view-changed", (event) => {
    if (event.detail?.name === "auth" && !state.isAuthenticated) startTurnstile();
    else stopTurnstile();
  });

  renderAuth();
}

export async function logout() {
  if (state.recordingCommandInFlight
      || state.recordingControlBusyCount > 0
      || state.authTransitionBusyCount > 0
      || state.logoutInFlight
      || state.replayCheckBusy
      || state.updateInstalling) return;
  const logoutLabel = state.logoutBtn?.querySelector(".sidebar-label");
  const wasAuthenticated = state.isAuthenticated;
  const previousUser = state.currentUser;
  let backendLogoutSucceeded = false;
  state.logoutInFlight = true;
  state.authTransitionBusyCount += 1;
  try {
    if (state.logoutBtn) state.logoutBtn.dataset.authBusy = "true";
    if (logoutLabel) logoutLabel.textContent = "Signing Out…";
    updateUI();
    updateAccountSidebar();
    await invoke("logout");
    backendLogoutSucceeded = true;
    state.recorderStatusGeneration += 1;
    state.wantsToRecord = false;
    state.isIdle = false;
    state.recorderPhase = "stopped";
    state.resumePending = false;
    state.replayCheckBusy = false;
    state.tosAcceptedThisRun = false;
    stopWaitingForLegalDocuments();
    resetAgreement();
    if (state.termsAcceptCheckbox) state.termsAcceptCheckbox.checked = false;
    if (state.privacyAcceptCheckbox) state.privacyAcceptCheckbox.checked = false;
    stopStatusPolling();
    await refreshReplayCheckStatus();
    if (state.elapsedTimerEl) state.elapsedTimerEl.textContent = "--:--:--";
    state.isAuthenticated = false;
    state.currentUser = null;
    applyAuthStatus(null);
    signedOutIdentity();
    beginSignIn();
    updateAuthUI();
  } catch (error) {
    if (!backendLogoutSucceeded) {
      state.isAuthenticated = wasAuthenticated;
      state.currentUser = previousUser;
    }
    startStatusPolling();
    refreshReplayCheckStatus();
    reportUiError("auth_logout_failed", error);
    showErrorBanner(`Failed to sign out: ${authErrorMessage(error)}`);
  } finally {
    state.authTransitionBusyCount -= 1;
    state.logoutInFlight = false;
    if (state.logoutBtn) state.logoutBtn.dataset.authBusy = "false";
    if (logoutLabel) logoutLabel.textContent = "Sign Out";
    updateUI();
    updateAccountSidebar();
  }
}

export function updateAuthUI() {
  updateAccountSidebar();
  updateLayout();
}
