// Shared mutable UI state, as one exported object so every module reads and writes the
// same bindings (ES modules forbid assigning to an imported `let`, so bare shared
// variables cannot be split across files). State used by only one module stays a
// module-local `let` in that module; only what crosses module boundaries lives here.
export const state = {
  appName: null,
  buildChannel: null,
  wantsToRecord: false, // User intent (Start/Stop button) / backend wants_to_record
  isIdle: false, // Backend idle-pause state (paused_for_idle)
  recorderPhase: "stopped",
  updateInstalling: false,
  resumePending: false,
  recorderStatusGeneration: 0,
  recordingCommandInFlight: false,
  recordingControlBusyCount: 0,
  authTransitionBusyCount: 0,
  logoutInFlight: false,
  replayCheckBusy: false,
  replayCheckNeedsControl: false,
  isAuthenticated: false,
  // Signed-in users must accept the current legal documents before onboarding continues.
  legalAcceptancePending: false,
  // The account accepted an earlier version of the documents now being shown.
  legalDocumentsUpdated: false,
  // The current Terms and Privacy Notice couldn't be loaded; retrying.
  legalDocumentsUnavailable: false,
  // Why, when it wasn't the network: the server's message.
  legalDocumentsError: "",
  currentUser: null,
  currentTokenId: null,
  accountBanned: false,
  agreementSatisfied: false,
  agreementChecking: false,
  identityChecking: false,
  permissionsChecking: false,
  onboardingTransitionPending: false,
  recordingHistoryStatus: null,
  uploadedRecordingSeconds: null,
  localSessionsStatus: null,
  selfServeUser: false,
  recordingConsentPending: false,
  firstRecordingPending: true,
  onboardingWelcomePending: false,
  onboardingIntroStep: null,
  permissionStatus: null,
  // The referral program as the server reports it for this account (null when it's off or
  // not loaded), whether it has loaded for this account ("loading", "ready", or "error" until
  // one load succeeds), and whether the code screen is showing that a code was just applied.
  referrals: null,
  referralsStatus: null,
  referralCodeApplied: false,
  identityStatus: "unknown",
  identityLoading: false,
  identityError: "",
  // Sidebar-selected panel. Null means the default sessions view after onboarding.
  chosenView: null,
  // True after the current Terms and Privacy are accepted for the active app run.
  tosAcceptedThisRun: false,
  // How many times this run has accepted them, so a server answer read before an acceptance and
  // returned after it isn't taken for a version deployed since.
  legalAcceptances: 0,
  selectedSessionName: null,
  lastSessions: [],
  // Permissions gate: assume granted until the backend says otherwise, so the ToS screen
  // doesn't flash on machines that are already set up.
  permissionsOk: true,
  // DEBUG panel: always available, including release builds — the game and the logs are
  // how a field failure gets diagnosed on a machine that has no terminal attached.
  debugPane: "game",
  // Track which legal page is currently displayed to ensure proper toggling
  currentLegalPage: "terms",

  // DOM element references, assigned once in main.js's DOMContentLoaded handler.
  recordBtn: null,
  recordText: null,
  recordIcon: null,
  statusIndicator: null,
  statusText: null,
  elapsedTimerEl: null,
  logoutBtn: null,
  sessionsSection: null,
  faqSection: null,
  tabFaq: null,
  replayCheckSection: null,
  sessionsList: null,
  legalContent: null,
  tabTerms: null,
  tabPrivacy: null,
  tabContributorAgreement: null,
  acceptLegalBtn: null,
  termsAcceptControl: null,
  termsAcceptCheckbox: null,
  privacyAcceptControl: null,
  privacyAcceptCheckbox: null,
  transportControls: null,
  sessionRate: null,
  tosControls: null,
  mainTitle: null,
  banScreen: null,
  permissionsSection: null,
  authSection: null,
  identitySection: null,
  agreementSection: null,
  recordingConsentSection: null,
  referralCodeSection: null,
  referralsSection: null,
  tabReferrals: null,
  tabPermissions: null,
};

export function identityAllowsAccess(status = state.identityStatus) {
  return status === "approved" || status === "exempt";
}

export function guidedOnboardingPending() {
  return state.isAuthenticated && state.selfServeUser && state.firstRecordingPending;
}

export function onboardingIntroPending() {
  return guidedOnboardingPending() && !state.accountBanned
    && state.legalAcceptancePending && !state.tosAcceptedThisRun
    && state.onboardingIntroStep !== null && !state.onboardingWelcomePending
    && state.recordingHistoryStatus === "ready" && state.localSessionsStatus === "ready"
    && state.uploadedRecordingSeconds === 0
    && !state.lastSessions.some((session) => session.owned_by_current_user)
    && !recorderNeedsControl() && state.recorderPhase !== "recording" && !state.replayCheckNeedsControl;
}

export function legalGatesSatisfied() {
  return state.tosAcceptedThisRun
    && state.agreementSatisfied
    && !state.recordingConsentPending;
}

export function identityStatusIsTerminal(status = state.identityStatus) {
  return identityAllowsAccess(status) || status === "declined";
}

// Onboarding asks for a referral code while the server says this account still can enter one
// and this computer has no recording of it: the server only learns of a recording once its
// upload starts. The screen stays up after Apply to say the code was applied.
export function referralCodePending() {
  if (!state.isAuthenticated || !state.selfServeUser || state.accountBanned) return false;
  if (state.referralCodeApplied) return true;
  return state.referrals?.code_screen === true && state.localSessionsStatus === "ready"
    && !state.lastSessions.some((session) => session.owned_by_current_user)
    && !recorderNeedsControl() && state.recorderPhase !== "recording";
}

// Whether onboarding must wait to learn if the code screen applies: it comes right after the Terms,
// so a new self-serve account holds there until the server answers rather than show the agreement
// and then replace it. A failed load lets onboarding go on without the screen.
export function referralCodeUnknown() {
  return state.isAuthenticated && state.selfServeUser && !state.accountBanned && !state.agreementSatisfied
    && state.referralsStatus === "loading" && !state.lastSessions.some((session) => session.owned_by_current_user);
}

// The Referrals tab is for accounts an operator turned on. A turned-off code keeps the tab while
// a friend can still earn the bonus.
export function referralsAvailable() {
  const referrer = state.referrals?.referrer;
  return state.isAuthenticated && state.selfServeUser && !!referrer
    && (referrer.active || referrer.friends.some((friend) => friend.status === "open" && friend.eligible));
}

export function recorderNeedsControl() {
  return state.wantsToRecord
    || state.recorderPhase === "stopping"
    || state.resumePending;
}
