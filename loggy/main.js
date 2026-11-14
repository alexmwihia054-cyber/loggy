// Entry point: wires the modules together on DOMContentLoaded. The errors module is
// imported first so its uncaught-error reporting installs before any code that can
// throw — including this file's own init.
import { reportUiError, showErrorBanner } from "./modules/errors.js";

import { identityAllowsAccess, legalGatesSatisfied, state } from "./modules/state.js";
import { invoke, listen, openExternalUrl } from "./modules/tauri.js";
import {
  copyCurrentUserEmail,
  updateAccountSidebar,
} from "./modules/account-sidebar.js";
import {
  acceptLoginTerms,
  acknowledgeLoginPrivacy,
  applyAuthStatus,
  beginSignIn,
  getAuthStatusRevision,
  initAuth,
  logout,
  openAuthView,
  recheckLegalAcceptance,
  requireUpdatedLegalAcceptance,
  resolveLegalAcceptance,
  updateAuthUI,
} from "./modules/auth.js";
import { initDebugTools } from "./modules/debug.js";
import {
  legalDocumentFragment,
  loadedLegalDocument,
  openLinksExternally,
} from "./modules/legal-documents.js";
import { initFaq } from "./modules/faq.js";
import { initReferrals, syncReferralsIntro } from "./modules/referrals.js";
import {
  authenticatedAgreement,
  initAgreementGate,
  openAgreementReview,
  resetAgreement,
} from "./modules/agreement.js";
import {
  authenticatedIdentity,
  initIdentityVerification,
  openIdentityView,
  signedOutIdentity,
} from "./modules/identity.js";
import {
  initPermissionsGate,
  markPermissionsGranted,
  refreshPermissions,
} from "./modules/permissions.js";
import {
  initReplayCheck,
  restoreReplayCheckAfterRestart,
} from "./modules/replay-check.js";
import {
  startButtonCooldown,
  startRecording,
  startStatusPolling,
  stopRecording,
  updateUI,
} from "./modules/recording.js";
import { refreshSessions, renderSessions } from "./modules/sessions.js";
import { refreshUploadedHistory } from "./modules/uploaded-history.js";
import { setChosenView, updateLayout } from "./modules/views.js";
import { initRecordingConsent } from "./modules/recording-consent.js";
import { initOnboarding } from "./modules/onboarding.js";
import { initOnboardingIntro } from "./modules/onboarding-intro.js";
import { noteRateTierChanged, syncRateNotice } from "./modules/rates.js";

let sessionsRefreshInterval;
// Policies deployed while the app is open are checked again when the window comes to the front,
// at most this often. Both clocks are kept: the wall clock can be set back, and the monotonic one
// may not count time asleep; a check is due when either says the interval has passed.
const LEGAL_RECHECK_INTERVAL_MS = 10 * 60 * 1000;
let lastLegalRecheck = { monotonic: performance.now(), wall: Date.now() };
// Where the website shows the Terms and Privacy Notice for this build's server.
const legalPageUrls = { terms: "https://loggy3.com/terms", privacy: "https://loggy3.com/privacy" };

async function queryRecorderStatus() {
  const generation = ++state.recorderStatusGeneration;
  const recorderStatus = await invoke("get_recording_status").catch(() => null);
  return { generation, recorderStatus };
}

function restoreRecorderStatus(snapshot) {
  if (!snapshot
      || snapshot.generation !== state.recorderStatusGeneration) return;
  if (!snapshot.recorderStatus) {
    startStatusPolling();
    return;
  }
  const { recorderStatus } = snapshot;
  const previous = [
    state.wantsToRecord,
    state.isIdle,
    state.recorderPhase,
    state.resumePending,
  ];
  state.wantsToRecord = !!recorderStatus.wants_to_record;
  state.isIdle = !!recorderStatus.paused_for_idle;
  state.recorderPhase = recorderStatus.phase
    || (recorderStatus.recording ? "recording" : "stopped");
  state.resumePending = !!recorderStatus.resume_pending;
  if (recorderStatus.last_error) showErrorBanner(recorderStatus.last_error);
  if (previous[0] !== state.wantsToRecord
      || previous[1] !== state.isIdle
      || previous[2] !== state.recorderPhase
      || previous[3] !== state.resumePending) {
    updateUI();
  }
  if (recorderStatus.recording
      || state.wantsToRecord
      || state.recorderPhase === "stopping"
      || state.resumePending) {
    startStatusPolling();
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  // Heartbeat for the backend webview watchdog, started before anything that can fail:
  // it must mean "this renderer is alive", not "this renderer finished initializing".
  // When it sat further down, any throw during startup looked identical to a dead
  // renderer, and the watchdog's reload re-ran the same failing init — reloading the
  // window every 30s for the rest of the session.
  const sendHeartbeat = () => { invoke("ui_heartbeat").catch(() => {}); };
  sendHeartbeat();
  setInterval(sendHeartbeat, 2000);

  // A JavaScript timer can keep running after the webview's presentation path
  // stalls. Track animation frames separately so the native watchdog can recover
  // that half-alive state. Hidden pages are reported explicitly because browsers
  // intentionally suspend requestAnimationFrame while hidden.
  let lastFrameHeartbeat = 0;
  const sendVisibility = () => {
    invoke("ui_frame_heartbeat", {
      visible: document.visibilityState === "visible",
    }).catch(() => {});
  };
  const onAnimationFrame = (timestamp) => {
    if (timestamp - lastFrameHeartbeat >= 2000) {
      lastFrameHeartbeat = timestamp;
      invoke("ui_frame_heartbeat", { visible: true }).catch(() => {});
    }
    window.requestAnimationFrame(onAnimationFrame);
  };
  document.addEventListener("visibilitychange", sendVisibility);
  window.addEventListener("focus", () => {
    refreshUploadedHistory();
    if (legalGatesSatisfied()) refreshPermissions();
    void recheckLegalDocuments();
  });
  sendVisibility();
  window.requestAnimationFrame(onAnimationFrame);

  const channelBanner = document.getElementById("staging-banner");
  let buildChannel;
  try {
    buildChannel = await invoke("build_channel");
    if (buildChannel !== "production" && buildChannel !== "staging") {
      throw new Error(`Unsupported build channel: ${buildChannel}`);
    }
  } catch (error) {
    channelBanner.textContent =
      "BUILD CHANNEL UNKNOWN · app initialization blocked";
    channelBanner.hidden = false;
    document.title = "Loggy3 — Build Channel Unknown";
    throw error;
  }
  state.buildChannel = buildChannel;
  const appName = await invoke("app_name");
  state.appName = appName;
  document.title = appName;
  document.getElementById("app-startup-message").textContent = `Starting ${appName}…`;
  document.querySelectorAll("[data-app-name]").forEach((element) => {
    element.textContent = appName;
  });
  document.querySelector("#auth-email-step h1").textContent = `Get started with ${appName === "Recorder" ? "Recorder" : "Loggy"}`;
  if (appName === "Recorder") {
    document.querySelectorAll('img[src="assets/icon.png"]').forEach((element) => {
      element.src = "assets/enterprise/icon.png";
    });
  }
  if (buildChannel === "staging") {
    const server = new URL(await invoke("legal_page_url", { page: "terms" })).host;
    channelBanner.textContent = `${appName.toUpperCase()} · uploads to ${server}`;
    channelBanner.hidden = false;
  } else {
    document.querySelectorAll("[data-staging-only]").forEach((element) => element.remove());
    state.debugPane = "logs";
  }
  for (const page of ["terms", "privacy"]) {
    legalPageUrls[page] = await invoke("legal_page_url", { page });
    const link = document.getElementById(`account-banned-${page}`);
    if (link) link.href = legalPageUrls[page];
  }

  state.recordBtn = document.getElementById("record-btn");
  state.recordText = document.getElementById("record-text");
  state.recordIcon = document.getElementById("record-icon");
  state.statusIndicator = document.getElementById("status-indicator");
  state.statusText = document.getElementById("status-text");
  state.elapsedTimerEl = document.getElementById("elapsed-timer");
  state.logoutBtn = document.getElementById("logout-btn");
  state.sessionsSection = document.getElementById("sessions-section");
  state.faqSection = document.getElementById("faq-section");
  state.tabFaq = document.getElementById("tab-faq");
  state.replayCheckSection = document.getElementById("replay-check-section");
  state.sessionsList = document.getElementById("sessions-list");
  state.legalContent = document.getElementById("legal-content");
  state.tabTerms = document.getElementById("tab-terms");
  state.tabPrivacy = document.getElementById("tab-privacy");
  state.tabContributorAgreement = document.getElementById("tab-contributor-agreement");
  state.acceptLegalBtn = document.getElementById("accept-legal-btn");
  state.termsAcceptControl = document.getElementById("terms-accept-control");
  state.termsAcceptCheckbox = document.getElementById("terms-accept-checkbox");
  state.privacyAcceptControl = document.getElementById("privacy-accept-control");
  state.privacyAcceptCheckbox = document.getElementById("privacy-accept-checkbox");
  state.transportControls = document.getElementById("transport-controls");
  state.sessionRate = document.getElementById("session-rate");
  state.tosControls = document.getElementById("tos-controls");
  state.mainTitle = document.getElementById("main-title");
  state.banScreen = document.getElementById("account-banned-screen");
  state.permissionsSection = document.getElementById("permissions-section");
  state.authSection = document.getElementById("auth-section");
  state.identitySection = document.getElementById("identity-section");
  state.agreementSection = document.getElementById("agreement-section");
  state.recordingConsentSection = document.getElementById("recording-consent-section");
  state.referralCodeSection = document.getElementById("referral-code-section");
  state.referralsSection = document.getElementById("referrals-section");
  state.tabReferrals = document.getElementById("tab-referrals");
  initOnboardingIntro();
  initOnboarding(appName);
  state.tabPermissions = document.getElementById("tab-permissions");
  let startupAuthRestoring = false;
  let pendingStartupAccountStatus = null;
  await listen("account-status-changed", async ({ payload }) => {
    if (!payload?.authenticated || !payload.user) return;
    if (!state.isAuthenticated) {
      if (startupAuthRestoring) pendingStartupAccountStatus = payload;
      return;
    }
    if (payload.user.id !== state.currentUser?.id) return;
    const wasBanned = state.accountBanned;
    const applied = applyAuthStatus(payload);
    if (applied && wasBanned && !state.accountBanned) {
      if (state.tosAcceptedThisRun) await authenticatedAgreement();
      else await completeAuthentication();
    }
  });
  await listen("rate-tier-changed", ({ payload }) => noteRateTierChanged(payload));
  await listen("authentication-invalidated", ({ payload }) => {
    if (!state.isAuthenticated || payload?.userId !== state.currentUser?.id) return;
    state.tosAcceptedThisRun = false;
    resetAgreement();
    if (state.termsAcceptCheckbox) state.termsAcceptCheckbox.checked = false;
    if (state.privacyAcceptCheckbox) state.privacyAcceptCheckbox.checked = false;
    applyAuthStatus(null);
    signedOutIdentity();
    beginSignIn();
  });
  let updateInstallingEventVersion = 0;
  await listen("update-installing", async ({ payload }) => {
    const eventVersion = ++updateInstallingEventVersion;
    state.updateInstalling = !!payload;
    updateUI();
    updateAccountSidebar();
    if (!state.updateInstalling) {
      startStatusPolling();
      const recorderStatus = await queryRecorderStatus();
      if (eventVersion === updateInstallingEventVersion && !state.updateInstalling) {
        restoreRecorderStatus(recorderStatus);
      }
    }
  });
  await listen("recording-resumed-after-update", async () => {
    markPermissionsGranted();
    const recorderStatus = await queryRecorderStatus();
    restoreRecorderStatus(recorderStatus);
  });
  const updateInstallingVersionBeforeQuery = updateInstallingEventVersion;
  const updateInstalling = await invoke("update_installation_in_progress");
  if (updateInstallingEventVersion === updateInstallingVersionBeforeQuery) {
    state.updateInstalling = !!updateInstalling;
    updateUI();
    updateAccountSidebar();
  }
  const permissionsPageAvailable = !navigator.userAgent.includes("Windows");
  if (state.tabPermissions && !permissionsPageAvailable) {
    state.tabPermissions.style.display = "none";
  }

  // Keep the app hidden until saved authentication and the current legal gates resolve.
  const startupRecorderStatus = queryRecorderStatus();

  let permissionsGateInitPromise;
  const ensurePermissionsGate = () => {
    if (!permissionsGateInitPromise) {
      permissionsGateInitPromise = initPermissionsGate();
    }
    return permissionsGateInitPromise;
  };

  if (state.tabPermissions && permissionsPageAvailable) {
    state.tabPermissions.addEventListener("click", () => {
      if (!legalGatesSatisfied()) return;
      if (!state.permissionsOk) {
        updateLayout();
        return;
      }
      setChosenView("permissions");
      updateLayout();
    });
  }

  const tabSessions = document.getElementById("tab-sessions");
  if (tabSessions) {
    tabSessions.addEventListener("click", () => {
      if (!legalGatesSatisfied()) return;
      setChosenView(null);
      // Contents may have changed while another view was up, so re-read rather than
      // showing whatever the 5s poll last happened to render.
      refreshSessions();
      refreshUploadedHistory();
      updateLayout();
    });
  }

  const continueOnboarding = async () => {
    if (!state.isAuthenticated || state.accountBanned || !legalGatesSatisfied()) return;
    permissionsGateInitPromise = null;
    await Promise.all([refreshPermissions(), authenticatedIdentity()]);
    if (state.isAuthenticated && legalGatesSatisfied() && identityAllowsAccess()) {
      await ensurePermissionsGate();
    }
    restoreReplayCheckAfterRestart();
  };
  initRecordingConsent(async () => {
    setChosenView(null);
    // Checking again is what opens the native gate for recording and uploads.
    await authenticatedAgreement();
    updateUI();
  }, logout);
  // The agreement check found Terms or a Privacy Notice deployed since this login accepted them:
  // their screens come back at once, then with the current text once it loads.
  async function showUpdatedLegalDocuments() {
    const reloading = requireUpdatedLegalAcceptance();
    showLegalDocument('terms');
    updateLayout();
    if (await reloading) {
      showLegalDocument('terms');
      updateLayout();
    }
  }
  initAgreementGate(continueOnboarding, showUpdatedLegalDocuments);
  window.addEventListener("loggy3-agreement-changed", updateUI);
  await listen("agreement-required", async () => {
    resetAgreement();
    updateUI();
    await authenticatedAgreement();
  });

  const tabLogin = document.getElementById("tab-login");
  // After sign-in, and again when the server answers after being unreachable or an account is
  // unbanned: the Terms and Privacy screens are skipped only when the server has this account's
  // acceptance of the versions it serves now.
  async function completeAuthentication() {
    if (!state.tosAcceptedThisRun) {
      const tokenId = state.currentTokenId;
      const accepted = await resolveLegalAcceptance();
      if (!state.isAuthenticated || state.currentTokenId !== tokenId) return;
      showLegalDocument('terms');
      updateLayout();
      if (!accepted) {
        if (await nativeTermsAccepted()) await authenticatedAgreement();
        return;
      }
    }
    const recorderStatus = await queryRecorderStatus();
    restoreRecorderStatus(recorderStatus);
    await authenticatedAgreement();
  }
  initAuth(completeAuthentication);
  // For a login that accepted Terms on this computer before, the agreement check runs even while
  // newer Terms wait to be accepted: the native gate needs them too, so it stays closed, and
  // closing it cancels a recording an app update left to resume instead of letting it start once
  // they accept.
  async function nativeTermsAccepted() {
    return !state.accountBanned && await invoke("tos_state").then(Boolean).catch(() => false);
  }
  initIdentityVerification();
  window.addEventListener("loggy3-identity-changed", () => {
    updateUI();
    if (state.isAuthenticated && legalGatesSatisfied() && identityAllowsAccess()) {
      void ensurePermissionsGate();
    }
  });
  let authRestorePromise;
  const restoreAuthentication = () => {
    if (!authRestorePromise) {
      if (tabLogin) tabLogin.dataset.authBusy = "true";
      state.authTransitionBusyCount += 1;
      updateUI();
      updateAccountSidebar();
      const authRevisionBeforeRestore = getAuthStatusRevision();
      startupAuthRestoring = true;
      authRestorePromise = invoke("check_startup_auth_command")
        .then(async (authStatus) => {
          if (authStatus) {
            const applied = applyAuthStatus(authStatus, {
              expectedRevision: authRevisionBeforeRestore,
            });
            const pendingStatus = pendingStartupAccountStatus;
            pendingStartupAccountStatus = null;
            if (applied && pendingStatus?.user?.id === authStatus.user.id) {
              applyAuthStatus(pendingStatus);
            }
            if (applied) {
              // The documents may have changed since this login accepted them, so check the
              // server before the screens are skipped (a banned account is checked if unbanned).
              state.tosAcceptedThisRun = false;
              await resolveLegalAcceptance();
              showLegalDocument('terms');
              const agreementCheck = state.tosAcceptedThisRun || await nativeTermsAccepted()
                ? authenticatedAgreement() : null;
              updateUI();
              updateAccountSidebar();
              await agreementCheck;
            }
          }
        })
        .catch((error) => {
          reportUiError("auth_restore_failed", error);
        })
        .finally(() => {
          state.authTransitionBusyCount -= 1;
          startupAuthRestoring = false;
          pendingStartupAccountStatus = null;
          if (tabLogin) tabLogin.dataset.authBusy = "false";
          updateUI();
          updateAuthUI();
          if (!state.isAuthenticated) beginSignIn();
        });
    }
    return authRestorePromise;
  };
  if (tabLogin) {
    tabLogin.addEventListener("click", async () => {
      if (state.isAuthenticated) {
        await copyCurrentUserEmail();
        return;
      }
      openAuthView();
    });
  }
  updateAccountSidebar();
  if (state.logoutBtn) {
    state.logoutBtn.addEventListener("click", logout);
  }

  const permScreenBtn = document.getElementById("perm-screen-btn");
  if (permScreenBtn) {
    permScreenBtn.addEventListener("click", () => {
      invoke("open_permission_settings", { pane: "screen_recording" })
        .catch((error) => reportUiError("permission_settings_failed", error));
    });
  }
  const permInputBtn = document.getElementById("perm-input-btn");
  if (permInputBtn) {
    permInputBtn.addEventListener("click", () => {
      invoke("open_permission_settings", { pane: "input_monitoring" })
        .catch((error) => reportUiError("permission_settings_failed", error));
    });
  }
  const permReplayBtn = document.getElementById("perm-replay-btn");
  if (permReplayBtn) {
    permReplayBtn.addEventListener("click", async () => {
      try {
        const granted = await invoke("request_replay_accessibility");
        if (!granted) {
          await invoke("open_permission_settings", { pane: "accessibility" });
        }
      } catch (error) {
        reportUiError("replay_permission_failed", error);
      }
    });
  }
  initDebugTools();
  initFaq();
  initReferrals();
  initReplayCheck();

  updateAuthUI();
  await refreshSessions();
  if (sessionsRefreshInterval) clearInterval(sessionsRefreshInterval);
  sessionsRefreshInterval = setInterval(refreshSessions, 5000);

  if (state.legalContent) openLinksExternally(state.legalContent, "legal_link_open_failed");

  // The Terms or Privacy Notice last loaded from the server, or where to read it until then.
  function showLegalDocument(name) {
    if (!state.legalContent) return;
    const loaded = loadedLegalDocument(name);
    const version = loaded?.version ?? "";
    if (state.currentLegalPage !== name || state.legalContent.dataset.version !== version) {
      if (loaded) {
        state.legalContent.replaceChildren(legalDocumentFragment(loaded.html));
      } else {
        const paragraph = document.createElement("p");
        const link = document.createElement("a");
        link.href = legalPageUrls[name];
        link.textContent = legalPageUrls[name].replace(/^https?:\/\//, "");
        paragraph.append(
          name === "privacy"
            ? "The Privacy Notice can’t be loaded right now. You can also read it at "
            : "The Terms can’t be loaded right now. You can also read them at ",
          link,
          ".",
        );
        state.legalContent.replaceChildren(paragraph);
      }
      state.legalContent.dataset.version = version;
      state.currentLegalPage = name;
    }
    state.legalContent.scrollTop = 0;
  }

  // A Terms, Privacy or consent change deployed since start-up reaches people when they bring
  // the window forward. A check that fails changes nothing.
  async function recheckLegalDocuments() {
    if (performance.now() - lastLegalRecheck.monotonic < LEGAL_RECHECK_INTERVAL_MS
        && Date.now() - lastLegalRecheck.wall < LEGAL_RECHECK_INTERVAL_MS) return;
    if (!state.isAuthenticated || state.accountBanned) return;
    const previousRecheck = lastLegalRecheck;
    lastLegalRecheck = { monotonic: performance.now(), wall: Date.now() };
    // Whether the native gate could be open: everything accepted when this check started.
    const gateMayBeOpen = state.tosAcceptedThisRun && state.agreementSatisfied
      && !state.recordingConsentPending;
    const recheck = await recheckLegalAcceptance();
    // A check that was skipped or failed doesn't count: the window coming forward next tries again.
    if (!recheck) {
      lastLegalRecheck = previousRecheck;
      return;
    }
    // Screens put up again, or started over with new text, open at the top of the Terms. With
    // nothing new, someone partway through them stays where they are.
    if (recheck.restarted) {
      showLegalDocument('terms');
      updateLayout();
    }
    // Any of the three deployed since it was accepted closes the native gate: recording stops,
    // uploads wait until it's accepted, and nothing resumes on its own.
    const allAccepted = ["terms", "privacy", "recording_consent"]
      .every((name) => recheck.documents[name]?.accepted);
    if (gateMayBeOpen && !allAccepted) {
      await authenticatedAgreement();
      updateUI();
    }
  }

  const showLegalPage = async (which) => {
    setChosenView("legal");
    showLegalDocument(which);
    updateLayout();
    // Outside the gate updateLayout() derives the highlight from currentLegalPage, which
    // showLegalDocument just set. The gate path does not, so assert it there.
    if (!state.permissionsOk) {
      (which === 'terms' ? state.tabTerms : state.tabPrivacy).classList.add('active');
    }
  };
  state.tabTerms.addEventListener('click', () => showLegalPage('terms'));
  state.tabPrivacy.addEventListener('click', () => showLegalPage('privacy'));
  for (const page of ['terms', 'privacy']) {
    document.getElementById(`auth-${page}`).addEventListener('click', (event) => {
      event.preventDefault();
      openExternalUrl(event.currentTarget.href)
        .catch((error) => reportUiError("legal_link_open_failed", error));
    });
  }
  state.tabContributorAgreement.addEventListener('click', () => {
    setChosenView("agreement-review");
    updateLayout();
    if (openAgreementReview()) return;
    setChosenView(null);
    updateLayout();
  });
  document.getElementById("onboarding-payment-provider").addEventListener("click", (event) => {
    event.preventDefault();
    openExternalUrl(event.currentTarget.href)
      .catch((error) => reportUiError("payment_provider_link_open_failed", error));
  });
  state.termsAcceptCheckbox?.addEventListener('change', updateLayout);
  state.privacyAcceptCheckbox?.addEventListener('change', updateLayout);
  if (state.acceptLegalBtn) state.acceptLegalBtn.addEventListener('click', async () => {
    if (state.currentLegalPage === 'terms') {
      if (!state.termsAcceptCheckbox?.checked) return;
      if (acceptLoginTerms()) await showLegalPage('privacy');
      return;
    }
    if (state.currentLegalPage !== 'privacy'
        || state.legalContent?.style.display === 'none') {
      await showLegalPage('terms');
      return;
    }
    if (!state.privacyAcceptCheckbox?.checked) return;
    if (!await acknowledgeLoginPrivacy()) {
      await showLegalPage('terms');
    }
  });

  // Resolve authentication before first paint. A valid saved token resumes directly;
  // a missing or revoked token routes to sign-in, then legal acceptance.
  updateAuthUI();
  const [, recorderStatus] = await Promise.all([
    restoreAuthentication(),
    startupRecorderStatus,
  ]);
  restoreRecorderStatus(recorderStatus);
  if (state.isAuthenticated && legalGatesSatisfied()) {
    await refreshPermissions();
    restoreReplayCheckAfterRestart();
    if (identityAllowsAccess()) await ensurePermissionsGate();
  }

  // Load the terms on startup; updateLayout decides whether current acceptance skips the gate.
  showLegalDocument('terms');
  updateLayout();

  state.recordBtn.addEventListener("click", async (event) => {
    const shouldStop = state.wantsToRecord
      || state.recorderPhase === "stopping"
      || state.resumePending;
    if (!shouldStop && !state.permissionsOk) return; // gate: starting requires OS permissions
    if (!shouldStop && !legalGatesSatisfied()) return;
    if (!shouldStop && state.replayCheckBusy) return;

    // Cancellation must reach the backend immediately. Delaying Stop behind the
    // visual cooldown can let an updater restart the process with its durable resume
    // marker still armed; the cooldown only needs to prevent a second click.
    if (shouldStop) {
      if (!startButtonCooldown()) return;
      try {
        await stopRecording();
        await refreshSessions();
      } catch (error) {
        reportUiError("recording_toggle_failed", error);
      }
      return;
    }

    startButtonCooldown(async () => {
      try {
        await restoreAuthentication();
        if (!state.isAuthenticated) {
          showErrorBanner("Sign in before starting a recording.");
          openAuthView();
        }
        if (!state.isAuthenticated) return;
        if (state.accountBanned) return;
        if (!state.agreementSatisfied) {
          showErrorBanner("Accept the User Service Agreement before starting a recording.");
          await authenticatedAgreement();
          return;
        }
        if (!identityAllowsAccess()) {
          showErrorBanner("Complete identity verification before starting a recording.");
          openIdentityView();
          return;
        }
        await startRecording();
        await refreshSessions();
      } catch (error) {
        reportUiError("recording_toggle_failed", error);
      }
    });
  });

  document.addEventListener("click", (e) => {
    // Deselect if clicking anywhere outside the currently selected row
    if (state.selectedSessionName !== null) {
      const selectedRow = document.querySelector("tr.session-item.selected");
      if (!selectedRow || !selectedRow.contains(e.target)) {
        state.selectedSessionName = null;
        renderSessions(state.lastSessions);
      }
    }
  });

  document.body.classList.remove("app-initializing");
  syncRateNotice();
  syncReferralsIntro();
  invoke("log_ui_ready").catch(() => {});
});
