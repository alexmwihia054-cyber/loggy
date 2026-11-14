// Account recording history: activity and daily sessions across all computers.
// Pending recordings on this computer can also be deleted.

import { recorderNeedsControl, state } from "./state.js";
import { invoke } from "./tauri.js";
import { refreshUploadedHistory } from "./uploaded-history.js";
import { trackSessionsDisplay } from "./sessions-telemetry.js";
import { reportUiError, showErrorBanner } from "./errors.js";
import { getDeleteIcon, getPendingUploadIcon } from "./icons.js";
import { formatDuration, formatSessionTime } from "./format.js";
import { currentRateTier, formatRateAmount, paysLike, rateKey, rateTierAt, textElement } from "./rates.js";

const SESSION_ROW_HEIGHT = 34;
const SESSION_OVERSCAN = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
// Self-serve contributors are paid for up to 10 hours per UTC day (stated in the welcome email)
// at the rate tier in effect when each recording started (the current one is beside Start).
// Each recording is paid in the pay period its upload completed in: the 1st through the 14th, or
// the 15th to the end of the month, in UTC.
const SELF_SERVE_DAILY_CAP_SECONDS = 10 * 3600;
const SELF_SERVE_CAP_HOURS = SELF_SERVE_DAILY_CAP_SECONDS / 3600;
const payoutFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const get = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let sessionsRevision = null;
let sessionsRenderVersion = 0;
let lastRenderKey = null;
let initialized = false;
let scrollRenderPending = false;
let groupedRevision = -1;
let sessionsByDay = new Map();
let secondsByDay = new Map();
let otherSecondsByDay = new Map();
let unpaidSecondsByDay = new Map();
let uploadEarnings = { unpaid: new Map(), unpaidByPayDay: new Map(), earned: new Map() };
let uploadSpans = [];
let pendingUploads = [];
let uploadStatuses = new Map();
let uploadTooltip = null;
let uploadTooltipFor = null;
let uploadTooltipIcon = null;
let dismissedUploadIcon = null;
// Each uploading recording's part count at recent refreshes, for its time left.
const uploadSamples = new Map();
// The tooltip's progress bar, percentage and part count outlive redraws, so they can ease to new
// progress.
let uploadProgressBar = null;
let uploadProgressPercent = null;
let uploadProgressParts = null;
let uploadProgressShown = null;
let uploadProgressFrame = 0;
let groupedBasis = null;
let groupedDamaged = null;
let uploadedSessions = { userId: null, since: null, earliestSessionAt: null, sessions: [], rateHistory: [] };
let uploadedHistoryStatus = "loading";
let rangeMode = defaultRangeMode();
let selectedDay = dayOf(new Date());
let rangeEnd = rangeEndFor(rangeMode, selectedDay);
let renderedDay = null;
let renderedToday = null;
let renderedRange = null;
let renderedRangeMode = null;
let chartRenderKey = null;
let displayedSnapshot = null;
let dayButtons = [];
let outgoingChart = null;
let rangeWidthAnimation = null;
let renderedRows = new Map();
let focusedSessionLookup = null;
let renderedTimeZone = null;
let historyUserId = null;
let historyTokenId = null;
let sessionsRequestGeneration = 0;
let sessionsRefreshRequest = null;
const pendingSessionDeletes = new Set();
let knownSessionNames = null;
let addedSessionNames = new Set();
let renderedRowsVersion = -1;

function resetSessionHistory() {
  sessionsRequestGeneration += 1;
  sessionsRefreshRequest = null;
  pendingSessionDeletes.clear();
  sessionsRevision = null;
  displayedSnapshot = null;
  uploadedHistoryStatus = "loading";
  knownSessionNames = null;
  addedSessionNames.clear();
  sessionsRenderVersion += 1;
  state.lastSessions = [];
  state.localSessionsStatus = "loading";
  state.selectedSessionName = null;
  uploadStatuses = new Map();
  uploadSamples.clear();
  uploadProgressShown = null;
  hideUploadTooltip();
  rangeMode = defaultRangeMode();
  selectedDay = dayOf(new Date());
  rangeEnd = rangeEndFor(rangeMode, selectedDay);
  renderedDay = null;
  renderedToday = null;
  renderedRange = null;
  renderedRangeMode = null;
  if (initialized) get("sessions-scroll").scrollTop = 0;
  renderSessions(state.lastSessions);
}

function syncHistoryAccount() {
  const userId = state.isAuthenticated ? state.currentUser?.id : null;
  const tokenId = state.isAuthenticated ? state.currentTokenId : null;
  if (userId === historyUserId && tokenId === historyTokenId) return false;
  historyUserId = userId;
  historyTokenId = tokenId;
  resetSessionHistory();
  return true;
}

window.addEventListener("loggy3-account-access-changed", () => {
  if (syncHistoryAccount() && state.isAuthenticated) void refreshSessions();
});

// Uploads arrive only for the signed-in account; tag them with it so a later account switch
// drops them before regrouping.
window.addEventListener("loggy3-uploaded-history-changed", (event) => {
  if (!state.isAuthenticated || event.detail.accountKey !== state.currentUser?.id) return;
  uploadedHistoryStatus = event.detail.status;
  if (uploadedHistoryStatus === "ready") {
    uploadedSessions = {
      userId: state.currentUser.id,
      since: event.detail.since,
      earliestSessionAt: event.detail.earliestSessionAt,
      sessions: event.detail.sessions || [],
      rateHistory: event.detail.rateHistory || [],
    };
    sessionsRenderVersion += 1;
  }
  renderSessions(state.lastSessions);
});

function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function utcDay(date) {
  const time = date.getTime();
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "";
}

// Self-serve accounts are paid by UTC day, so their chart groups recordings by UTC day; other
// accounts see their own days.
function dayOf(date) {
  return state.selfServeUser ? utcDay(date) : localDay(date);
}

function dayDate(day) {
  return new Date(`${day}T12:00:00`);
}

function shiftDay(day, offset) {
  const date = dayDate(day);
  date.setDate(date.getDate() + offset);
  return localDay(date);
}

function weekEnd(day) {
  return shiftDay(day, (7 - dayDate(day).getDay()) % 7);
}

function monthEnd(day, offset = 0) {
  const date = dayDate(day);
  return localDay(new Date(date.getFullYear(), date.getMonth() + offset + 1, 0));
}

function periodStart(day) {
  return `${day.slice(0, 8)}${Number(day.slice(8)) <= 14 ? "01" : "15"}`;
}

function periodEnd(day) {
  return Number(day.slice(8)) <= 14 ? `${day.slice(0, 8)}14` : monthEnd(day);
}

// Self-serve accounts see the pay periods they're paid for where others see weeks.
function defaultRangeMode() {
  return state.selfServeUser ? "period" : "week";
}

function rangeEndFor(mode, day) {
  return mode === "month" ? monthEnd(day) : mode === "period" ? periodEnd(day) : weekEnd(day);
}

function daySeconds(day) {
  return secondsByDay.get(day) || 0;
}

function otherDaySeconds(day) {
  return otherSecondsByDay.get(day) || 0;
}

function shortDuration(seconds) {
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m`;
}

// Only uploads are paid. The cap counts UTC days of recording, and each day's is used up in the
// order uploads completed (then recordings started), across every computer: an upload that
// arrives late gets what is left of its day and never changes what earlier uploads were paid.
// Spans are { day, start (epoch ms), seconds, rate, uploadedAt (epoch ms) }; a recording still on
// this computer has uploadedAt Infinity, so it takes what is left of its days on the chart but no
// range pays it yet. Unpaid time is credited to `day`, the chart day its session started on, so
// it lines up with the bars, and also kept per UTC day of upload; paid time is kept per UTC day of
// upload and rate (null before the account had one) as { rate, seconds, cents }, cents unrounded.
export function capByUploadOrder(spans) {
  const pieces = [];
  for (const { day, start, seconds, rate, uploadedAt } of spans) {
    const end = start + seconds * 1000;
    if (!Number.isFinite(end) || !(Number.isFinite(uploadedAt) || uploadedAt === Infinity)) continue;
    const payDay = uploadedAt === Infinity ? null : utcDay(new Date(uploadedAt));
    for (let from = start; from < end;) {
      const recordedDay = Math.floor(from / DAY_MS);
      const to = Math.min(end, (recordedDay + 1) * DAY_MS);
      pieces.push({ day, payDay, recordedDay, uploadedAt, start, from, ms: to - from, rate });
      from = to;
    }
  }
  pieces.sort((a, b) => a.uploadedAt - b.uploadedAt || a.start - b.start || a.from - b.from);
  const paidMs = new Map();
  const unpaid = new Map();
  const unpaidByPayDay = new Map();
  const earned = new Map();
  for (const { day, payDay, recordedDay, ms, rate } of pieces) {
    const used = paidMs.get(recordedDay) || 0;
    const paid = Math.min(ms, Math.max(0, SELF_SERVE_DAILY_CAP_SECONDS * 1000 - used));
    paidMs.set(recordedDay, used + paid);
    if (paid < ms) {
      unpaid.set(day, (unpaid.get(day) || 0) + (ms - paid) / 1000);
      if (payDay) unpaidByPayDay.set(payDay, (unpaidByPayDay.get(payDay) || 0) + (ms - paid) / 1000);
    }
    if (!paid || !payDay) continue;
    if (!earned.has(payDay)) earned.set(payDay, new Map());
    const key = rateKey(rate);
    const sofar = earned.get(payDay).get(key) || { seconds: 0, cents: 0 };
    // Pieces run in upload order, so a renamed tier ends up with its latest name.
    earned.get(payDay).set(key, { rate, seconds: sofar.seconds + paid / 1000,
      cents: sofar.cents + (rate ? paid * rate.hourly_rate_cents / 3600000 : 0) });
  }
  return { unpaid, unpaidByPayDay, earned };
}

// What a range pays: the uploads that completed in it, UTC days `from` through `to`, per rate,
// plus their time above the cap.
export function rangeEarnings({ earned, unpaidByPayDay }, from, to) {
  const inRange = (payDay) => payDay >= from && payDay <= to;
  const byRate = new Map();
  for (const [payDay, entries] of earned) {
    if (!inRange(payDay)) continue;
    for (const [key, entry] of entries) {
      const sofar = byRate.get(key) || { seconds: 0, cents: 0 };
      // Later uploads carry a renamed tier's name.
      byRate.set(key, { rate: entry.rate, seconds: sofar.seconds + entry.seconds, cents: sofar.cents + entry.cents });
    }
  }
  const unpaidSeconds = [...unpaidByPayDay].reduce((sum, [payDay, seconds]) => (inRange(payDay) ? sum + seconds : sum), 0);
  const paidSeconds = [...byRate.values()].reduce((sum, { seconds }) => sum + seconds, 0);
  // To the millisecond, so summed pieces of an exact total don't show a minute short.
  const ms = (seconds) => Math.round(seconds * 1000) / 1000;
  return { earned: byRate, unpaidSeconds: ms(unpaidSeconds), totalSeconds: ms(paidSeconds + unpaidSeconds) };
}

// Rounds each part down, then gives what is left of `total` to the largest remainders, so the
// rounded parts add up to it.
function apportion(parts, total) {
  const rounded = parts.map(Math.floor);
  let left = total - rounded.reduce((sum, part) => sum + part, 0);
  const byRemainder = parts.map((_, index) => index).sort((a, b) => parts[b] % 1 - parts[a] % 1);
  for (const index of byRemainder) {
    if (left <= 0) break;
    rounded[index] += 1;
    left -= 1;
  }
  return rounded;
}

// The estimate's rows: the current rate (always), earlier rates most recent first, time before
// any rate, and time above the cap, apportioned so they add up to the hourly pay, then referral
// bonuses: those in dollars as one row, and those in hours of pay one row per hourly rate.
export function payoutRows({ current, history, earned, unpaidSeconds, totalSeconds, payoutCents, bonuses = [] }) {
  const currentKey = rateKey(current);
  const held = (history || []).map(rateKey);
  const earlier = [...earned].filter(([key]) => key !== currentKey && key !== "")
    .sort(([a], [b]) => held.lastIndexOf(b) - held.lastIndexOf(a))
    .map(([, entry]) => ({ kind: "previous", ...entry }));
  const rows = [
    { kind: "current", seconds: 0, cents: 0, ...earned.get(currentKey), rate: current },
    ...earlier,
    { kind: "unrated", rate: null, seconds: earned.get("")?.seconds || 0, cents: 0 },
    { kind: "unpaid", rate: null, seconds: unpaidSeconds, cents: 0 },
  ];
  const minutes = apportion(rows.map((row) => row.seconds / 60), Math.floor(totalSeconds / 60));
  const cents = apportion(rows.map((row) => row.cents), payoutCents);
  const referral = new Map();
  for (const { cents: amount, hours, hourly_rate_cents: hourlyRateCents = null } of bonuses) {
    const row = referral.get(hourlyRateCents)
      ?? { kind: "referral", rate: null, minutes: 0, cents: 0, hours: 0, hourlyRateCents };
    row.cents += amount;
    row.hours += hours ?? 0;
    referral.set(hourlyRateCents, row);
  }
  return [...rows.map(({ kind, rate }, index) => ({ kind, rate, minutes: minutes[index], cents: cents[index] })),
    ...referral.values()]
    .filter((row) => row.kind === "current" || row.minutes > 0 || row.cents > 0);
}

// The estimate tooltip's rows, as displayed, for the display snapshot (docs/telemetry-storage.md): a referral row
// adds its hours of pay and the rate they were priced at.
export function rateBreakdown(rows) {
  return rows.map(({ kind, rate, minutes, cents, hours, hourlyRateCents }) => ({
    kind, rate_tier: rate?.tier ?? null, hourly_rate_cents: rate?.hourly_rate_cents ?? hourlyRateCents ?? null, minutes, cents,
    ...(kind === "referral" ? { hours } : {}),
  }));
}

// The earliest day the estimate pages back to: the first recording day given, or the pay day of a referral bonus,
// which can come before a referrer's own first recording.
export function earliestDay(days, bonuses = []) {
  return [...days, ...(bonuses || []).map(({ reached_at: reachedAt }) => utcDay(new Date(reachedAt)))]
    .reduce((min, day) => (day < min ? day : min));
}

const PAYOUT_ROW_LABELS = {
  current: "Current rate",
  previous: "Previous rate",
  unrated: "Before your rate started",
  unpaid: "Above the daily limit",
  referral: "Referral bonus",
};

// The tooltip on "est. payout": what each rate paid in the period, so a total that mixes an
// earlier rate with the current one still adds up, then what isn't counted yet.
function renderPayoutTooltip(rows, { pending, damaged, recordedBefore, uploadedAfter, unit }) {
  const list = textElement("ul", "sessions-payout-rates", "");
  list.append(...rows.map(({ kind, rate, minutes, cents, hours, hourlyRateCents }) => {
    const row = textElement("li", `sessions-payout-${kind}`, "");
    const time = kind === "referral" ? (hours ? `${hours} h × ${formatRateAmount(hourlyRateCents)}` : "")
      : rate ? `${shortDuration(minutes * 60)} × ${formatRateAmount(rate.hourly_rate_cents)}` : shortDuration(minutes * 60);
    row.append(textElement("span", "sessions-payout-tier", rate ? rate.name : PAYOUT_ROW_LABELS[kind]));
    if (rate) row.append(textElement("span", "sessions-payout-kind", PAYOUT_ROW_LABELS[kind]));
    row.append(textElement("span", "sessions-payout-time", time),
      textElement("span", "sessions-payout-earned", formatRateAmount(cents)));
    return row;
  }));
  const addUncounted = ({ count, seconds }, className, label) => {
    if (!count) return;
    const row = textElement("li", className, "");
    row.append(textElement("span", "sessions-payout-tier", label), textElement("span", "sessions-payout-time", shortDuration(seconds)),
      textElement("span", "sessions-payout-earned", "—"));
    list.append(row);
  };
  addUncounted(pending, "sessions-payout-pending", `${pending.count} ${pending.count === 1 ? "session" : "sessions"} not yet uploaded`);
  addUncounted(damaged, "sessions-payout-pending sessions-payout-damaged", `${damaged.count} can’t upload (damaged ${damaged.count === 1 ? "file" : "files"})`);
  const notes = [`Hours are paid at the rate you had when you recorded them, for up to ${SELF_SERVE_CAP_HOURS} hours per UTC day, in the pay period their upload finishes in.`];
  if (recordedBefore >= 60) notes.push(`Includes ${shortDuration(recordedBefore)} recorded before this ${unit}.`);
  if (uploadedAfter >= 60) notes.push(`${shortDuration(uploadedAfter)} recorded in this ${unit} finished uploading after it and counts toward a later pay period.`);
  get("sessions-payout-tooltip").replaceChildren(
    textElement("strong", "sessions-payout-tooltip-title", "Estimated payout"),
    list,
    textElement("p", "", notes.join(" ")),
  );
}

// When the cap's UTC day starts, in the viewer's own clock.
function capResetTime() {
  return new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS)
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function localTimeZoneName() {
  return new Intl.DateTimeFormat(undefined, { timeZoneName: "longGeneric" })
    .formatToParts(new Date()).find((part) => part.type === "timeZoneName").value;
}

function capExplanation(day, total) {
  const unpaid = unpaidSecondsByDay.get(day) || 0;
  const reset = capResetTime();
  return [
    `${shortDuration(unpaid)} of your ${shortDuration(total)} total is unpaid because it is above the ${SELF_SERVE_CAP_HOURS}-hour paid limit.`,
    `The limit resets at midnight Coordinated Universal Time. In your time zone of ${localTimeZoneName()}, each day runs from ${reset} to ${reset} the next day.`,
    `Hours before ${reset} count toward the previous day's limit.`,
  ].join("\n\n");
}

// What the uploader is doing with each recording still on this computer. Icons change in place,
// so an open tooltip and keyboard focus survive the change.
function applyUploadStatuses(statuses) {
  uploadStatuses = new Map(Object.entries(statuses));
  recordUploadSamples(statuses);
  const byName = new Map((state.lastSessions || []).map((session) => [session.name, session]));
  for (const icon of state.sessionsList?.querySelectorAll(".session-pending") || []) {
    paintUploadIcon(icon, byName.get(icon.closest(".session-item")?.dataset.sessionName));
  }
}

// A file that can never upload.
function uploadDamaged(name) {
  return uploadStatuses.get(name)?.state === "failed";
}

function paintUploadIcon(icon, session) {
  const status = uploadStatuses.get(session?.name);
  icon.className = `session-pending session-upload-${status?.state ?? "unknown"}`;
  icon.setAttribute("aria-label", uploadStatusText(status, session).title);
}

function recordUploadSamples(statuses) {
  const now = Date.now();
  for (const name of uploadSamples.keys()) {
    if (statuses[name]?.state !== "uploading") uploadSamples.delete(name);
  }
  for (const [name, status] of Object.entries(statuses)) {
    if (status.state !== "uploading") continue;
    let samples = uploadSamples.get(name);
    // A new attempt, or one that went backwards, starts over.
    if (!samples || samples.attempt !== status.started_at_ms || status.parts_done < samples.at(-1).parts) {
      samples = Object.assign([], { attempt: status.started_at_ms });
      uploadSamples.set(name, samples);
    }
    samples.push({ at: now, parts: status.parts_done });
    // The last two minutes, so the estimate follows the connection as it changes.
    while (samples.length > 2 && now - samples[0].at > 2 * 60 * 1000) samples.shift();
  }
}

// An upload's time left in ms from its part counts at recent refreshes ({ at, parts }, oldest
// first), or null until they show progress.
export function uploadTimeLeftMs(samples, partsTotal) {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || last.parts <= first.parts) return null;
  return (partsTotal - last.parts) * (last.at - first.at) / (last.parts - first.parts);
}

// "5 min" or "1h 05m", for times read at a glance.
function roughDuration(minutes) {
  return minutes < 60 ? `${minutes} min` : shortDuration(minutes * 60);
}

function formatTimeLeft(ms) {
  const minutes = Math.round(ms / 60000);
  return minutes < 1 ? "Less than a minute left" : `About ${roughDuration(minutes)} left`;
}

const UPLOAD_ERRORS = {
  network: "The last attempt couldn’t reach Loggy’s servers.",
  server: "Loggy’s servers couldn’t accept the last attempt.",
  file_changed: "The file changed during the last attempt.",
  other: "The last attempt didn’t go through.",
};

// A recording's upload status as a title, sentences, and progress (0–1) while uploading.
function uploadStatusText(status, session) {
  const paid = state.selfServeUser;
  switch (status?.state) {
    case "uploading": {
      const progress = status.parts_total ? status.parts_done / status.parts_total : 0;
      const minutes = Math.max(0, Math.floor((Date.now() - status.started_at_ms) / 60000));
      const started = minutes < 1 ? "Just now" : `${roughDuration(minutes)} ago`;
      const left = uploadTimeLeftMs(uploadSamples.get(session?.name) || [], status.parts_total);
      return { title: "Uploading", progress, started,
        timeLeft: left === null ? "Working out the time left" : formatTimeLeft(left),
        lines: [`Keep Loggy open until it finishes.${paid ? " It counts toward your payout once it’s uploaded." : ""}`] };
    }
    case "retrying":
      return { title: "Retrying upload", lines: [
        UPLOAD_ERRORS[status.error] || UPLOAD_ERRORS.other,
        `Loggy tries again automatically${status.attempts > 1 ? ` (${status.attempts} failed attempts so far)` : ""}. Nothing is lost.`,
      ] };
    case "failed":
      return { title: "Can’t upload this recording", lines: [
        "The file is incomplete or damaged, so it won’t upload.",
        `It stays on this computer until you delete it.${paid ? " It won’t count toward your payout." : ""}`,
      ] };
    case "waiting":
      // Fresh off the recorder. A recording that was still going at the uploader's last scan keeps
      // that status until the next one, after any upload in progress. After a minute or so it is
      // waiting on the uploads ahead of it instead.
      if (status.reason === "recently_modified" || status.reason === "active_recording") {
        if (Date.now() - Date.parse(session?.ended_at) < 90 * 1000) {
          return { title: "Getting ready", lines: ["Just finished recording. It joins the upload queue in about a minute."] };
        }
        break;
      }
      if (status.reason === "update_required") {
        return { title: "Update needed", lines: ["This version of Loggy3 can no longer upload. Uploads resume after the app updates."] };
      }
      if (status.reason === "upload_paused") {
        return { title: "Uploads paused", lines: ["Paused while Loggy confirms your account. Uploads resume on their own."] };
      }
      if (status.reason === "recording_locked") {
        return { title: "Waiting to upload", lines: ["The recorder is still finishing with this file. Uploading starts once it’s done."] };
      }
      return { title: "Waiting to upload", lines: ["Loggy will try this file again in a moment."] };
  }
  return { title: "Waiting to upload", lines: ["This recording uploads automatically in the background. Keep Loggy open until it finishes."] };
}

function showUploadTooltip(name) {
  const icon = state.sessionsList?.querySelector(`.session-item[data-session-name="${CSS.escape(name)}"] .session-pending`);
  const session = (state.lastSessions || []).find((candidate) => candidate.name === name);
  const anchor = icon?.getBoundingClientRect();
  const list = get("sessions-scroll").getBoundingClientRect();
  // A redrawn, hidden or scrolled-away row gets no leave event, so close once the icon is out of
  // the list's view or the pointer and focus have moved on.
  if (!uploadTooltip || !icon || !session || !anchor.height || anchor.bottom <= list.top || anchor.top >= list.bottom
    || (uploadTooltipFor === name && !icon.matches(":hover, :focus"))) {
    hideUploadTooltip();
    return;
  }
  uploadTooltipFor = name;
  // Only the icon showing the tooltip points to it, so a screen reader never reads one row's
  // details on another.
  if (uploadTooltipIcon !== icon) {
    uploadTooltipIcon?.removeAttribute("aria-describedby");
    uploadTooltipIcon = icon;
    icon.setAttribute("aria-describedby", uploadTooltip.id);
  }
  const status = uploadStatuses.get(name);
  const { title, lines, progress, timeLeft, started } = uploadStatusText(status, session);
  const children = [];
  if (progress === undefined) {
    children.push(textElement("strong", "", title));
  } else {
    // Uploading: the percentage beside the title, then the time left and part count under the bar.
    const head = textElement("div", "session-upload-head", "");
    head.append(textElement("strong", "", title), uploadProgressPercent);
    const meta = textElement("div", "session-upload-meta", "");
    meta.append(textElement("span", "", timeLeft), uploadProgressParts);
    children.push(head, uploadProgressBar, meta);
    showUploadProgress(name, status, progress);
  }
  children.push(...lines.map((line) => textElement("p", "", line)));
  const details = textElement("div", "session-upload-details", "");
  for (const [label, value] of [
    ["Recorded", `${formatSessionTime(session.started_at)} – ${formatSessionTime(session.ended_at)}`],
    ["Length", formatDuration(session.duration_seconds)],
    ["Size", (session.size || 0) < 999e3 ? `${Math.ceil((session.size || 0) / 1e3)} KB` : `${Math.round(session.size / 1e6)} MB`],
    ...(started ? [["Upload started", started]] : []),
  ]) details.append(textElement("span", "", label), textElement("span", "", value));
  children.push(details);
  uploadTooltip.replaceChildren(...children);
  // Above the icon when it fits, right-aligned with it and kept inside the window.
  const { width, height } = uploadTooltip.getBoundingClientRect();
  const top = anchor.top - height - 10 >= 8 ? anchor.top - height - 10 : anchor.bottom + 10;
  uploadTooltip.style.top = `${top}px`;
  uploadTooltip.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, anchor.right - width + 10))}px`;
  uploadTooltip.classList.add("open");
}

// Moves the tooltip's bar and percentage to an upload's progress (0–1): eased from what was last
// shown for the same attempt, at once for another one or with reduced motion.
function showUploadProgress(name, status, target) {
  const shown = uploadProgressShown;
  const same = shown?.name === name && shown.attempt === status.started_at_ms;
  if (same && shown.target === target) return;
  cancelAnimationFrame(uploadProgressFrame);
  const from = same ? shown.value : target;
  const draw = (value) => {
    uploadProgressShown = { name, attempt: status.started_at_ms, target, value };
    uploadProgressBar.firstChild.style.width = `${value * 100}%`;
    uploadProgressPercent.textContent = `${Math.floor(value * 100)}%`;
    uploadProgressParts.textContent = `Part ${status.parts_done} of ${status.parts_total}`;
  };
  if (from === target || reducedMotion.matches) {
    draw(target);
    return;
  }
  const begin = performance.now();
  const step = (now) => {
    const t = Math.max(0, Math.min(1, (now - begin) / 700));
    draw(from + (target - from) * (1 - (1 - t) ** 3));
    if (t < 1) uploadProgressFrame = requestAnimationFrame(step);
  };
  uploadProgressFrame = requestAnimationFrame(step);
}

// After a render or a closed tooltip: keep it on an icon that still has the pointer or focus, or
// move it to a focused icon that wasn't dismissed.
function syncUploadTooltip() {
  if (uploadTooltipFor) showUploadTooltip(uploadTooltipFor);
  const focused = document.activeElement;
  if (!uploadTooltipFor && focused !== dismissedUploadIcon && focused?.classList.contains("session-pending")) {
    showUploadTooltip(focused.closest(".session-item")?.dataset.sessionName);
  }
}

function hideUploadTooltip() {
  uploadTooltipFor = null;
  uploadTooltipIcon?.removeAttribute("aria-describedby");
  uploadTooltipIcon = null;
  uploadTooltip?.classList.remove("open");
}

function updateScrollEdges() {
  const scroll = get("sessions-scroll");
  const frame = get("sessions-scroll-frame");
  frame.classList.toggle("has-more-above", scroll.scrollTop > 1);
  frame.classList.toggle("has-more-below", scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 1);
}

function initHistory() {
  if (initialized) return;
  initialized = true;
  // One tooltip for every row's upload icon, outside the list so its scrolling can't clip it.
  uploadTooltip = textElement("div", "session-upload-tooltip", "");
  uploadProgressBar = textElement("div", "session-upload-progress", "");
  uploadProgressBar.append(textElement("span", "", ""));
  uploadProgressPercent = textElement("span", "session-upload-percent", "");
  uploadProgressParts = textElement("span", "", "");
  uploadTooltip.id = "session-upload-tooltip";
  uploadTooltip.setAttribute("role", "tooltip");
  document.body.appendChild(uploadTooltip);
  // Escape closes it, and a focused icon's stays closed until that icon is hovered or focused again.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !uploadTooltipFor) return;
    const focused = document.activeElement;
    dismissedUploadIcon = focused?.classList.contains("session-pending") ? focused : null;
    hideUploadTooltip();
  });
  dayButtons = Array.from({ length: 31 }, () => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sessions-day";
    button.setAttribute("aria-controls", "sessions-scroll");
    button.innerHTML = '<span class="sessions-bar-space"><span class="sessions-bar"><span class="sessions-bar-over" aria-hidden="true"></span></span></span><span class="sessions-day-label"></span>';
    button.addEventListener("click", () => {
      if (selectedDay === button.dataset.day) return;
      selectedDay = button.dataset.day;
      state.selectedSessionName = null;
      renderSessions(state.lastSessions);
    });
    get("sessions-days").appendChild(button);
    return button;
  });
  const changeRange = (direction) => {
    const today = dayOf(new Date());
    rangeEnd = rangeMode === "month" ? monthEnd(rangeEnd, direction)
      : rangeMode === "period" ? periodEnd(shiftDay(direction < 0 ? periodStart(rangeEnd) : rangeEnd, direction))
        : shiftDay(rangeEnd, direction * 7);
    const latestEnd = rangeEndFor(rangeMode, today);
    if (rangeEnd > latestEnd) rangeEnd = latestEnd;
    selectedDay = rangeEnd > today ? today : rangeEnd;
    state.selectedSessionName = null;
    renderSessions(state.lastSessions);
  };
  get("sessions-prev").addEventListener("click", () => changeRange(-1));
  get("sessions-next").addEventListener("click", () => changeRange(1));
  get("sessions-range-toggle").addEventListener("click", () => {
    rangeMode = rangeMode === "month" ? defaultRangeMode() : "month";
    selectedDay = dayOf(new Date());
    rangeEnd = rangeEndFor(rangeMode, selectedDay);
    state.selectedSessionName = null;
    renderSessions(state.lastSessions);
  });
  get("sessions-scroll").addEventListener("scroll", () => {
    // Scrolling moves an icon from under the pointer; a focused one keeps its tooltip, which the
    // render re-anchors.
    if (document.activeElement !== uploadTooltipIcon) hideUploadTooltip();
    updateScrollEdges();
    if (scrollRenderPending) return;
    scrollRenderPending = true;
    requestAnimationFrame(() => {
      scrollRenderPending = false;
      renderSessions(state.lastSessions);
    });
  }, { passive: true });
  const observer = new ResizeObserver(() => {
    renderSessions(state.lastSessions);
    updateScrollEdges();
  });
  observer.observe(get("sessions-scroll"));
  observer.observe(state.sessionsList);
  window.addEventListener("focus", () => renderSessions(state.lastSessions));
}

function createDeleteButton(sessionName) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-button btn-delete-session";
  btn.title = "Delete session";
  btn.setAttribute("aria-label", "Delete session");
  btn.innerHTML = getDeleteIcon();
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const userId = state.currentUser?.id;
    const tokenId = state.currentTokenId;
    const day = selectedDay;
    const wasFocused = document.activeElement === btn;
    let exitAnimation;
    try {
      btn.disabled = true;
      pendingSessionDeletes.add(btn);
      sessionsRequestGeneration += 1;
      sessionsRefreshRequest = null;
      await invoke("delete_session", { name: sessionName });
      if (!state.isAuthenticated || userId !== state.currentUser?.id || tokenId !== state.currentTokenId) return;
      const row = btn.closest(".session-item");
      if (!reducedMotion.matches && row.isConnected && get("sessions-scroll").clientHeight > 0) {
        exitAnimation = row.animate([
          { opacity: getComputedStyle(row).opacity, transform: getComputedStyle(row).transform },
          { opacity: 0, transform: "translateX(-6px)" },
        ], { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
        await exitAnimation.finished.catch(() => {});
      }
      if (!state.isAuthenticated || userId !== state.currentUser?.id || tokenId !== state.currentTokenId) return;
      const restoreFocus = wasFocused && selectedDay === day
        && (document.activeElement === btn || document.activeElement === document.body);
      const daySessions = sessionsByDay.get(day) || [];
      const deletedIndex = daySessions.findIndex((session) => session.name === sessionName);
      const nextSession = daySessions.slice(deletedIndex + 1).find((session) => !session.is_deleted)
        || daySessions.slice(0, deletedIndex).reverse().find((session) => !session.is_deleted);
      state.selectedSessionName = null;
      state.lastSessions = state.lastSessions.filter(
        (session) => session.name !== sessionName,
      );
      sessionsRevision = null;
      sessionsRequestGeneration += 1;
      sessionsRefreshRequest = null;
      sessionsRenderVersion += 1;
      lastRenderKey = null;
      renderSessions(state.lastSessions);
      if (restoreFocus) {
        const scroll = get("sessions-scroll");
        if (nextSession && !renderedRows.has(nextSession.name)) {
          scroll.scrollTop = sessionsByDay.get(day).findIndex((session) => session.name === nextSession.name) * SESSION_ROW_HEIGHT;
          renderSessions(state.lastSessions);
        }
        const nextButton = renderedRows.get(nextSession?.name)?.row.querySelector(".btn-delete-session");
        (nextButton || scroll).focus();
      }
    } catch (error) {
      reportUiError("session_delete_failed", error);
      showErrorBanner(`Failed to delete session: ${error}`);
    } finally {
      exitAnimation?.cancel();
      btn.disabled = false;
      if (pendingSessionDeletes.delete(btn) && pendingSessionDeletes.size === 0) await refreshSessions();
    }
  });
  return btn;
}

// Recordings on this computer that haven't finished uploading, which aren't paid yet.
export function waitingUploadSeconds() {
  return pendingUploads.filter(({ name }) => !uploadDamaged(name)).reduce((sum, { seconds }) => sum + seconds, 0);
}

export function refreshSessions() {
  syncHistoryAccount();
  if (!state.isAuthenticated || state.logoutInFlight || pendingSessionDeletes.size > 0) return Promise.resolve();
  // The Referrals view shows friends' progress, which arrives with the uploads.
  if (document.visibilityState === "visible"
      && (state.sessionsSection?.getClientRects().length || state.referralsSection?.getClientRects().length)) {
    void refreshUploadedHistory({ ifStale: true });
  }
  if (sessionsRefreshRequest) return sessionsRefreshRequest;
  const request = loadSessions().finally(() => {
    if (sessionsRefreshRequest === request) sessionsRefreshRequest = null;
  });
  sessionsRefreshRequest = request;
  return request;
}

async function loadSessions() {
  const generation = ++sessionsRequestGeneration;
  const userId = state.currentUser?.id;
  const tokenId = state.currentTokenId;
  const isCurrent = () => generation === sessionsRequestGeneration && state.isAuthenticated
    && !state.logoutInFlight && userId === state.currentUser?.id && tokenId === state.currentTokenId;
  if (state.localSessionsStatus !== "ready") {
    state.localSessionsStatus = "loading";
    window.dispatchEvent(new Event("loggy3-sessions-changed"));
  }
  try {
    const revision = await invoke("sessions_revision");
    if (!isCurrent()) return;
    if (revision !== sessionsRevision) {
      const sessions = await invoke("list_sessions_detailed");
      if (!isCurrent()) return;
      const previousSessions = new Map(
        state.lastSessions.map((session) => [session.name, session]),
      );
      const uploadCompleted = sessions?.some((session) =>
        session.is_deleted && previousSessions.get(session.name)?.is_deleted === false
      );
      addedSessionNames = new Set((sessions || []).filter((session) =>
        knownSessionNames !== null && !knownSessionNames.has(session.name)
      ).map((session) => session.name));
      knownSessionNames = new Set((sessions || []).map((session) => session.name));
      state.lastSessions = sessions || [];
      if (
        state.selectedSessionName !== null
        && !state.lastSessions.some((session) => session.name === state.selectedSessionName)
      ) {
        state.selectedSessionName = null;
      }
      sessionsRevision = revision;
      sessionsRenderVersion += 1;
      lastRenderKey = null;
      if (uploadCompleted) refreshUploadedHistory();
    }
    const statuses = await invoke("upload_statuses").catch(() => null);
    if (!isCurrent()) return;
    if (statuses) applyUploadStatuses(statuses);
    state.localSessionsStatus = "ready";
    renderSessions(state.lastSessions);
    window.dispatchEvent(new Event("loggy3-sessions-changed"));
  } catch (e) {
    if (isCurrent()) {
      state.localSessionsStatus = "error";
      reportUiError("session_list_failed", e);
      window.dispatchEvent(new Event("loggy3-sessions-changed"));
    }
  }
  if (isCurrent()) refreshSessionsLocation();
}

// Destination indicator: only shown when an external sessions volume is configured
// (default home-directory builds keep the header as-is).
async function refreshSessionsLocation() {
  const el = document.getElementById("sessions-location");
  if (!el) return;
  try {
    const loc = await invoke("sessions_location");
    if (!loc.volume || !state.tosAcceptedThisRun) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    if (loc.available) {
      el.textContent = `Saving to external drive '${loc.volume}' — ${loc.path}`;
      el.style.color = "#9aa0a6";
    } else {
      el.textContent = `Drive '${loc.volume}' is not connected — recording is disabled until it is plugged in.`;
      el.style.color = "#d4380d";
    }
  } catch (e) {
    el.style.display = "none";
  }
}

export function renderSessions(sessions) {
  if (sessions !== state.lastSessions) {
    state.lastSessions = sessions;
    sessionsRenderVersion += 1;
  }
  if (!state.sessionsList) return;
  get("sessions-cap-policy").hidden = !state.selfServeUser
    || recorderNeedsControl() || state.recorderPhase !== "stopped";
  initHistory();
  const historyMessage = uploadedHistoryStatus === "error"
    ? "Couldn’t refresh uploads. Totals may be incomplete."
    : uploadedSessions.userId !== historyUserId ? "Loading uploads…" : "";
  get("sessions-history-status").textContent = historyMessage;
  get("sessions-history-status").hidden = !historyMessage;
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (renderedTimeZone !== timeZone) {
    renderedTimeZone = timeZone;
    sessionsRenderVersion += 1;
  }
  // An account that becomes (or stops being) self-serve switches to pay periods and UTC days, or
  // back to weeks and its own days.
  const basis = state.selfServeUser ? "utc" : "local";
  if (rangeMode === (state.selfServeUser ? "week" : "period") || (groupedBasis && groupedBasis !== basis)) {
    rangeMode = defaultRangeMode();
    selectedDay = dayOf(new Date());
    rangeEnd = rangeEndFor(rangeMode, selectedDay);
  }
  // Each recording earns the tier in effect when it started; the history arrives with uploads.
  const rateHistory = uploadedSessions.userId === historyUserId ? uploadedSessions.rateHistory : [];
  // Damaged files never upload, so they take none of their days' paid hours.
  const damagedKey = [...uploadStatuses.keys()].filter(uploadDamaged).sort().join();
  if (groupedRevision !== sessionsRenderVersion || groupedBasis !== basis || groupedDamaged !== damagedKey) {
    sessionsByDay = new Map();
    secondsByDay = new Map();
    pendingUploads = [];
    uploadSpans = [];
    const uploaded = uploadedSessions.userId === historyUserId ? uploadedSessions.sessions : [];
    const uploadedById = new Map(uploaded.map((session) => [session.id, session]));
    for (const local of sessions || []) {
      const remote = uploadedById.get(local.name);
      const session = remote ? { ...local, started_at: remote.started_at,
        ended_at: new Date(Date.parse(remote.started_at) + remote.seconds * 1000).toISOString(),
        duration_seconds: remote.seconds, is_deleted: true } : local;
      const day = dayOf(new Date(session.started_at));
      if (!sessionsByDay.has(day)) sessionsByDay.set(day, []);
      sessionsByDay.get(day).push(session);
      secondsByDay.set(day, (secondsByDay.get(day) || 0) + session.duration_seconds);
      // Still on this computer: it is paid once its upload completes, after every upload so far.
      if (!session.is_deleted) {
        pendingUploads.push({ name: session.name, day, start: Date.parse(session.started_at),
          seconds: session.duration_seconds, uploadedAt: Infinity });
      }
    }
    // Uploads share the local session name, so anything not on this disk came from elsewhere.
    otherSecondsByDay = new Map();
    const localNames = new Set((sessions || []).map((session) => session.name));
    for (const session of uploaded) {
      if (localNames.has(session.id)) continue;
      const day = dayOf(new Date(session.started_at));
      otherSecondsByDay.set(day, (otherSecondsByDay.get(day) || 0) + session.seconds);
      if (!sessionsByDay.has(day)) sessionsByDay.set(day, []);
      // Uploaded sessions have no local files to delete; use the same read-only row shape.
      sessionsByDay.get(day).push({
        name: session.id,
        started_at: session.started_at,
        ended_at: new Date(Date.parse(session.started_at) + session.seconds * 1000).toISOString(),
        duration_seconds: session.seconds,
        is_deleted: true,
      });
    }
    for (const daySessions of sessionsByDay.values()) {
      daySessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
    }
    for (const session of uploaded) {
      const start = Date.parse(session.started_at);
      const uploadedAt = Date.parse(session.uploaded_at);
      uploadSpans.push({
        day: dayOf(new Date(start)), start, seconds: session.seconds, rate: rateTierAt(rateHistory, start),
        // No upload time (older servers, or sessions completed before they were kept): count the
        // upload as finishing with the recording.
        uploadedAt: Number.isFinite(uploadedAt) ? uploadedAt : start + session.seconds * 1000,
      });
    }
    uploadEarnings = capByUploadOrder([...uploadSpans,
      ...pendingUploads.filter(({ name }) => !uploadDamaged(name))]);
    unpaidSecondsByDay = uploadEarnings.unpaid;
    groupedRevision = sessionsRenderVersion;
    groupedBasis = basis;
    groupedDamaged = damagedKey;
  }

  const today = dayOf(new Date());
  if (renderedToday !== null && renderedToday !== today && selectedDay === renderedToday) selectedDay = today;
  // Keep the current period up to date without moving someone browsing older dates.
  const latestEnd = rangeEndFor(rangeMode, today);
  if (renderedRange && rangeEnd === renderedRange && get("sessions-next").disabled && rangeEnd !== latestEnd) {
    rangeEnd = latestEnd;
  }
  const dayCount = rangeMode === "month" ? dayDate(rangeEnd).getDate()
    : rangeMode === "period" ? Number(rangeEnd.slice(8)) - Number(periodStart(rangeEnd).slice(8)) + 1 : 7;
  const days = Array.from({ length: dayCount }, (_, index) => shiftDay(rangeEnd, index - dayCount + 1));
  if (selectedDay < days[0] || selectedDay > rangeEnd || selectedDay > today) selectedDay = rangeEnd > today ? today : rangeEnd;
  const dayChanged = renderedDay !== null && renderedDay !== selectedDay;
  const modeChanged = renderedRangeMode !== null && renderedRangeMode !== rangeMode;
  const rangeChanged = renderedRange !== null && (renderedRange !== rangeEnd || renderedRangeMode !== rangeMode);
  const rateTier = currentRateTier();
  const nextChartKey = `${sessionsRenderVersion}:${rangeMode}:${rangeEnd}:${selectedDay}:${today}:${state.selfServeUser}:${rateTier?.name}:${rateTier?.hourly_rate_cents}:${damagedKey}`;
  if (chartRenderKey !== nextChartKey) {
    const chart = get("sessions-days");
    if (dayChanged || rangeChanged || renderedRange === null) {
      outgoingChart?.getAnimations().forEach((animation) => animation.cancel());
      outgoingChart?.remove();
      outgoingChart = null;
    }
    if (modeChanged && !reducedMotion.matches) {
      outgoingChart = chart.cloneNode(true);
      outgoingChart.removeAttribute("id");
      outgoingChart.setAttribute("aria-hidden", "true");
      outgoingChart.inert = true;
      outgoingChart.classList.add("sessions-chart-ghost");
      outgoingChart.querySelectorAll(".sessions-bar").forEach((bar, index) => {
        const current = getComputedStyle(dayButtons[index].querySelector(".sessions-bar"));
        bar.style.height = current.height;
        bar.style.backgroundColor = current.backgroundColor;
      });
      chart.parentElement.appendChild(outgoingChart);
    }
    chart.classList.toggle("sessions-days-switching", modeChanged || renderedRange === null);
    const localTotals = days.map(daySeconds);
    const otherTotals = days.map(otherDaySeconds);
    const totals = days.map((_, index) => localTotals[index] + otherTotals[index]);
    const total = totals.reduce((sum, seconds) => sum + seconds, 0);
    const cap = state.selfServeUser ? SELF_SERVE_DAILY_CAP_SECONDS : null;
    get("sessions-cap-policy").textContent = `${SELF_SERVE_CAP_HOURS} paid hours/day · Resets at ${capResetTime().replace(/:00\b/, "")} your time (00:00 UTC)`;
    const unpaidTotals = days.map((day) => cap ? unpaidSecondsByDay.get(day) || 0 : 0);
    const unpaid = unpaidTotals.reduce((sum, seconds) => sum + seconds, 0);
    // Until history that reaches the current tier loads (again, after a change), show hours.
    const payoutTier = cap && paysLike(rateHistory.at(-1), rateTier) ? rateTier : null;
    // The range pays the uploads that completed in it, whichever day they were recorded; the
    // bars show recording days. A month pays its two pay periods.
    const { earned, unpaidSeconds: uploadedUnpaid, totalSeconds: uploadedTotal } = rangeEarnings(uploadEarnings, days[0], rangeEnd);
    const hourlyCents = Math.round([...earned.values()].reduce((sum, { cents }) => sum + cents, 0));
    // A referral bonus belongs to the period its friend's uploads reached the target in, whose payout pays it unless
    // a ban held it back (docs/referrals.md).
    const bonuses = (state.referrals?.bonuses || []).filter(({ reached_at: reachedAt }) => {
      const payDay = utcDay(new Date(reachedAt));
      return payDay >= days[0] && payDay <= rangeEnd;
    });
    const bonusCents = bonuses.reduce((sum, { cents }) => sum + cents, 0);
    const payoutCents = payoutTier ? hourlyCents + bonusCents : null;
    const breakdown = payoutTier ? payoutRows({
      current: payoutTier, history: rateHistory, earned, unpaidSeconds: uploadedUnpaid, totalSeconds: uploadedTotal,
      payoutCents: hourlyCents, bonuses,
    }) : null;
    // Where the bars and the payout differ: uploads paid in this range that were recorded before
    // it, and recordings from it that finished uploading after it.
    let recordedBefore = 0;
    let uploadedAfter = 0;
    for (const span of uploadSpans) {
      const payDay = utcDay(new Date(span.uploadedAt));
      if (payDay >= days[0] && payDay <= rangeEnd && span.day < days[0]) recordedBefore += span.seconds;
      else if (payDay > rangeEnd && span.day >= days[0] && span.day <= rangeEnd) uploadedAfter += span.seconds;
    }
    // Recordings still on this computer: the current range pays them once they upload, and an
    // earlier one lists its own so its bars and payout add up. Damaged ones never pay.
    const tally = (list) => ({ count: list.length, seconds: list.reduce((sum, { seconds }) => sum + seconds, 0) });
    const current = today >= days[0] && today <= rangeEnd ? pendingUploads
      : pendingUploads.filter(({ day }) => day >= days[0] && day <= rangeEnd);
    const pending = tally(current.filter(({ name }) => !uploadDamaged(name)));
    const damaged = tally(current.filter(({ name }) => uploadDamaged(name)));
    const axisHours = Math.max(8, Math.ceil(Math.max(...totals) / 14400) * 4);
    get("sessions-axis-max").textContent = `${axisHours}h`;
    get("sessions-axis-mid").textContent = `${axisHours / 2}h`;
    get("sessions-total-hours").textContent = String(Math.floor(total / 3600));
    get("sessions-total-minutes").textContent = String(Math.floor(total % 3600 / 60)).padStart(2, "0");
    get("sessions-week-total").setAttribute("aria-label", shortDuration(total));
    // Self-serve headline: what this period pays, leaving out time past each UTC day's cap.
    get("sessions-week-total").hidden = !!payoutTier;
    get("sessions-payout").hidden = !payoutTier;
    if (payoutTier) {
      const payout = payoutFormat.format(payoutCents / 100);
      get("sessions-payout-amount").textContent = payout;
      get("sessions-payout-hours").textContent = String(Math.floor(uploadedTotal / 3600));
      get("sessions-payout-minutes").textContent = String(Math.floor(uploadedTotal % 3600 / 60)).padStart(2, "0");
      get("sessions-payout").setAttribute("aria-label", `$${payout} estimated payout, ${shortDuration(uploadedTotal)} uploaded`);
      renderPayoutTooltip(breakdown, { pending, damaged, recordedBefore, uploadedAfter, unit: rangeMode === "month" ? "month" : "pay period" });
    }
    // Paging back past the fetched window asks for older uploads; two extra days cover UTC days
    // that straddle the first local day. An upload paid in this range that was recorded earlier
    // also needs the rest of its recording day, whose cap it shares, up to a month back: later
    // uploads are rare, and the window stays that wide for every refresh. Deferred so the fetch
    // never starts mid-render.
    const rangeStart = basis === "utc" ? Date.parse(`${days[0]}T00:00:00Z`) : new Date(`${days[0]}T00:00:00`).getTime();
    const earliestPaidDay = !cap ? Infinity : uploadSpans.reduce((min, span) => {
      const payDay = utcDay(new Date(span.uploadedAt));
      return payDay >= days[0] && payDay <= rangeEnd ? Math.min(min, Math.floor(span.start / DAY_MS) * DAY_MS) : min;
    }, Infinity);
    const neededSince = Math.min(rangeStart, Math.max(earliestPaidDay, rangeStart - 31 * DAY_MS)) - 2 * DAY_MS;
    if (state.isAuthenticated && uploadedSessions.userId === historyUserId && neededSince < uploadedSessions.since) {
      void Promise.resolve().then(() => refreshUploadedHistory({ since: neededSince }));
    }
    const first = dayDate(days[0]);
    const last = dayDate(rangeEnd);
    const rangeText = rangeMode === "month"
      ? last.toLocaleDateString(undefined, { month: "short", year: "numeric" })
      : new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric",
      ...(first.getFullYear() !== dayDate(today).getFullYear() ? { year: "numeric" } : {}),
    }).formatRange(first, last);
    const range = get("sessions-range");
    const label = get("sessions-range-label");
    if (label.textContent !== rangeText || renderedRange === null) {
      const previousWidth = range.getBoundingClientRect().width;
      rangeWidthAnimation?.cancel();
      label.textContent = rangeText;
      const width = range.getBoundingClientRect().width;
      if (rangeChanged && !reducedMotion.matches && previousWidth > 0 && width > 0 && previousWidth !== width) {
        rangeWidthAnimation = range.animate([{ width: `${previousWidth}px` }, { width: `${width}px` }], {
          duration: 220, easing: "cubic-bezier(.2,.8,.2,1)",
        });
      }
    }
    const earliestUpload = uploadedSessions.userId === historyUserId && uploadedSessions.earliestSessionAt
      ? dayOf(new Date(uploadedSessions.earliestSessionAt)) : today;
    const earliest = earliestDay([earliestUpload, ...sessionsByDay.keys()], state.referrals?.bonuses);
    get("sessions-prev").disabled = days[0] <= earliest;
    get("sessions-next").disabled = rangeEnd >= latestEnd;
    const unit = { week: "week", month: "month", period: "pay period" }[rangeMode];
    get("sessions-prev").setAttribute("aria-label", `Previous ${unit}`);
    get("sessions-next").setAttribute("aria-label", `Next ${unit}`);
    const rangeNames = { week: "Week", month: "Month", period: "Pay period" };
    get("sessions-range-toggle").textContent = rangeNames[rangeMode];
    get("sessions-range-toggle").setAttribute("aria-label", `Date range: ${rangeNames[rangeMode]}. Switch to ${rangeNames[rangeMode === "month" ? defaultRangeMode() : "month"]}`);
    const timezone = new Intl.DateTimeFormat(undefined, { timeZoneName: "longGeneric" })
      .formatToParts(last).find((part) => part.type === "timeZoneName");
    get("sessions-timezone").textContent = basis === "utc" ? `UTC days · ${timezone.value}` : timezone.value;
    dayButtons.forEach((button, index) => {
      button.hidden = index >= days.length;
      if (button.hidden) {
        button.dataset.day = "";
        return;
      }
      const day = days[index];
      const date = dayDate(day);
      button.dataset.day = day;
      button.disabled = day > today;
      button.setAttribute("aria-pressed", String(day === selectedDay));
      const capped = unpaidTotals[index] >= 60
        ? `, ${shortDuration(unpaidTotals[index])} of this total is above the paid limit` : "";
      button.setAttribute("aria-label", `${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${basis === "utc" ? " (UTC)" : ""}: ${formatDuration(totals[index])}, ${(sessionsByDay.get(day) || []).length} sessions${capped}`);
      button.querySelector(".sessions-day-label").textContent = rangeMode !== "week"
        ? String(date.getDate())
        : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${date.getDate()}`;
      button.querySelector(".sessions-bar").style.height = `${totals[index] / (axisHours * 3600) * 100}%`;
      // The unpaid top of the bar explains itself on hover; tips open toward the chart's middle.
      const over = button.querySelector(".sessions-bar-over");
      over.classList.toggle("sessions-tip-end", index >= days.length / 2);
      if (unpaidTotals[index] >= 60) {
        over.style.height = `${unpaidTotals[index] / totals[index] * 100}%`;
        over.setAttribute("aria-label", capExplanation(day, totals[index]));
      } else {
        over.style.height = "0";
        over.removeAttribute("aria-label");
      }
    });
    get("sessions-days").style.setProperty("--day-count", dayCount);
    get("sessions-days").classList.toggle("sessions-days-month", rangeMode !== "week");
    const prefix = selectedDay === today ? "Today · " : selectedDay === shiftDay(today, -1) ? "Yesterday · " : "";
    get("sessions-day-title").textContent = prefix + dayDate(selectedDay).toLocaleDateString(undefined, {
      ...(prefix ? {} : { weekday: "long" }), month: "short", day: "numeric",
      ...(dayDate(selectedDay).getFullYear() !== dayDate(today).getFullYear() ? { year: "numeric" } : {}),
    }) + (basis === "utc" ? " (UTC)" : "");
    const dayTotal = daySeconds(selectedDay) + otherDaySeconds(selectedDay);
    get("sessions-day-total").textContent = shortDuration(dayTotal);
    const dayUnpaid = cap ? unpaidSecondsByDay.get(selectedDay) || 0 : 0;
    get("sessions-day-cap").hidden = dayUnpaid < 60;
    get("sessions-day-cap").setAttribute("aria-label", capExplanation(selectedDay, dayTotal));
    if (modeChanged || renderedRange === null) {
      void chart.offsetHeight;
      chart.classList.remove("sessions-days-switching");
    }
    // Use the same totals and formatted values as the UI, without recalculating the cap.
    displayedSnapshot = {
      calculation_version: 4,
      day_basis: basis,
      program_type: state.selfServeUser ? "self_serve" : "non_self_serve",
      range_mode: rangeMode,
      range_start: days[0],
      range_end: rangeEnd,
      timezone: timeZone,
      total_seconds: total,
      local_seconds: localTotals.reduce((sum, seconds) => sum + seconds, 0),
      remote_seconds: otherTotals.reduce((sum, seconds) => sum + seconds, 0),
      pending_local_seconds: days.reduce((sum, day) => sum + (sessionsByDay.get(day) || [])
        .filter((session) => !session.is_deleted)
        .reduce((seconds, session) => seconds + session.duration_seconds, 0), 0),
      unpaid_seconds: cap ? unpaid : null,
      uploaded_seconds: cap ? uploadedTotal : null,
      uploaded_unpaid_seconds: cap ? uploadedUnpaid : null,
      recorded_before_seconds: cap ? recordedBefore : null,
      uploaded_after_seconds: cap ? uploadedAfter : null,
      pending_upload_sessions: pending.count,
      pending_upload_seconds: pending.seconds,
      damaged_sessions: damaged.count,
      estimated_payout_cents: payoutCents,
      displayed_payout: payoutTier ? `$${get("sessions-payout-amount").textContent}` : null,
      displayed_hours: get(payoutTier ? "sessions-payout-hours" : "sessions-total-hours").textContent,
      displayed_minutes: get(payoutTier ? "sessions-payout-minutes" : "sessions-total-minutes").textContent,
      selected_day: selectedDay,
      selected_day_local_seconds: daySeconds(selectedDay),
      selected_day_remote_seconds: otherDaySeconds(selectedDay),
      selected_day_unpaid_seconds: cap ? dayUnpaid : null,
      displayed_day_total: get("sessions-day-total").textContent,
      hourly_rate_cents: payoutTier ? payoutTier.hourly_rate_cents : null,
      rate_tier: payoutTier ? payoutTier.tier : null,
      rate_breakdown: breakdown && rateBreakdown(breakdown),
      daily_cap_seconds: cap,
      cap_timezone: cap ? "UTC" : null,
      remote_since_ms: uploadedSessions.userId === historyUserId ? uploadedSessions.since : null,
    };
    chartRenderKey = nextChartKey;
  }

  const scroll = get("sessions-scroll");
  if (dayChanged) scroll.scrollTop = 0;
  const dailySessions = sessionsByDay.get(selectedDay) || [];
  const visibleRows = Math.ceil((scroll.clientHeight || 240) / SESSION_ROW_HEIGHT);
  const firstVisible = Math.min(Math.floor(scroll.scrollTop / SESSION_ROW_HEIGHT), Math.max(0, dailySessions.length - visibleRows));
  const start = Math.max(0, firstVisible - SESSION_OVERSCAN);
  const end = Math.min(dailySessions.length, firstVisible + visibleRows + SESSION_OVERSCAN);
  const focusedName = document.activeElement?.closest(".session-item")?.dataset.sessionName;
  const renderKey = [sessionsRenderVersion, selectedDay, start, end, state.selectedSessionName || "", focusedName || ""].join(":");
  if (lastRenderKey !== renderKey) {
    lastRenderKey = renderKey;
    const animateChanges = renderedDay === selectedDay && !reducedMotion.matches
      && renderedRowsVersion !== sessionsRenderVersion && scroll.clientHeight > 0;
    const previousPositions = new Map();
    if (animateChanges) {
      for (const [name, { row }] of renderedRows) {
        previousPositions.set(name, row.getBoundingClientRect().top);
      }
    }
    const nodes = [];
    const nextRows = new Map();
    const appendSpacer = (count) => {
      if (count <= 0) return;
      const row = document.createElement("tr");
      row.className = "sessions-spacer";
      row.setAttribute("aria-hidden", "true");
      const cell = document.createElement("td");
      cell.colSpan = 2;
      cell.style.height = `${count * SESSION_ROW_HEIGHT}px`;
      row.appendChild(cell);
      nodes.push(row);
    };
    const indexes = Array.from({ length: end - start }, (_, index) => start + index);
    // Keep an offscreen focused row mounted, with spacers filling the gap.
    if (!focusedName) {
      focusedSessionLookup = null;
    } else if (focusedSessionLookup?.sessions !== dailySessions || focusedSessionLookup.name !== focusedName) {
      focusedSessionLookup = {
        sessions: dailySessions,
        name: focusedName,
        index: dailySessions.findIndex((session) => session.name === focusedName),
      };
    }
    const focusedIndex = focusedSessionLookup?.index ?? -1;
    if (focusedIndex >= 0 && (focusedIndex < start || focusedIndex >= end)) {
      indexes.push(focusedIndex);
      indexes.sort((a, b) => a - b);
    }
    let previousIndex = -1;
    for (const index of indexes) {
      appendSpacer(index - previousIndex - 1);
      previousIndex = index;
      const session = dailySessions[index];
      const rowKey = JSON.stringify([session.started_at, session.ended_at, session.duration_seconds, session.is_deleted, timeZone]);
      let cached = renderedRows.get(session.name);
      if (cached?.key !== rowKey) {
        const row = document.createElement("tr");
        row.className = "session-item";
        row.dataset.sessionName = session.name;
        const time = document.createElement("td");
        time.className = "session-time";
        time.textContent = `${formatSessionTime(session.started_at)} – ${formatSessionTime(session.ended_at)}`;
        const duration = document.createElement("td");
        duration.className = "duration-col";
        const details = document.createElement("span");
        details.className = "session-duration-content";
        details.textContent = formatDuration(session.duration_seconds);
        duration.appendChild(details);
        if (!session.is_deleted) {
          const actions = document.createElement("span");
          actions.className = "session-actions";
          const pending = document.createElement("span");
          paintUploadIcon(pending, session);
          pending.tabIndex = 0;
          pending.setAttribute("role", "img");
          pending.innerHTML = getPendingUploadIcon();
          const open = () => {
            if (dismissedUploadIcon === pending) dismissedUploadIcon = null;
            showUploadTooltip(session.name);
          };
          // Close unless this icon keeps the other trigger, then fall back to a focused icon.
          const close = (still) => () => {
            if (uploadTooltipIcon !== pending || pending.matches(still)) return;
            hideUploadTooltip();
            syncUploadTooltip();
          };
          pending.addEventListener("mouseenter", open);
          pending.addEventListener("focus", open);
          pending.addEventListener("mouseleave", close(":focus"));
          pending.addEventListener("blur", close(":hover"));
          actions.append(createDeleteButton(session.name), pending);
          details.prepend(actions);
          row.addEventListener("click", (event) => {
            event.stopPropagation();
            if (event.target.closest(".session-actions")) return;
            state.selectedSessionName = session.name;
            renderSessions(state.lastSessions);
          });
        }
        row.append(time, duration);
        cached = { key: rowKey, row };
      }
      cached.row.classList.toggle("selected", !session.is_deleted && state.selectedSessionName === session.name);
      nextRows.set(session.name, cached);
      nodes.push(cached.row);
    }
    appendSpacer(dailySessions.length - previousIndex - 1);
    const scrollTop = scroll.scrollTop;
    const retained = new Set(nodes);
    for (const node of Array.from(state.sessionsList.children)) {
      if (!retained.has(node)) node.remove();
    }
    let cursor = state.sessionsList.firstChild;
    for (const node of nodes) {
      if (node === cursor) cursor = cursor.nextSibling;
      else state.sessionsList.insertBefore(node, cursor);
    }
    renderedRows = nextRows;
    scroll.scrollTop = scrollTop;
    if (animateChanges) {
      const viewport = scroll.getBoundingClientRect();
      for (const [name, { row }] of nextRows) {
        const bounds = row.getBoundingClientRect();
        if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
        const previousTop = previousPositions.get(name);
        if (addedSessionNames.has(name)) {
          row.getAnimations().forEach((animation) => animation.cancel());
          row.animate([
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "translateY(0)" },
          ], { duration: 320, easing: "cubic-bezier(.22,1,.36,1)" });
        } else if (previousTop !== undefined && Math.abs(previousTop - bounds.top) > 0.5) {
          row.getAnimations().forEach((animation) => animation.cancel());
          const offset = previousTop - row.getBoundingClientRect().top;
          row.animate([
            { transform: `translateY(${offset}px)` },
            { transform: "translateY(0)" },
          ], { duration: 280, easing: "cubic-bezier(.22,1,.36,1)" });
        }
      }
    }
    renderedRowsVersion = sessionsRenderVersion;
  }
  addedSessionNames.clear();
  get("sessions-empty").hidden = dailySessions.length !== 0;
  if (dailySessions.length === 0) {
    let title = historyMessage
      ? uploadedHistoryStatus === "error" ? "Upload history unavailable" : "Loading uploads…"
      : "No recordings this day";
    let hint = historyMessage ? "We’ll keep trying automatically." : "Select another day above.";
    if (selectedDay === today) {
      if (!historyMessage) {
        title = "No recordings yet";
        hint = "Press Start to record your first session.";
      }
      if (state.recorderPhase === "stopping") {
        title = "Saving your recording…";
        hint = "It will appear here when it’s ready.";
      } else if (state.wantsToRecord || state.resumePending || state.recorderPhase === "recording") {
        title = state.isIdle ? "Recording paused" : "Recording in progress";
        hint = "Your session will appear here after it stops.";
      }
    }
    get("sessions-empty-title").textContent = title;
    get("sessions-empty-hint").textContent = hint;
  }
  updateScrollEdges();
  if ((dayChanged || rangeChanged) && !reducedMotion.matches) {
    const targets = dayChanged ? [get("sessions-day-title"), get("sessions-day-total"), get("sessions-day-cap"), get("sessions-scroll")] : [];
    if (rangeChanged) {
      targets.push(get("sessions-total-hours"), get("sessions-total-minutes"), get("sessions-payout"), get("sessions-range-label"));
      if (modeChanged) targets.push(get("sessions-days"));
      else targets.push(...dayButtons.filter((button) => !button.hidden).map((button) => button.querySelector(".sessions-day-label")));
    }
    for (const element of targets) {
      const animations = element.getAnimations();
      const interrupted = animations.some((animation) => animation.playState === "running");
      const chart = element === get("sessions-days");
      const opacity = interrupted ? getComputedStyle(element).opacity : chart ? 0 : 0.45;
      animations.forEach((animation) => animation.cancel());
      element.animate([{ opacity }, { opacity: 1 }], {
        duration: chart ? 220 : 180, easing: "cubic-bezier(.2,.8,.2,1)",
      });
    }
    if (modeChanged && outgoingChart) {
      const previous = outgoingChart;
      previous.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 220, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards",
      }).onfinish = () => {
        previous.remove();
        if (outgoingChart === previous) outgoingChart = null;
      };
    }
  }
  renderedDay = selectedDay;
  renderedToday = today;
  renderedRange = rangeEnd;
  renderedRangeMode = rangeMode;
  // The open tooltip follows its row, which this render may have moved or removed.
  syncUploadTooltip();
  if (displayedSnapshot) trackSessionsDisplay(displayedSnapshot);
}
