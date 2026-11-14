import { reportUiError } from "./errors.js";
import { state } from "./state.js";
import { invoke } from "./tauri.js";
import { LEGAL_DOCUMENTS_UPDATED_NOTICE, updateLayout } from "./views.js";
import {
  beginOnboardingTelemetry,
  trackOnboardingEvent,
} from "./onboarding-telemetry.js";
import {
  resetRecordingConsent,
  restoreRecordingConsent,
} from "./recording-consent.js";

const AGREEMENT_RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

let elements;
let onAgreementSatisfied = async () => {};
let onTermsOrPrivacyUnaccepted = async () => {};
let agreementRequired = false;
let agreementLoading = false;
let agreementLoadFailed = false;
let agreementCurrentVersion = null;
let agreementPreviouslyAccepted = false;
let agreementPdfUrl = null;
let reviewingAgreement = false;
let agreementRetryTimer = null;
let agreementRetryAttempt = 0;
let agreementRetryGeneration = 0;
let agreementRequestGeneration = 0;
// Asked for while a check was already running; runs once that one ends.
let agreementCheckRequested = false;

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required agreement element: ${id}`);
  return element;
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  if (typeof error?.error === "string") return error.error;
  return "The agreement could not be loaded. Check your connection and try again.";
}

function clearAgreementRetryTimer() {
  if (agreementRetryTimer !== null) window.clearTimeout(agreementRetryTimer);
  agreementRetryTimer = null;
}

function stopAgreementRetry() {
  clearAgreementRetryTimer();
  agreementRetryAttempt = 0;
  agreementRetryGeneration += 1;
}

// Couldn't reach the server, or a server error (5xx) loading the agreement or the legal documents
// the check also reads: the native gate is left as it was (agreement.rs leaves_gate_as_it_was,
// the same codes), so the check runs again on its own.
const RETRYABLE_AGREEMENT_ERRORS = new Set(["request_failed", "agreement_unavailable", "legal_unavailable"]);

function retryableAgreementError(error) {
  return RETRYABLE_AGREEMENT_ERRORS.has(error?.code);
}

function validSignerName(name) {
  const length = Array.from(name).length;
  return length >= 1 && length <= 200
    && /\p{L}/u.test(name)
    && !/[\p{Cc}\p{Cf}]/u.test(name);
}

function agreementRequestIsCurrent(generation, userId) {
  return generation === agreementRequestGeneration
    && state.isAuthenticated
    && !state.accountBanned
    && state.currentUser?.id === userId;
}

function scheduleAgreementRetry() {
  if (agreementRetryTimer !== null || !state.isAuthenticated || state.accountBanned) return;
  const generation = agreementRetryGeneration;
  const userId = state.currentUser?.id;
  const delay = AGREEMENT_RETRY_DELAYS_MS[
    Math.min(agreementRetryAttempt, AGREEMENT_RETRY_DELAYS_MS.length - 1)
  ];
  agreementRetryAttempt += 1;
  agreementRetryTimer = window.setTimeout(() => {
    agreementRetryTimer = null;
    if (generation !== agreementRetryGeneration
        || userId !== state.currentUser?.id
        || !state.isAuthenticated
        || state.accountBanned) return;
    void authenticatedAgreement();
  }, delay);
}

function clearAgreementPdf() {
  if (agreementPdfUrl) URL.revokeObjectURL(agreementPdfUrl);
  agreementPdfUrl = null;
  if (elements) elements.document.removeAttribute("src");
}

function agreementPdfSource() {
  return `${agreementPdfUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
}

function showAgreementPdf(encoded) {
  clearAgreementPdf();
  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  agreementPdfUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  if (!state.agreementSatisfied) elements.document.src = agreementPdfSource();
}

function renderAgreement() {
  if (!elements) return;
  const needsSignature = agreementRequired && !state.agreementSatisfied
    && !!agreementCurrentVersion && !agreementLoading;
  const canReview = reviewingAgreement && agreementRequired && state.agreementSatisfied
    && !!agreementCurrentVersion && !!agreementPdfUrl && !agreementLoading;
  elements.card.setAttribute("aria-busy", String(agreementLoading));
  elements.intro.textContent = canReview
    ? "Review your accepted PDF agreement."
    : needsSignature && agreementPreviouslyAccepted
      ? LEGAL_DOCUMENTS_UPDATED_NOTICE
      : "Review the complete PDF agreement before recording or uploading.";
  elements.status.textContent = agreementLoading
    ? "Loading the current agreement…"
    : agreementRetryTimer !== null ? "Retrying automatically…" : "";
  elements.document.hidden = !needsSignature && !canReview;
  elements.form.hidden = !needsSignature;
  elements.support.hidden = !canReview;
  elements.retry.hidden = !agreementLoadFailed;
  elements.name.disabled = agreementLoading;
  elements.tab.hidden = !state.isAuthenticated || !agreementRequired;
  elements.tab.disabled = agreementLoading;
  elements.accept.disabled = agreementLoading || !validSignerName(elements.name.value.trim());
  updateLayout();
}

export function openAgreementReview() {
  if (!agreementRequired || !state.agreementSatisfied
      || !agreementCurrentVersion || !agreementPdfUrl) return false;
  reviewingAgreement = true;
  renderAgreement();
  elements.document.removeAttribute("src");
  window.requestAnimationFrame(() => {
    if (state.chosenView !== "agreement-review" || elements.document.hidden
        || !agreementPdfUrl) return;
    elements.document.src = agreementPdfSource();
  });
  return true;
}

export function resetAgreement() {
  agreementRequestGeneration += 1;
  agreementCheckRequested = false;
  stopAgreementRetry();
  state.agreementSatisfied = false;
  agreementRequired = false;
  agreementLoading = false;
  agreementLoadFailed = false;
  state.agreementChecking = false;
  agreementCurrentVersion = null;
  agreementPreviouslyAccepted = false;
  reviewingAgreement = false;
  resetRecordingConsent();
  if (elements) {
    clearAgreementPdf();
    elements.name.value = "";
    elements.error.textContent = "";
    elements.error.hidden = true;
    renderAgreement();
  }
  window.dispatchEvent(new Event("loggy3-agreement-changed"));
}

export async function authenticatedAgreement() {
  if (!state.isAuthenticated || state.accountBanned) return false;
  if (agreementLoading) {
    // The check already running may have read the server before a change this caller knows
    // about (a consent just saved, for one), so another runs as soon as it ends.
    agreementCheckRequested = true;
    return false;
  }
  clearAgreementRetryTimer();
  const requestGeneration = ++agreementRequestGeneration;
  const userId = state.currentUser?.id;
  const previouslySatisfied = state.agreementSatisfied;
  const legalAcceptances = state.legalAcceptances;
  agreementLoading = true;
  state.agreementChecking = !previouslySatisfied;
  agreementLoadFailed = false;
  if (!previouslySatisfied) agreementCurrentVersion = null;
  elements.error.textContent = "";
  elements.error.hidden = true;
  renderAgreement();
  try {
    // The native gate for recording and uploads opens only when the agreement (if any)
    // and the current Recording Consent are both accepted on the server.
    const agreement = await invoke("get_current_agreement");
    if (!agreementRequestIsCurrent(requestGeneration, userId)) return false;
    agreementRequired = !!agreement.required;
    if (!state.currentUser?.programType) state.selfServeUser = agreementRequired;
    agreementCurrentVersion = agreement.current_version || null;
    agreementPreviouslyAccepted = !!agreement.required && !!agreement.previously_accepted;
    agreementLoadFailed = false;
    state.agreementSatisfied = !agreement.required || !!agreement.accepted;
    if (agreement.required) {
      showAgreementPdf(agreement.document_pdf_base64);
    } else {
      clearAgreementPdf();
    }
    // Consent is asked once the agreement, if any, is signed.
    if (state.agreementSatisfied) restoreRecordingConsent(agreement.recording_consent);
    if (!state.agreementSatisfied || state.recordingConsentPending) {
      beginOnboardingTelemetry();
    }
    if (agreement.required && !state.agreementSatisfied) {
      void trackOnboardingEvent("onboarding.agreement.viewed");
    } else if (!agreement.required) {
      void trackOnboardingEvent("onboarding.agreement.not_required");
    }
    stopAgreementRetry();
    agreementLoading = false;
    // The native gate also needs the current Terms and Privacy Notice. Found unaccepted although
    // this login accepted them (a version deployed since), their screens come back before the
    // window updates; their current text may still be loading. An answer read before this login
    // accepted them can't tell the two apart, so another check runs instead.
    const unaccepted = agreement.terms_and_privacy_accepted === false && state.tosAcceptedThisRun;
    const readBeforeAcceptance = state.legalAcceptances !== legalAcceptances;
    if (unaccepted && readBeforeAcceptance) agreementCheckRequested = true;
    const legalScreens = unaccepted && !readBeforeAcceptance ? onTermsOrPrivacyUnaccepted() : null;
    window.dispatchEvent(new Event("loggy3-agreement-changed"));
    if (legalScreens) {
      await legalScreens;
      if (!agreementRequestIsCurrent(requestGeneration, userId)) return false;
    }
    if (state.agreementSatisfied) await onAgreementSatisfied();
    if (!agreementRequestIsCurrent(requestGeneration, userId)) return false;
    return state.agreementSatisfied;
  } catch (error) {
    if (!agreementRequestIsCurrent(requestGeneration, userId)) return false;
    const retryable = retryableAgreementError(error);
    state.agreementSatisfied = previouslySatisfied && retryable;
    agreementLoading = false;
    agreementLoadFailed = !state.agreementSatisfied;
    if (!state.agreementSatisfied) {
      agreementRequired = true;
      agreementCurrentVersion = null;
      clearAgreementPdf();
      elements.error.textContent = errorMessage(error);
      elements.error.hidden = false;
    }
    if (retryable) scheduleAgreementRetry();
    else stopAgreementRetry();
    window.dispatchEvent(new Event("loggy3-agreement-changed"));
    reportUiError("agreement_load_failed", error);
    return false;
  } finally {
    if (requestGeneration === agreementRequestGeneration) {
      agreementLoading = false;
      state.agreementChecking = false;
      renderAgreement();
    }
    if (agreementCheckRequested && !agreementLoading) {
      agreementCheckRequested = false;
      void authenticatedAgreement();
    }
  }
}

async function acceptAgreement(event) {
  event.preventDefault();
  if (agreementLoading || !agreementCurrentVersion) return;
  const signerName = elements.name.value.trim();
  if (!validSignerName(signerName)) return;

  const requestGeneration = ++agreementRequestGeneration;
  const userId = state.currentUser?.id;
  agreementLoading = true;
  elements.error.textContent = "";
  elements.error.hidden = true;
  renderAgreement();
  try {
    await invoke("accept_agreement", {
      version: agreementCurrentVersion,
      signerName,
    });
    if (!agreementRequestIsCurrent(requestGeneration, userId)) return;
    await trackOnboardingEvent("onboarding.agreement.completed");
    if (!agreementRequestIsCurrent(requestGeneration, userId)) return;
    elements.name.value = "";
    agreementLoading = false;
    await authenticatedAgreement();
  } catch (error) {
    if (!agreementRequestIsCurrent(requestGeneration, userId)) return;
    agreementLoading = false;
    elements.error.textContent = errorMessage(error);
    elements.error.hidden = false;
    renderAgreement();
    reportUiError("agreement_accept_failed", error);
    if (error?.code === "agreement_version_stale") await authenticatedAgreement();
  }
}

// `onSatisfied` continues onboarding once the agreement is signed (or not required);
// `onLegalUnaccepted` puts the Terms and Privacy screens back up.
export function initAgreementGate(onSatisfied, onLegalUnaccepted = async () => {}) {
  onAgreementSatisfied = onSatisfied;
  onTermsOrPrivacyUnaccepted = onLegalUnaccepted;
  const section = requiredElement("agreement-section");
  elements = {
    card: section.querySelector(".agreement-card"),
    intro: requiredElement("agreement-intro"),
    status: requiredElement("agreement-status"),
    document: requiredElement("agreement-document"),
    form: requiredElement("agreement-form"),
    name: requiredElement("agreement-signer-name"),
    accept: requiredElement("agreement-accept"),
    support: requiredElement("agreement-support"),
    retry: requiredElement("agreement-retry"),
    error: requiredElement("agreement-error"),
    tab: requiredElement("tab-contributor-agreement"),
  };
  elements.form.addEventListener("submit", acceptAgreement);
  elements.name.addEventListener("input", renderAgreement);
  elements.retry.addEventListener("click", authenticatedAgreement);
  renderAgreement();
}
