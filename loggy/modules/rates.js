// Hourly rate tiers for self-serve contributors. A recording is paid at the tier in effect when
// it started. The last rate each account saw is kept, so a change made while the app was closed
// still gets the modal; a first tier is introduced the same way unless onboarding listed it.

import { state } from "./state.js";
import { invoke } from "./tauri.js";
import { reportUiError } from "./errors.js";

const centsFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const noticeKey = (userId) => `loggy3-rate-tier:${userId}`;
// What every self-serve contributor earned before tiers.
const FLAT_RATE_CENTS = 50;
// Prices can change on the server, so the tier list is refreshed now and then. Callers render
// often, so a failed load waits before trying again.
const CATALOG_REFRESH_MS = 10 * 60 * 1000;
const CATALOG_RETRY_MS = 30 * 1000;
// Shared by the rate tooltip and the tier introduction; approved copy.
const TIER_REVIEW_COPY = "Your tier depends on the kind of work you record. Skilled work like CAD, Excel, and programming earns higher tiers. Casual browsing and entertainment may earn lower tiers. Tiers are reviewed every pay cycle.";

let dialog = null;
let scrim = null;
let shownNotice = null;
let catalog = null;
// When the list is next fetched: after a refresh period, or sooner after a failed or empty load.
let catalogStaleAt = 0;
let catalogRequest = null;
let tooltipKey = null;
// The last rate each account saw this session. Storage keeps it across launches; this keeps
// it if storage can't, so a dismissed modal doesn't come straight back.
const seenThisSession = new Map();

export function formatRateAmount(cents) {
  return `$${centsFormat.format(cents / 100)}`;
}

export function formatHourlyRate(cents) {
  return `${formatRateAmount(cents)}/hour`;
}

// The tier only means something for self-serve accounts.
export function currentRateTier() {
  return state.isAuthenticated && state.selfServeUser ? state.currentUser?.rateTier || null : null;
}

// A self-serve contributor sees their rate before they can start a recording at it.
export function rateTierPending() {
  return state.isAuthenticated && state.selfServeUser && !currentRateTier();
}

// A rename alone does not change what a recording earns.
export function paysLike(a, b) {
  return !!a && !!b && a.tier === b.tier && a.hourly_rate_cents === b.hourly_rate_cents;
}

// What a rate pays, as a key ("" without one), so a renamed tier still groups with itself.
export const rateKey = (rate) => (rate ? `${rate.tier}:${rate.hourly_rate_cents}` : "");

function isRateTier(value) {
  return typeof value?.tier === "string" && typeof value.name === "string"
    && Number.isInteger(value.hourly_rate_cents);
}

// The tier a recording that started at `startedAtMs` earns: the latest one in effect then, or
// null when the account had no tier yet, since a recording without one isn't paid by tier.
// History entries are oldest first; a null `effective_at` applies from the account's start.
export function rateTierAt(history, startedAtMs) {
  let tier = null;
  for (const period of history || []) {
    const from = period.effective_at === null ? -Infinity : Date.parse(period.effective_at);
    if (!(from <= startedAtMs)) break;
    tier = period;
  }
  return tier;
}

// Every tier, cheapest first, or null until the list loads.
export function rateTierCatalog() {
  return catalog;
}

// Resolves with the tier list (or null) once there is nothing more to wait for.
export function loadRateTierCatalog() {
  if (catalogRequest) return catalogRequest;
  if (Date.now() < catalogStaleAt) return Promise.resolve(catalog);
  catalogRequest = invoke("get_rate_tiers")
    .then((tiers) => {
      const loaded = Array.isArray(tiers) && tiers.length > 0;
      if (loaded) catalog = tiers;
      catalogStaleAt = Date.now() + (loaded ? CATALOG_REFRESH_MS : CATALOG_RETRY_MS);
      return catalog;
    })
    .catch((error) => {
      catalogStaleAt = Date.now() + CATALOG_RETRY_MS;
      reportUiError("rate_tiers_load_failed", error);
      return catalog;
    })
    .finally(() => { catalogRequest = null; });
  return catalogRequest;
}

export function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

// How many of a four-bar meter a tier lights: its place among all tiers, at least one.
function meterLevel(place) {
  return Math.max(1, Math.round((place + 1) / catalog.length * 4));
}

// Every tier, cheapest first, with the account's own marked, styled by the `${prefix}-*` rules.
// The account's own rate is authoritative if the list is a little out of date.
function tierList(prefix, current, { meters = false } = {}) {
  const list = document.createElement("ul");
  list.className = `${prefix}-tiers`;
  list.append(...catalog.map((entry, place) => {
    const own = entry.tier === current.tier;
    const row = document.createElement("li");
    row.classList.toggle(`${prefix}-own`, own);
    if (meters) {
      const meter = textElement("span", `${prefix}-meter`, "");
      meter.setAttribute("aria-hidden", "true");
      const lit = meterLevel(place);
      for (let bar = 0; bar < 4; bar++) meter.append(textElement("i", bar < lit ? "on" : "", ""));
      row.append(meter);
    }
    row.append(textElement("span", "", entry.name));
    if (own) row.append(textElement("span", `${prefix}-you`, "Your tier"));
    row.append(textElement("span", `${prefix}-rate`,
      formatHourlyRate(own ? current.hourly_rate_cents : entry.hourly_rate_cents)));
    return row;
  }));
  return list;
}

// The sidebar names the tier and lights its meter to the tier's place once the list is known;
// it and the rate beside Start share the explanation shown on hover or focus.
function renderTierDetails(tier) {
  document.getElementById("sidebar-rate-tier-name").textContent = tier.name;
  const place = catalog?.findIndex((entry) => entry.tier === tier.tier) ?? -1;
  const lit = place < 0 ? 0 : meterLevel(place);
  document.getElementById("sidebar-rate-tier").querySelectorAll(".sidebar-tier-meter rect")
    .forEach((bar, index) => bar.classList.toggle("on", index < lit));
  const key = JSON.stringify([tier, catalog]);
  if (key === tooltipKey) return;
  tooltipKey = key;
  for (const id of ["session-rate-tooltip", "sidebar-rate-tier-tooltip"]) {
    document.getElementById(id).replaceChildren(
      textElement("strong", "session-rate-tooltip-title", "Hourly rates"),
      catalog ? tierList("session-rate-tooltip", tier)
        : textElement("p", "", `You’re on ${tier.name}: ${formatHourlyRate(tier.hourly_rate_cents)}.`),
      textElement("p", "", TIER_REVIEW_COPY),
    );
  }
}

// The tier in the sidebar and the rate beside Start.
export function renderRateTier() {
  const tier = currentRateTier();
  const sidebarRow = document.getElementById("sidebar-rate-tier");
  if (sidebarRow) sidebarRow.hidden = !tier;
  if (state.sessionRate) {
    // The row also holds the daily cap, which every self-serve account sees. Until the rate
    // arrives, Start is unavailable, so the row says what it is waiting for.
    state.sessionRate.hidden = !state.selfServeUser;
    const amount = document.getElementById("session-rate-amount");
    amount.classList.toggle("session-rate-pending", !tier);
    amount.textContent = tier ? formatHourlyRate(tier.hourly_rate_cents) : "Waiting for your hourly rate";
    amount.tabIndex = tier ? 0 : -1;
    document.getElementById("session-rate-tooltip").hidden = !tier;
  }
  if (!tier) return;
  renderTierDetails(tier);
  void loadRateTierCatalog().then(() => {
    const latest = currentRateTier();
    if (latest) renderTierDetails(latest);
  });
}

function readNotice(userId) {
  if (seenThisSession.has(userId)) return seenThisSession.get(userId);
  try {
    const saved = JSON.parse(localStorage.getItem(noticeKey(userId)));
    return isRateTier(saved?.tier) ? { tier: saved.tier, stopped: saved.stopped === true } : null;
  } catch (_) {
    return null;
  }
}

function writeNotice(userId, notice) {
  seenThisSession.set(userId, notice);
  try {
    localStorage.setItem(noticeKey(userId), JSON.stringify(notice));
  } catch (error) {
    // At worst the modal shows again next launch.
    reportUiError("rate_notice_save_failed", error);
  }
}

function tierCard(tier, current) {
  const card = document.createElement("div");
  card.className = `rate-change-tier${current ? " rate-change-tier-current" : ""}`;
  card.append(textElement("span", "rate-change-tier-name", tier.name),
    textElement("span", "rate-change-tier-rate", formatHourlyRate(tier.hourly_rate_cents)));
  return card;
}

function ensureDialog() {
  if (dialog) return dialog;
  // The dim behind the modal. On macOS the title bar takes the color of fixed content at the
  // top of the page, so a ::backdrop would gray it out; an absolutely positioned layer doesn't.
  scrim = textElement("div", "rate-change-scrim", "");
  scrim.setAttribute("aria-hidden", "true");
  scrim.hidden = true;
  dialog = document.createElement("dialog");
  dialog.className = "rate-change-dialog";
  dialog.setAttribute("aria-labelledby", "rate-change-title");
  dialog.setAttribute("aria-describedby", "rate-change-lede rate-change-copy");
  dialog.innerHTML = `
    <h2 id="rate-change-title"></h2>
    <p id="rate-change-lede" class="rate-change-lede" hidden></p>
    <div class="rate-change-tiers"></div>
    <p id="rate-change-copy"></p>
    <button id="rate-change-dismiss" class="btn btn-primary" type="button" autofocus>Got it</button>`;
  dialog.querySelector("#rate-change-dismiss").addEventListener("click", acknowledgeRateNotice);
  // Escape dismisses it the same way, so the next launch does not show it again.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    acknowledgeRateNotice();
  });
  document.body.append(scrim, dialog);
  return dialog;
}

function renderNotice(element, { previous, current, stopped }) {
  const tiers = element.querySelector(".rate-change-tiers");
  const rate = formatHourlyRate(current.hourly_rate_cents);
  element.querySelector("#rate-change-title").textContent = previous ? "You have a new rate" : "Introducing hourly rate tiers";
  const lede = element.querySelector("#rate-change-lede");
  lede.hidden = !!previous;
  // The account's first tier, for someone who has only known the flat rate: their tier up
  // front, then every tier with theirs marked (until the list loads, theirs stands alone).
  const unchanged = current.hourly_rate_cents === FLAT_RATE_CENTS ? ", the same rate as before" : "";
  lede.textContent = previous ? "" : `You’re on ${current.name}: ${rate}${unchanged}.`;
  if (!previous) {
    tiers.replaceChildren(catalog ? tierList("rate-intro", current, { meters: true }) : tierCard(current, true));
    tiers.setAttribute("aria-label", `Your tier: ${current.name}, ${rate}`);
  } else if (paysLike(previous, current)) {
    tiers.replaceChildren(tierCard(current, true));
    tiers.setAttribute("aria-label", `${current.name}, ${rate}`);
  } else {
    const arrow = textElement("span", "rate-change-arrow", "→");
    arrow.setAttribute("aria-hidden", "true");
    tiers.replaceChildren(tierCard(previous, false), arrow, tierCard(current, true));
    tiers.setAttribute("aria-label", `From ${previous.name}, ${formatHourlyRate(previous.hourly_rate_cents)}, to ${current.name}, ${rate}`);
  }
  element.querySelector("#rate-change-copy").textContent = !previous ? TIER_REVIEW_COPY : stopped
    ? `We stopped your recording so each recording is paid at a single rate. It’s saved and will upload as usual. Press Start to keep recording at ${rate}.`
    : `Recordings you start from now on earn ${rate}. Earlier recordings keep the rate they started with.`;
}

function showNotice(notice) {
  const element = ensureDialog();
  // The modal is synced on every layout change; leave one that is already up as it is.
  if (element.open && JSON.stringify(shownNotice) === JSON.stringify(notice)) return;
  renderNotice(element, notice);
  shownNotice = notice;
  scrim.hidden = false;
  if (!element.open) element.showModal();
  if (!notice.previous && !catalog) {
    void loadRateTierCatalog().then(() => {
      if (shownNotice === notice && catalog) renderNotice(element, notice);
    });
  }
}

function closeNotice() {
  shownNotice = null;
  if (scrim) scrim.hidden = true;
  if (dialog?.open) dialog.close();
}

// First-run onboarding introduces tiers on its "Your rate" page. Read from storage, as
// onboarding.js does, so this holds before onboarding has caught up with a new account.
function inFirstRunOnboarding(userId) {
  try {
    return localStorage.getItem(`loggy3-first-recording:${userId}`) !== "complete";
  } catch (_) {
    return false;
  }
}

// Introduces the account's first tier, and shows the modal when the tier no longer pays like
// the last one the person saw, or when a tier change stopped their recording.
export function syncRateNotice() {
  const userId = state.currentUser?.id;
  const current = currentRateTier();
  if (!userId || !current || state.accountBanned || state.logoutInFlight) {
    closeNotice();
    return;
  }
  const saved = readNotice(userId);
  if (saved && paysLike(saved.tier, current) && !saved.stopped) {
    // A rename changes nothing in pay.
    if (saved.tier.name !== current.name) writeNotice(userId, { tier: current, stopped: false });
    closeNotice();
    return;
  }
  // A new contributor who skips the "Your rate" page is introduced once onboarding is over.
  if (!saved && inFirstRunOnboarding(userId)) {
    closeNotice();
    return;
  }
  // main.js syncs again once startup finishes, so the modal never covers the startup screen.
  if (document.body.classList.contains("app-initializing")) return;
  showNotice({ userId, previous: saved?.tier ?? null, current, stopped: !!saved?.stopped });
}

export function acknowledgeRateNotice() {
  const notice = shownNotice;
  // Close before saving, so nothing that goes wrong saving can keep the modal up.
  closeNotice();
  if (notice) writeNotice(notice.userId, { tier: notice.current, stopped: false });
}

// Onboarding's "Your rate" page lists every tier with the account's own, which introduces
// tiers just as the modal would.
export function noteRateTiersIntroduced() {
  const userId = state.currentUser?.id;
  const current = currentRateTier();
  if (userId && current && !readNotice(userId)) writeNotice(userId, { tier: current, stopped: false });
}

// The backend found a new tier, and may have stopped a recording that started at the old
// one. Remember both until the person dismisses the modal.
export function noteRateTierChanged({ user_id: userId, previous, current, recording_stopped: stopped }) {
  const saved = readNotice(userId);
  writeNotice(userId, { tier: saved?.tier || previous, stopped: !!saved?.stopped || !!stopped });
  // The new account status follows this event; show the modal once the app has it.
  if (state.currentUser?.id === userId && paysLike(currentRateTier(), current)) syncRateNotice();
}

window.addEventListener("loggy3-account-access-changed", syncRateNotice);
// Onboarding ending is a layout change; an introduction it skipped can show right away.
window.addEventListener("loggy3-layout-changed", syncRateNotice);
