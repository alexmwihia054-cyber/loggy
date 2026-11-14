// The recording transport: Start/Stop, the 500ms status poll that mirrors backend
// state (including idle pause and the monitor's give-up error), and the button UI.

import {
  identityAllowsAccess,
  legalGatesSatisfied,
  recorderNeedsControl,
  state,
} from "./state.js";
import { invoke } from "./tauri.js";
import { reportUiError, showErrorBanner } from "./errors.js";
import { formatHMS } from "./format.js";
import { updateAccountSidebar } from "./account-sidebar.js";
import { updateReplayCheckControls } from "./replay-check.js";
import { updateLayout } from "./views.js";
import { renderSessions } from "./sessions.js";
import { rateTierPending } from "./rates.js";

let statusCheckInterval;
let statusPollingGeneration = 0;
let buttonCooldown = false;
let recordingCommandPromise = null;
let lastRecorderError = null;

function updateRecordButtonDisabled() {
  const needsControl = recorderNeedsControl();
  state.recordBtn.disabled = buttonCooldown
    || state.recordingControlBusyCount > 0
    || state.recordingCommandInFlight
    || state.logoutInFlight
    || (state.authTransitionBusyCount > 0 && !needsControl)
    || (state.replayCheckBusy && !needsControl)
    || (state.updateInstalling && !needsControl)
    || (state.accountBanned && !needsControl)
    || (!state.agreementSatisfied && !needsControl)
    || (!identityAllowsAccess() && !needsControl)
    // A self-serve contributor needs to know their rate before recording at it.
    || (rateTierPending() && !needsControl);
}

window.addEventListener("loggy3-replay-state-changed", updateRecordButtonDisabled);
window.addEventListener("loggy3-identity-changed", updateRecordButtonDisabled);
window.addEventListener("loggy3-agreement-changed", updateRecordButtonDisabled);

function runRecordingCommand(command) {
  if (recordingCommandPromise) return recordingCommandPromise;
  state.recordingCommandInFlight = true;
  updateUI();
  updateAccountSidebar();

  recordingCommandPromise = Promise.resolve().then(command).finally(() => {
    recordingCommandPromise = null;
    state.recordingCommandInFlight = false;
    updateUI();
    updateAccountSidebar();
  });
  return recordingCommandPromise;
}

export function startRecording() {
  if (!legalGatesSatisfied()
      || !state.permissionsOk
      || !state.isAuthenticated
      || state.authTransitionBusyCount > 0
      || state.replayCheckBusy
      || state.updateInstalling
      || state.accountBanned
      || !identityAllowsAccess()
      || rateTierPending()) return Promise.resolve();
  return runRecordingCommand(async () => {
    const userId = state.currentUser?.id;
    const startedAt = Date.now();
    state.recorderStatusGeneration += 1;
    try {
      state.wantsToRecord = true;
      state.isIdle = false;
      state.recorderPhase = "starting";
      updateUI();
      await invoke("start_recording");
      window.dispatchEvent(new CustomEvent("loggy3-recording-started", {
        detail: { userId, startedAt },
      }));
      state.recorderStatusGeneration += 1;
      state.wantsToRecord = true;
      state.isIdle = false;
      state.recorderPhase = "starting";
      updateUI();
      startStatusPolling();
    } catch (error) {
      state.recorderStatusGeneration += 1;
      state.wantsToRecord = false;
      state.isIdle = false;
      state.recorderPhase = "stopped";
      updateUI();
      startStatusPolling();
      reportUiError("recording_start_failed", error);
      showErrorBanner(`Failed to start recording: ${error}`);
    }
  });
}

export function stopRecording() {
  if (state.logoutInFlight) return Promise.resolve(false);
  return runRecordingCommand(async () => {
    const resumePending = state.resumePending;
    state.recorderStatusGeneration += 1;
    try {
      state.wantsToRecord = false;
      state.isIdle = false;
      state.recorderPhase = "stopping";
      state.resumePending = false;
      updateUI();
      await invoke("stop_recording");
      state.recorderStatusGeneration += 1;
      state.wantsToRecord = false;
      state.isIdle = false;
      state.recorderPhase = "stopped";
      state.resumePending = false;
      updateUI();
      stopElapsedTimer();
      stopStatusPolling();
      return true;
    } catch (error) {
      state.recorderStatusGeneration += 1;
      state.wantsToRecord = false;
      state.isIdle = false;
      state.recorderPhase = "stopping";
      state.resumePending = resumePending;
      updateUI();
      startStatusPolling();
      reportUiError("recording_stop_failed", error);
      showErrorBanner(`${error}`);
      return false;
    }
  });
}

export function startStatusPolling() {
  stopStatusPolling();
  const generation = statusPollingGeneration;
  let requestInFlight = false;

  statusCheckInterval = setInterval(async () => {
    if (generation !== statusPollingGeneration || requestInFlight) return;
    requestInFlight = true;
    const recorderStatusGeneration = ++state.recorderStatusGeneration;
    try {
      const {
        recording,
        duration_seconds,
        wants_to_record,
        paused_for_idle,
        last_error,
        phase,
        resume_pending,
      } = await invoke("get_recording_status");
      if (generation !== statusPollingGeneration
          || recorderStatusGeneration !== state.recorderStatusGeneration) return;

      // The backend monitor sets last_error only when it has given up restarting the
      // kernel (wants_to_record flips off with it) — tell the user once. A banner,
      // not alert(): a native modal blocks every JS timer including the watchdog
      // heartbeat, so an unattended alert got the window reloaded out from under it
      // after 20s and the message was destroyed unread.
      if (last_error && last_error !== lastRecorderError) {
        lastRecorderError = last_error;
        showErrorBanner(last_error);
      }
      if (!last_error) lastRecorderError = null;

      const prevWantsToRecord = state.wantsToRecord;
      const prevIsIdle = state.isIdle;
      const prevRecorderPhase = state.recorderPhase;
      const prevResumePending = state.resumePending;
      state.wantsToRecord = !!wants_to_record;
      state.isIdle = !!paused_for_idle;
      state.recorderPhase = phase || (recording ? "recording" : "stopped");
      state.resumePending = !!resume_pending;

      if (state.wantsToRecord !== prevWantsToRecord || state.isIdle !== prevIsIdle ||
          state.recorderPhase !== prevRecorderPhase ||
          state.resumePending !== prevResumePending) {
        updateUI();
      }
      if (recording && duration_seconds !== null) {
        state.elapsedTimerEl.textContent = formatHMS(duration_seconds);
      }
      if (!recording && !state.wantsToRecord && !state.resumePending &&
          state.recorderPhase === "stopped") {
        stopElapsedTimer();
        stopStatusPolling();
      }
    } catch (error) {
      if (generation === statusPollingGeneration
          && recorderStatusGeneration === state.recorderStatusGeneration) {
        reportUiError("recording_status_failed", error);
      }
    } finally {
      requestInFlight = false;
    }
  }, 500);
}

export function stopStatusPolling() {
  statusPollingGeneration += 1;
  if (statusCheckInterval) {
    clearInterval(statusCheckInterval);
    statusCheckInterval = null;
  }
}

// Idle pause/resume is handled in the Tauri backend so it keeps working even when the UI is backgrounded.

export function updateUI() {
  updateLayout();
  renderSessions(state.lastSessions);
  if (recorderNeedsControl()) {
    state.recordBtn.classList.remove("btn-primary");
    state.recordBtn.classList.add("btn-danger");
    state.recordText.textContent = "Stop";
    state.recordIcon.innerHTML = '<rect x="6" y="6" width="12" height="12"></rect>';
  } else {
    state.recordBtn.classList.remove("btn-danger");
    state.recordBtn.classList.add("btn-primary");
    state.recordText.textContent = "Start";
    state.recordIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
  }

  if (state.recorderPhase === "stopped") {
    state.statusIndicator.style.display = "none";
    state.statusIndicator.classList.remove("recording");
    state.statusIndicator.classList.remove("idle");
    state.statusIndicator.classList.remove("failed");
  } else {
    state.statusIndicator.style.display = "flex";
    if (state.isIdle) {
      state.statusIndicator.classList.remove("recording");
      state.statusIndicator.classList.remove("failed");
      state.statusIndicator.classList.add("idle");
      state.statusText.textContent = "Idle";
    } else if (state.recorderPhase === "failed") {
      state.statusIndicator.classList.remove("recording");
      state.statusIndicator.classList.remove("idle");
      state.statusIndicator.classList.add("failed");
      state.statusText.textContent = "Failed";
    } else {
      state.statusIndicator.classList.remove("idle");
      state.statusIndicator.classList.remove("failed");
      state.statusIndicator.classList.add("recording");
      const labels = {
        starting: "Starting…",
        stopping: "Stopping…",
        recovering: "Recovering…",
        recording: "Recording",
      };
      state.statusText.textContent = labels[state.recorderPhase] || "Recording";
    }
  }
  updateRecordButtonDisabled();
  updateReplayCheckControls();
}

function stopElapsedTimer() {
  if (state.elapsedTimerEl) state.elapsedTimerEl.textContent = '--:--:--';
}

export function startButtonCooldown(callback) {
  if (buttonCooldown) return false;

  buttonCooldown = true;
  state.recordingControlBusyCount += 1;
  state.recordBtn.classList.add("btn-cooldown");
  state.recordBtn.disabled = true;
  updateAccountSidebar();
  updateReplayCheckControls();

  const finishCooldown = () => {
    buttonCooldown = false;
    state.recordingControlBusyCount -= 1;
    state.recordBtn.classList.remove("btn-cooldown");
    updateRecordButtonDisabled();
    updateAccountSidebar();
    updateReplayCheckControls();
    state.recordBtn.style.removeProperty('--cooldown-progress');
  };

  let countdown = 500;
  const interval = setInterval(() => {
    countdown -= 50;
    const progress = (500 - countdown) / 500;
    state.recordBtn.style.setProperty('--cooldown-progress', `${progress * 100}%`);

    if (countdown <= 0) {
      clearInterval(interval);

      if (callback) {
        callback().finally(finishCooldown);
      } else {
        finishCooldown();
      }
    }
  }, 50);

  return true;
}
