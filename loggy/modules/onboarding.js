import { guidedOnboardingPending, identityAllowsAccess, legalGatesSatisfied, recorderNeedsControl, state } from "./state.js";
import { setChosenView, updateLayout } from "./views.js";
import { refreshSessions } from "./sessions.js";
import { refreshUploadedHistory } from "./uploaded-history.js";
import { trackOnboardingView } from "./onboarding-telemetry.js";

const stages = ["Account", "Participation", "Identity", "Permissions", "First recording"];
const stageOrder = navigator.userAgent.includes("Windows") ? [0, 1, 2, 4] : [0, 1, 2, 3, 4];
const get = (id) => document.getElementById(id);
let accountKey = null;
let storageKey = null;
let firstRecordingStartedAt = null;
let logoutHome;
let savingRecording = false;
let recordingAppName = "Loggy";
let currentView = "auth";
let previousScreen = null;
let screenAnimation;
let animationFrame = null;
let confettiLayer = null;

function celebrateWelcome() {
  if (currentView !== "sessions" || !state.onboardingWelcomePending
      || !get("onboarding-welcome-card").getClientRects().length) return;
  confettiLayer?.remove();
  const layer = document.createElement("div");
  layer.className = "onboarding-confetti";
  layer.setAttribute("aria-hidden", "true");
  get("onboarding-welcome-card").closest(".main-panel").append(layer);
  confettiLayer = layer;
  const colors = ["#4585ed", "#82b8ff", "#f2c14e", "#48bfa3", "#a88ce6", "#ef8c9f"];
  const width = layer.clientWidth;
  const height = layer.clientHeight;
  for (let index = 0; index < 144; index++) {
    const piece = document.createElement("span");
    const direction = index % 2 === 0 ? 1 : -1;
    const size = 4 + Math.random() * 4;
    const shape = Math.floor(index / 2) % 9;
    piece.style.backgroundColor = colors[Math.floor(index / 2) % colors.length];
    piece.style.left = direction === 1 ? "2%" : "98%";
    piece.style.width = `${size}px`;
    piece.style.height = `${size * (shape === 0 ? 1 : shape < 3 ? 2.5 : 1.4)}px`;
    piece.style.borderRadius = shape === 0 ? "50%" : "1px";
    layer.append(piece);
    const duration = 4500 + Math.random() * 1100;
    const velocityX = direction * width * (0.35 + Math.random() * 0.8);
    const velocityY = -height * (1.4 + Math.random() * 0.55);
    const fallSpeed = height * (0.18 + Math.random() * 0.08);
    const spin = (Math.random() < 0.5 ? -1 : 1) * (120 + Math.random() * 240);
    const flutter = 3 + Math.random() * 4;
    const phase = Math.random() * Math.PI * 2;
    piece.animate(Array.from({ length: 61 }, (_, frame) => {
      const progress = frame / 60;
      const time = progress * duration / 1000;
      // Air resistance slows the burst into a drifting fall.
      const drift = (1 - Math.exp(-2 * time)) * Math.sin(time * flutter + phase) * 12;
      const x = velocityX * (1 - Math.exp(-1.15 * time)) / 1.15 + drift;
      const y = fallSpeed * time + (velocityY - fallSpeed) * (1 - Math.exp(-1.7 * time)) / 1.7;
      return {
        transform: `translate3d(${x}px, ${y}px, 0) rotate(${phase * 180 / Math.PI + spin * time}deg) rotateY(${phase * 180 / Math.PI + time * flutter * 50}deg)`,
        opacity: Math.min(1, progress * 40, (1 - progress) * 4),
      };
    }), { duration, delay: (index < 108 ? 0 : 220) + Math.random() * 80, easing: "linear", fill: "both" });
  }
  window.setTimeout(() => {
    layer.remove();
    if (confettiLayer === layer) confettiLayer = null;
  }, 5900);
}

function syncAccount() {
  const next = state.isAuthenticated ? state.currentUser?.id : null;
  if (accountKey === next) return;
  accountKey = next;
  state.recordingHistoryStatus = "loading";
  state.uploadedRecordingSeconds = null;
  savingRecording = false;
  state.onboardingWelcomePending = false;
  state.onboardingIntroStep = null;
  storageKey = next ? `loggy3-first-recording:${next}` : null;
  if (!storageKey) {
    firstRecordingStartedAt = null;
    return;
  }
  const saved = localStorage.getItem(storageKey);
  const intro = localStorage.getItem(`loggy3-intro:${next}`);
  if (!saved && intro !== "complete") {
    const step = Number(intro);
    // The welcome intro in onboarding-intro.js has four pages.
    state.onboardingIntroStep = Number.isInteger(step) && step >= 0 && step < 4 ? step : 0;
  }
  state.firstRecordingPending = saved !== "complete";
  state.onboardingWelcomePending = saved === "welcome";
  firstRecordingStartedAt = saved && saved !== "complete" && saved !== "welcome" ? Number(saved) : null;
}

export function setOnboardingIntroStep(step) {
  state.onboardingIntroStep = step;
  localStorage.setItem(`loggy3-intro:${state.currentUser.id}`, step === null ? "complete" : String(step));
}

function completeFirstRecording() {
  localStorage.setItem(storageKey, "complete");
  state.firstRecordingPending = false;
  state.onboardingWelcomePending = false;
  setChosenView(null);
  updateLayout();
}

function hasFirstRecording() {
  // Legacy shared recordings cannot establish this account's progress.
  return firstRecordingStartedAt !== null && state.lastSessions.some(
    (session) => session.owned_by_current_user
      && Date.parse(session.ended_at) >= firstRecordingStartedAt,
  );
}

function animateScreen(view, onboarding) {
  const targets = {
    intro: '.onboarding-intro-card',
    auth: "#auth-section .auth-card", legal: "#legal-content", agreement: ".agreement-card",
    "agreement-review": ".agreement-card", "recording-consent": ".recording-consent-card",
    identity: "#identity-card", "referral-code": "#referral-code-section .auth-card", permissions: "#permissions-section",
    sessions: onboarding
      ? (state.onboardingWelcomePending ? "#onboarding-welcome-card"
        : get("onboarding-history-card").hidden ? "#onboarding-first-card" : "#onboarding-history-card")
      : "#sessions-section",
  };
  const target = targets[view] && document.querySelector(targets[view]);
  if (!target || !target.getClientRects().length) return;
  const detail = view === "auth"
    ? (!get("auth-completing").hidden ? "completing" : get("auth-code-step").hidden ? "email" : "code")
    : view === "legal" ? state.currentLegalPage
      : view === "identity" ? state.identityStatus
        : view === "permissions" ? JSON.stringify(state.permissionStatus)
          : view === "sessions" && onboarding
            ? `${state.onboardingWelcomePending}:${state.recordingHistoryStatus}:${get("onboarding-record-step-title").textContent}:${get("onboarding-upload-step-title").textContent}` : "";
  const key = `${onboarding}:${view}:${detail}`;
  if (previousScreen?.key === key) {
    if (screenAnimation?.playState !== "running") previousScreen.height = target.offsetHeight;
    return;
  }
  const previous = previousScreen;
  const sameCard = previous?.target === target;
  const interrupted = sameCard && screenAnimation?.playState === "running";
  const height = interrupted ? target.getBoundingClientRect().height : previous?.height;
  const opacity = interrupted ? Number(getComputedStyle(target).opacity) : 1;
  screenAnimation?.cancel();
  previousScreen = { key, target, view, onboarding, height: target.offsetHeight };
  if (!previous || (!onboarding && !previous.onboarding
      && !(previous.view === "auth" && view === "legal"))) return;
  const timing = { duration: 380, easing: "cubic-bezier(.25,.1,.25,1)" };
  if (previous.view === "intro" && view === "legal") {
    const frames = [{ opacity: 0 }, { opacity: 1 }];
    const entryTiming = { duration: 300, easing: "ease-out" };
    screenAnimation = document.querySelector(".app-shell").animate(frames, entryTiming);
    state.tosControls.closest(".bottom-bar").animate(frames, entryTiming);
    return;
  }
  if (sameCard) {
    if (Math.abs(height - target.offsetHeight) < 1 && opacity === 1) return;
    screenAnimation = target.animate([
      { height: `${height}px`, opacity, overflow: "clip" },
      { height: `${target.offsetHeight}px`, opacity: 1, overflow: "clip" },
    ], timing);
  } else {
    screenAnimation = target.animate([
      { opacity: 0, transform: "translateY(3px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], timing);
  }
}

function renderFirstRecording() {
  const recording = state.wantsToRecord || state.resumePending || state.recorderPhase === "recording";
  if (state.recorderPhase === "stopping") savingRecording = true;
  const stopping = state.recorderPhase === "stopping" || (savingRecording && !hasFirstRecording());
  const hasSession = hasFirstRecording();
  const intro = !recording && !stopping && !hasSession;
  const currentStep = recording || stopping ? 1 : hasSession ? 2 : 0;
  get("onboarding-recording-steps").querySelectorAll("li").forEach((row, index) => {
    const progress = intro ? "intro" : index < currentStep ? "complete" : index === currentStep ? "active" : "pending";
    row.dataset.progress = progress;
    row.setAttribute("aria-current", progress === "active" ? "step" : "false");
    row.querySelector(".onboarding-recording-marker").textContent = progress === "complete" ? "✓" : String(index + 1);
  });
  let title = "Start your first recording";
  let recordTitle = "Record it";
  let recordCopy = "Click Start below, then Stop when you’re done.";
  let uploadTitle = "Upload automatically";
  let uploadCopy = `${recordingAppName} saves and uploads your recording.`;
  if (recording || stopping) {
    title = "Your first recording";
    recordTitle = stopping ? "Saving your recording…" : state.isIdle ? "Recording paused" : "Recording in progress";
    recordCopy = stopping ? "Your recording will be ready shortly."
      : state.isIdle ? "Recording resumes automatically when you return." : "Continue your task, then click Stop below.";
    uploadTitle = "Automatic upload";
    uploadCopy = "Your recording saves and uploads when you stop.";
  } else if (hasSession) {
    title = "Your first recording is saved";
    recordTitle = "Recording saved";
    recordCopy = "Your recording has finished.";
    uploadTitle = "Uploading";
    uploadCopy = "Uploads run in the background, so you can continue.";
  }
  for (const [id, text] of [
    ["onboarding-first-title", title], ["onboarding-record-step-title", recordTitle],
    ["onboarding-record-step-copy", recordCopy], ["onboarding-upload-step-title", uploadTitle],
    ["onboarding-upload-step-copy", uploadCopy],
  ]) {
    if (get(id).textContent !== text) get(id).textContent = text;
  }
  const saved = hasSession && !recording && !stopping;
  get("onboarding-finish").hidden = !saved;
  return saved;
}

function render() {
  syncAccount();
  if (state.onboardingTransitionPending) return;
  if (state.isAuthenticated && !state.accountBanned && !state.logoutInFlight
      && state.onboardingIntroStep !== null
      && (state.tosAcceptedThisRun || (currentView === "legal"
        && (state.recordingHistoryStatus === "error" || state.localSessionsStatus === "error")))) {
    setOnboardingIntroStep(null);
  }
  const recordingInProgress = recorderNeedsControl() || state.recorderPhase === "recording" || savingRecording;
  const ownedSessions = state.lastSessions.filter((session) => session.owned_by_current_user);
  const recordedBeforeAttempt = firstRecordingStartedAt !== null && ownedSessions.some(
    (session) => Date.parse(session.ended_at) < firstRecordingStartedAt,
  );
  const resumableAttempt = firstRecordingStartedAt !== null && !recordedBeforeAttempt
    && (recordingInProgress || state.localSessionsStatus !== "ready" || hasFirstRecording());
  if (guidedOnboardingPending() && !state.onboardingWelcomePending && !resumableAttempt
      && (state.uploadedRecordingSeconds > 0 || ownedSessions.length > 0)) {
    completeFirstRecording();
    return;
  }
  const onboarding = !state.accountBanned && guidedOnboardingPending();
  const view = currentView;
  const welcome = onboarding && state.onboardingWelcomePending;
  if (!welcome || view !== "sessions") {
    confettiLayer?.remove();
    confettiLayer = null;
  }
  const saved = onboarding && (welcome || renderFirstRecording());
  const checkingHistory = onboarding
    && (state.recordingHistoryStatus !== "ready" || state.localSessionsStatus !== "ready")
    && !recorderNeedsControl() && !saved;
  if (onboarding && view === "sessions" && !checkingHistory) trackOnboardingView(view);
  const stage = view === "auth" ? 0
    : ["legal", "referral-code", "agreement", "agreement-review", "recording-consent"].includes(view) ? 1
      : view === "identity" ? 2 : view === "permissions" ? 3 : 4;
  document.body.classList.toggle("onboarding-active", onboarding);
  document.body.classList.toggle("onboarding-first", onboarding && view === "sessions");
  document.body.classList.toggle("onboarding-permissions", onboarding && view === "permissions");
  get("onboarding-bar").hidden = !onboarding;
  get("onboarding-steps").hidden = !onboarding;
  get("onboarding-first-card").hidden = !onboarding || checkingHistory || welcome;
  const showStartTip = onboarding && view === "sessions" && !checkingHistory && !welcome && !saved && !recordingInProgress;
  get("onboarding-start-tip").hidden = !showStartTip;
  if (showStartTip) get("record-btn").setAttribute("aria-describedby", "onboarding-start-tip");
  else get("record-btn").removeAttribute("aria-describedby");
  get("onboarding-welcome-card").hidden = !welcome;
  get("onboarding-history-card").hidden = !checkingHistory;
  const historyFailed = state.recordingHistoryStatus === "error" || state.localSessionsStatus === "error";
  get("onboarding-history-spinner").hidden = historyFailed;
  get("onboarding-history-title").textContent = historyFailed
    ? "Couldn’t check your recordings" : "Checking your recordings…";
  get("onboarding-history-copy").textContent = historyFailed
    ? "Try again to continue." : "Looking for previous recordings on your account.";
  get("onboarding-history-retry").hidden = !historyFailed;
  const logoutParent = onboarding ? get("onboarding-signout-slot") : logoutHome;
  if (get("logout-btn").parentElement !== logoutParent) logoutParent.append(get("logout-btn"));
  get("onboarding-signout-slot").hidden = !onboarding;
  const substep = view === "legal" ? (state.currentLegalPage === "privacy" ? "Privacy notice" : "Terms & conditions")
    : view === "referral-code" ? "Referral code"
      : view === "agreement" ? "Contributor agreement" : view === "recording-consent" ? "Recording consent" : null;
  get("onboarding-stage").textContent = welcome && view === "sessions" ? "Setup complete"
    : checkingHistory && view === "sessions" ? "Recording history"
      : `Step ${stageOrder.indexOf(stage) + 1} of ${stageOrder.length} · ${stages[stage]}${substep ? " · " + substep : ""}`;
  const done = [state.isAuthenticated, legalGatesSatisfied(), identityAllowsAccess(),
    !!state.permissionStatus?.all_granted, !state.firstRecordingPending || saved];
  get("onboarding-steps").querySelectorAll("[data-step]").forEach((item, index) => {
    const visibleIndex = stageOrder.indexOf(index);
    item.hidden = visibleIndex === -1;
    item.classList.toggle("active", index === stage);
    item.setAttribute("aria-current", index === stage ? "step" : "false");
    item.setAttribute("aria-disabled", String(index > stage && !done[index]));
    item.querySelector(".sidebar-icon").textContent = done[index] ? "✓" : String(visibleIndex + 1);
  });
  const permissions = state.permissionStatus;
  if (permissions) {
    const values = [permissions.screen_recording, permissions.input_monitoring];
    get("onboarding-permission-summary").textContent = `${values.filter(Boolean).length} of ${values.length} permissions granted. Nothing records until you press Start.`;
  }
  if (onboarding && view === "sessions" && (saved || checkingHistory)) {
    state.transportControls.style.display = "none";
    state.transportControls.closest(".bottom-bar").style.display = "none";
  }
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  if (previousScreen?.view === "intro" && view === "legal") {
    animationFrame = null;
    animateScreen(view, onboarding);
    return;
  }
  animationFrame = requestAnimationFrame(() => {
    animationFrame = null;
    animateScreen(view, onboarding);
  });
}

export function initOnboarding(appName) {
  recordingAppName = appName === "Recorder" ? "Recorder" : "Loggy";
  logoutHome = get("logout-btn").parentElement;
  get("onboarding-history-retry").addEventListener("click", () => {
    void refreshSessions();
    void refreshUploadedHistory();
  });
  get("onboarding-finish").addEventListener("click", () => {
    if (guidedOnboardingPending() && legalGatesSatisfied() && identityAllowsAccess()
        && state.permissionsOk && !recorderNeedsControl() && hasFirstRecording()) {
      localStorage.setItem(storageKey, "welcome");
      state.onboardingWelcomePending = true;
      updateLayout();
      requestAnimationFrame(celebrateWelcome);
    }
  });
  get("onboarding-welcome-finish").addEventListener("click", () => {
    if (guidedOnboardingPending() && state.onboardingWelcomePending && legalGatesSatisfied()
        && identityAllowsAccess() && state.permissionsOk && !recorderNeedsControl()) {
      completeFirstRecording();
    }
  });
  window.addEventListener("loggy3-layout-changed", (event) => {
    currentView = event.detail.view;
    render();
  });
  window.addEventListener("loggy3-account-access-changed", () => {
    syncAccount();
    updateLayout();
  });
  window.addEventListener("loggy3-sessions-changed", () => {
    syncAccount();
    if (["stopped", "failed"].includes(state.recorderPhase)
        && !recorderNeedsControl() && state.localSessionsStatus === "ready") {
      savingRecording = false;
    }
    if (guidedOnboardingPending()) updateLayout();
  });
  window.addEventListener("loggy3-recording-started", (event) => {
    syncAccount();
    if (event.detail.userId === accountKey && storageKey && guidedOnboardingPending()
        && firstRecordingStartedAt === null) {
      firstRecordingStartedAt = Math.floor(event.detail.startedAt / 1000) * 1000;
      localStorage.setItem(storageKey, String(firstRecordingStartedAt));
    }
  });
  window.addEventListener("loggy3-uploaded-history-changed", (event) => {
    syncAccount();
    if (event.detail.accountKey !== accountKey) return;
    if (event.detail.status === "ready" || state.recordingHistoryStatus !== "ready") {
      state.recordingHistoryStatus = event.detail.status;
    }
    if (event.detail.status === "ready") state.uploadedRecordingSeconds = event.detail.totalSeconds;
    updateLayout();
  });
  window.addEventListener("loggy3-auth-screen-changed", render);
  render();
}
