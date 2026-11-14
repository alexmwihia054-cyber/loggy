import { reportUiError } from "./errors.js";
import { acceptLegalDocuments, legalDocumentFragment, openLinksExternally } from "./legal-documents.js";
import { state } from "./state.js";
import { trackOnboardingEvent } from "./onboarding-telemetry.js";
import { LEGAL_DOCUMENTS_UPDATED_NOTICE } from "./views.js";

const CONSENT_INTRO = "Please review and consent before continuing.";

let activeVersion = null;
let saving = false;
let rejecting = false;
// The account accepted an earlier version of the consent now shown.
let updated = false;
let checkbox = null;
let continueButton = null;
let rejectButton = null;
let intro = null;
let copy = null;
let errorElement = null;

function showError(message) {
  if (!errorElement) return;
  errorElement.textContent = message || "";
  errorElement.hidden = !message;
}

function renderRecordingConsent() {
  if (continueButton) continueButton.disabled = saving || !activeVersion || !checkbox?.checked;
  if (rejectButton) rejectButton.disabled = saving || rejecting;
  if (intro) {
    intro.textContent = updated ? LEGAL_DOCUMENTS_UPDATED_NOTICE : CONSENT_INTRO;
  }
}

// `status` is the server's current Recording Consent:
// { version, html, accepted, previously_accepted }.
export function restoreRecordingConsent(status) {
  const version = status?.version ?? null;
  if (version !== activeVersion) {
    copy?.replaceChildren(...(status?.html ? [legalDocumentFragment(status.html)] : []));
  }
  // A new text, or a consent now on record, starts the checkbox over. The same text still pending
  // (a check that read the server just before a save) keeps it.
  if ((version !== activeVersion || status?.accepted) && checkbox) checkbox.checked = false;
  activeVersion = version;
  state.recordingConsentPending = !status?.accepted;
  updated = !!status && !status.accepted && !!status.previously_accepted;
  if (!state.recordingConsentPending) showError("");
  renderRecordingConsent();
}

export function resetRecordingConsent() {
  activeVersion = null;
  saving = false;
  state.recordingConsentPending = false;
  updated = false;
  if (checkbox) checkbox.checked = false;
  copy?.replaceChildren();
  showError("");
  renderRecordingConsent();
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (typeof error?.message === "string") return error.message;
  return "Your consent could not be saved. Check your connection and try again.";
}

// `checkAgreementAgain` reloads the consent: after it's saved, and when the server has a newer one.
export function initRecordingConsent(checkAgreementAgain, onRejected) {
  const form = document.getElementById("recording-consent-form");
  checkbox = document.getElementById("recording-consent-checkbox");
  continueButton = document.getElementById("recording-consent-continue");
  rejectButton = document.getElementById("recording-consent-reject");
  intro = document.getElementById("recording-consent-intro");
  copy = document.querySelector(".recording-consent-copy");
  errorElement = document.getElementById("recording-consent-error");
  checkbox.addEventListener("change", renderRecordingConsent);
  openLinksExternally(copy, "recording_consent_link_open_failed");
  rejectButton.addEventListener("click", async () => {
    if (!state.recordingConsentPending || rejecting || saving) return;
    rejecting = true;
    renderRecordingConsent();
    try {
      await trackOnboardingEvent("onboarding.recording_consent.rejected");
      await onRejected();
    } finally {
      rejecting = false;
      renderRecordingConsent();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.recordingConsentPending || !activeVersion || !checkbox.checked || saving) return;
    const version = activeVersion;
    const userId = state.currentUser?.id;
    saving = true;
    showError("");
    renderRecordingConsent();
    try {
      // The app shell only reports success when the server confirms this exact version.
      await acceptLegalDocuments({ recording_consent: version });
      if (state.currentUser?.id !== userId) return;
      await trackOnboardingEvent("onboarding.recording_consent.completed");
      // Checking the agreement again is what opens the native gate, and it closes this screen
      // once it finds the consent on record. If that check fails, the screen stays up.
      await checkAgreementAgain();
    } catch (error) {
      if (state.currentUser?.id !== userId) return;
      showError(errorMessage(error));
      reportUiError("recording_consent_save_failed", error);
      // The server has a newer consent than the one shown: load it.
      if (error?.code === "legal_documents_changed") await checkAgreementAgain();
    } finally {
      saving = false;
      renderRecordingConsent();
    }
  });
  renderRecordingConsent();
}
