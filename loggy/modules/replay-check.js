import { reportUiError, showErrorBanner } from "./errors.js";
import { updateAccountSidebar } from "./account-sidebar.js";
import { identityAllowsAccess, legalGatesSatisfied, state } from "./state.js";
import { invoke } from "./tauri.js";
import { setChosenView, updateLayout } from "./views.js";

let recording = false;
let playing = false;
let hasRecording = false;
let commandPending = false;
let pendingAction = null;
let lastError = null;
let playbackComplete = false;
let guidanceOverride = null;
let replayAccessibility = true;
let replayRestartRequired = false;
let latestDurationSeconds = 0;
let replayStatusUnknown = true;
let replayStatusFailed = false;
let replayStatusGeneration = 0;
let replayStatusRequest = null;
let activeGameRun = null;
let activeGameUrl = null;
const REOPEN_AFTER_RESTART_KEY = "loggy3-reopen-replay-check";
const CALIBRATION_SEED = 73091;
const CALIBRATION_REVISION = 14;
const CALIBRATION_STAGES = 9;
const GAME_EVENT_KINDS = new Set([
  "progress",
  "calibration",
  "diagnostic",
  "complete",
]);

const byId = (id) => document.getElementById(id);

function formatTimer(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function setMessage(message) {
  const element = byId("replay-check-message");
  if (element) element.textContent = message;
}

function invalidateReplayStatus() {
  replayStatusGeneration += 1;
  replayStatusUnknown = true;
  replayStatusFailed = false;
}

function guidanceMessage() {
  if (guidanceOverride) return guidanceOverride;
  if (playing) return "Playback — keep your hands off the mouse and keyboard.";
  if (recording) {
    return `Step 2 of 3 — Complete all ${CALIBRATION_STAGES} stages, then stop recording.`;
  }
  if (playbackComplete) {
    return `Replay complete — confirm that all ${CALIBRATION_STAGES} stages finished.`;
  }
  if (hasRecording && replayRestartRequired) {
    return "Restart required — enable Loggy3 in Accessibility, then click Restart Loggy3 below.";
  }
  if (hasRecording && !replayAccessibility) {
    return "Step 3 of 3 — Allow Replay Control. You must restart Loggy3 after enabling it.";
  }
  if (hasRecording) return "Step 3 of 3 — Play the recording and keep your hands off.";
  return "Step 1 of 3 — Start recording.";
}

function createGameRun() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function frameUrl(frame) {
  try {
    return frame.contentWindow?.location.href || null;
  } catch {
    return null;
  }
}

function guardCalibrationNavigation(frame) {
  if (!activeGameUrl) return;
  if (frameUrl(frame) !== activeGameUrl) {
    frame.contentWindow?.location.replace(activeGameUrl);
    return;
  }

  const frameDocument = frame.contentDocument;
  if (frameDocument?.documentElement) {
    frameDocument.documentElement.style.overscrollBehaviorX = "none";
  }
  if (frameDocument?.body) {
    frameDocument.body.style.overscrollBehaviorX = "none";
  }
}

function loadCalibrationGame(phase, run = createGameRun()) {
  const frame = byId("replay-check-game-frame");
  if (!frame) return Promise.resolve(null);
  const platform = navigator.userAgent.includes("Windows") ? "windows" : "macos";
  activeGameRun = run;
  activeGameUrl = new URL(
    `assets/e2e.html?seed=${CALIBRATION_SEED}&r=${CALIBRATION_REVISION}&phase=${phase}` +
      `&platform=${platform}&bridge=parent&run=${encodeURIComponent(run)}`,
    document.baseURI,
  ).href;
  return new Promise((resolve) => {
    const onLoad = () => {
      if (frameUrl(frame) !== activeGameUrl) return;
      frame.removeEventListener("load", onLoad);
      resolve(run);
    };
    frame.addEventListener("load", onLoad);
    if (frame.contentWindow) {
      frame.contentWindow.location.replace(activeGameUrl);
    } else {
      frame.src = activeGameUrl;
    }
  });
}

function replayControlsBlocked({ allowStop = false } = {}) {
  const normalRecordingBusy = state.wantsToRecord
    || state.recorderPhase === "stopping"
    || state.resumePending;
  return state.logoutInFlight
    || (state.authTransitionBusyCount > 0 && !allowStop)
    || state.recordingCommandInFlight
    || state.recordingControlBusyCount > 0
    || (state.updateInstalling && !allowStop)
    || (!state.isAuthenticated && !allowStop)
    || (state.accountBanned && !allowStop)
    || (!identityAllowsAccess() && !allowStop)
    || ((!legalGatesSatisfied() || !state.permissionsOk)
      && !allowStop)
    || (replayStatusUnknown && !(allowStop && recording))
    || (normalRecordingBusy && !allowStop);
}

function render() {
  if (state.buildChannel !== "staging") return;
  const recordButton = byId("replay-check-record");
  const playButton = byId("replay-check-play");
  const timer = byId("replay-check-timer");
  const frame = byId("replay-check-game-frame");
  const gateStopButton = byId("replay-gate-stop");
  const gateTimer = byId("replay-gate-timer");
  if (!recordButton || !playButton || !timer) return;

  const recordCommandPending = pendingAction === "starting-recording"
    || pendingAction === "saving-recording";
  const unresolvedStatus = replayStatusUnknown && !replayStatusFailed;
  const replayBusy = unresolvedStatus || commandPending || recording || playing;
  const replayNeedsControl = unresolvedStatus || recording || recordCommandPending;
  const sharedStateChanged = state.replayCheckBusy !== replayBusy
    || state.replayCheckNeedsControl !== replayNeedsControl;
  if (sharedStateChanged) {
    state.replayCheckBusy = replayBusy;
    state.replayCheckNeedsControl = replayNeedsControl;
    updateAccountSidebar();
    updateLayout();
    window.dispatchEvent(new Event("loggy3-replay-state-changed"));
  }
  const recordControlBlocked = replayControlsBlocked({ allowStop: recording });
  const sharedControlBusy = replayControlsBlocked();
  recordButton.disabled = recordControlBlocked || commandPending || playing;
  playButton.disabled = sharedControlBusy
    || commandPending
    || recording
    || playing
    || !hasRecording;
  recordButton.classList.toggle("btn-danger", recording);
  recordButton.classList.toggle("btn-primary", !recording && !hasRecording);
  if (pendingAction === "starting-recording") {
    recordButton.textContent = "Starting…";
  } else if (pendingAction === "saving-recording") {
    recordButton.textContent = "Saving…";
  } else if (recording) {
    recordButton.textContent = "Stop and save";
  } else if (hasRecording) {
    recordButton.textContent = "Record again";
  } else {
    recordButton.textContent = "Start recording";
  }
  if (pendingAction === "requesting-replay-access") {
    playButton.textContent = "Opening Settings…";
  } else if (pendingAction === "restarting") {
    playButton.textContent = "Restarting…";
  } else if (pendingAction === "preparing-playback") {
    playButton.textContent = "Preparing playback…";
  } else if (playing) {
    playButton.textContent = "Playing…";
  } else if (hasRecording && replayRestartRequired) {
    playButton.textContent = "Restart Loggy3";
  } else if (hasRecording && !replayAccessibility) {
    playButton.textContent = "Allow replay";
  } else {
    playButton.textContent = "Play recording";
  }
  playButton.classList.toggle(
    "btn-primary",
    hasRecording,
  );
  timer.textContent = recording ? formatTimer(latestDurationSeconds) : "00:00";
  if (gateStopButton) {
    gateStopButton.disabled = !recording || recordControlBlocked || commandPending || playing;
    if (pendingAction === "starting-recording") {
      gateStopButton.textContent = "Starting Replay Check…";
    } else if (pendingAction === "saving-recording") {
      gateStopButton.textContent = "Stopping Replay Check…";
    } else if (recording) {
      gateStopButton.textContent = "Stop Replay Check";
    } else {
      gateStopButton.textContent = "Checking Replay Check…";
    }
  }
  if (gateTimer) {
    gateTimer.textContent = recording ? formatTimer(latestDurationSeconds) : "00:00";
  }
  if (frame) {
    const interactive = !sharedControlBusy && (playing || (recording && !commandPending));
    frame.style.pointerEvents = interactive ? "auto" : "none";
    frame.inert = !interactive;
  }
  setMessage(guidanceMessage());
}

function syncStatus() {
  const generation = replayStatusGeneration;
  if (replayStatusRequest) {
    if (replayStatusRequest.generation === generation) {
      return replayStatusRequest.promise;
    }
    return replayStatusRequest.promise.then(() => {
      if (generation === replayStatusGeneration) return syncStatus();
    });
  }

  const request = { generation, promise: null };
  request.promise = (async () => {
    try {
      const status = await invoke("replay_check_status");
      if (generation !== replayStatusGeneration || replayStatusRequest !== request) return;
      recording = !!status.recording;
      playing = !!status.playing;
      hasRecording = !!status.has_recording;
      latestDurationSeconds = status.duration_seconds || 0;
      replayStatusUnknown = false;
      replayStatusFailed = false;
      replayAccessibility = !!status.replay_accessibility;
      if (pendingAction === "preparing-playback" && playing) {
        pendingAction = null;
      }
      if (!hasRecording) playbackComplete = false;
      render();
      if (status.last_error && status.last_error !== lastError) {
        lastError = status.last_error;
        showErrorBanner(status.last_error);
      }
      if (!status.last_error) lastError = null;
    } catch (error) {
      if (generation === replayStatusGeneration && replayStatusRequest === request) {
        const firstFailure = !replayStatusFailed;
        replayStatusFailed = true;
        render();
        if (firstFailure) reportUiError("replay_status_failed", error);
      }
    } finally {
      if (replayStatusRequest === request) replayStatusRequest = null;
    }
  })();
  replayStatusRequest = request;
  return request.promise;
}

async function toggleRecording() {
  if (replayControlsBlocked({ allowStop: recording }) || commandPending || playing) return;
  if (!recording) latestDurationSeconds = 0;
  guidanceOverride = null;
  playbackComplete = false;
  pendingAction = recording ? "saving-recording" : "starting-recording";
  commandPending = true;
  invalidateReplayStatus();
  render();
  try {
    if (recording) {
      await invoke("stop_replay_check_recording");
      recording = false;
      hasRecording = true;
    } else {
      const runId = createGameRun();
      await invoke("start_replay_check_recording", { runId });
      await loadCalibrationGame("record", runId);
      recording = true;
      hasRecording = false;
    }
  } catch (error) {
    reportUiError("replay_recording_failed", error);
    showErrorBanner(`Replay Check: ${error}`);
    guidanceOverride = "Fix the error above, then try again.";
  } finally {
    invalidateReplayStatus();
    await syncStatus();
    commandPending = false;
    pendingAction = null;
    render();
  }
}

async function requestReplayAccess() {
  if (replayControlsBlocked() || commandPending) return;
  commandPending = true;
  pendingAction = "requesting-replay-access";
  guidanceOverride = null;
  invalidateReplayStatus();
  render();
  try {
    replayRestartRequired = true;
    replayAccessibility = !!(await invoke("request_replay_accessibility"));
    if (!replayAccessibility) {
      await invoke("open_permission_settings", { pane: "accessibility" });
    }
  } catch (error) {
    replayRestartRequired = false;
    reportUiError("replay_permission_failed", error);
    showErrorBanner(`Replay Check: ${error}`);
    guidanceOverride = "Could not open Accessibility settings. Open it manually and try again.";
  } finally {
    invalidateReplayStatus();
    await syncStatus();
    commandPending = false;
    pendingAction = null;
    render();
  }
}

async function restartForReplayAccess() {
  if (replayControlsBlocked() || commandPending) return;
  commandPending = true;
  pendingAction = "restarting";
  localStorage.setItem(REOPEN_AFTER_RESTART_KEY, "1");
  render();
  try {
    await invoke("restart_app");
  } catch (error) {
    localStorage.removeItem(REOPEN_AFTER_RESTART_KEY);
    commandPending = false;
    pendingAction = null;
    reportUiError("replay_restart_failed", error);
    showErrorBanner(`Replay Check: ${error}`);
    guidanceOverride = "Quit and reopen Loggy3 to finish enabling Replay Control.";
    render();
  }
}

function handlePlayButton() {
  if (replayControlsBlocked() || commandPending) return;
  if (replayRestartRequired) {
    return restartForReplayAccess();
  }
  if (!replayAccessibility) {
    return requestReplayAccess();
  }
  return playRecording();
}

export function restoreReplayCheckAfterRestart() {
  if (
    state.buildChannel !== "staging"
    || localStorage.getItem(REOPEN_AFTER_RESTART_KEY) !== "1"
    || !legalGatesSatisfied()
    || !state.permissionsOk
    || !identityAllowsAccess()
  ) {
    return false;
  }
  localStorage.removeItem(REOPEN_AFTER_RESTART_KEY);
  setChosenView("replay-check");
  updateLayout();
  syncStatus();
  return true;
}

export function updateReplayCheckControls() {
  render();
}

export function refreshReplayCheckStatus() {
  if (state.buildChannel !== "staging") return Promise.resolve();
  invalidateReplayStatus();
  render();
  return syncStatus();
}

async function playRecording() {
  if (replayControlsBlocked()
      || commandPending
      || recording
      || playing
      || !hasRecording
      || !replayAccessibility) return;
  guidanceOverride = null;
  playbackComplete = false;
  commandPending = true;
  pendingAction = "preparing-playback";
  playing = true;
  invalidateReplayStatus();
  render();
  let playbackFinished = false;
  try {
    const runId = await loadCalibrationGame("replay");
    const result = await invoke("play_replay_check", { runId });
    playbackFinished = true;
    if (result?.outcome === "interrupted") {
      guidanceOverride = "Replay stopped because input was detected. Play it again when ready.";
    } else {
      playbackComplete = true;
    }
  } catch (error) {
    reportUiError("replay_playback_failed", error);
    if (String(error).includes("Accessibility permission")) {
      replayAccessibility = false;
      replayRestartRequired = false;
      guidanceOverride = null;
    } else {
      showErrorBanner(`Replay Check: ${error}`);
      guidanceOverride = "Playback failed. Fix the error above, then try again.";
    }
  } finally {
    if (playbackFinished) playing = false;
    invalidateReplayStatus();
    await syncStatus();
    commandPending = false;
    pendingAction = null;
    render();
  }
}

export function initReplayCheck() {
  if (state.buildChannel !== "staging") return;
  const tab = byId("tab-replay-check");
  if (tab) tab.hidden = false;
  const gameFrame = byId("replay-check-game-frame");
  if (gameFrame) {
    gameFrame.addEventListener("load", () => guardCalibrationNavigation(gameFrame));
  }

  window.addEventListener("message", (event) => {
    const frame = byId("replay-check-game-frame");
    const message = event.data;
    if (
      !frame ||
      event.source !== frame.contentWindow ||
      message?.type !== "loggy3-replay-game-event" ||
      message?.payload?.run !== activeGameRun ||
      !GAME_EVENT_KINDS.has(message?.kind)
    ) {
      return;
    }
    invoke("log_game_event", {
      kind: message.kind,
      payload: JSON.stringify(message.payload),
    }).catch((error) => reportUiError("replay_event_reporting_failed", error));
  });

  if (tab) {
    tab.addEventListener("click", () => {
      if (!legalGatesSatisfied()) return;
      setChosenView("replay-check");
      updateLayout();
      syncStatus();
    });
  }

  const recordButton = byId("replay-check-record");
  if (recordButton) {
    recordButton.addEventListener("mousemove", () => {
      // WKWebView consumes the first press when focus is still inside the game iframe.
      if (recording && document.activeElement !== recordButton) {
        recordButton.focus({ preventScroll: true });
      }
    });
    recordButton.addEventListener("click", toggleRecording);
  }
  const gateStopButton = byId("replay-gate-stop");
  if (gateStopButton) {
    gateStopButton.addEventListener("click", () => {
      if (recording) toggleRecording();
    });
  }
  const playButton = byId("replay-check-play");
  if (playButton) playButton.addEventListener("click", handlePlayButton);

  window.addEventListener("loggy3-permissions-ready", restoreReplayCheckAfterRestart);
  window.addEventListener("loggy3-account-access-changed", () => {
    render();
    syncStatus();
  });
  window.addEventListener("loggy3-identity-changed", render);
  restoreReplayCheckAfterRestart();
  window.addEventListener("focus", () => {
    if (state.chosenView === "replay-check") syncStatus();
  });

  render();
  loadCalibrationGame("record");
  syncStatus();
  setInterval(() => {
    if (state.chosenView === "replay-check" || recording || playing || replayStatusUnknown) {
      syncStatus();
    }
  }, 500);
}
