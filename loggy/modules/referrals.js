// The referral program (loggy3-server/docs/referrals.md): onboarding's code screen, the Referrals
// tab for accounts an operator turned on, a referred account's progress card in the sidebar, and
// the tab's one-time introduction. The program arrives with the uploaded recordings
// (state.referrals, set by uploaded-history.js), and the layout is redrawn whenever they arrive
// (onboarding.js), which renders all of this. Days are UTC days, like pay periods: a bonus is paid
// with the pay period the friend's uploads reached the target in.

import { guidedOnboardingPending, referralCodePending, referralsAvailable, state } from "./state.js";
import { invoke, writeClipboardText } from "./tauri.js";
import { reportUiError } from "./errors.js";
import { setChosenView, updateLayout } from "./views.js";
import { refreshUploadedHistory, reloadUploadedHistory } from "./uploaded-history.js";
import { formatRateAmount, textElement } from "./rates.js";
import { waitingUploadSeconds } from "./sessions.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const get = (id) => document.getElementById(id);
const introKey = (userId) => `loggy3-referrals-intro:${userId}`;
const seenKey = (userId) => `loggy3-referrals-seen:${userId}`;
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// What each account has seen this session. Storage keeps it across launches; this keeps it if
// storage can't, so a dismissed introduction or a cleared badge doesn't come straight back.
const introSeen = new Set();
const badgeSeen = new Map();
const restoreTimers = new WeakMap();
let listKey = null;
let codeStep = "choose";
let howShownEmpty = null;
let dialog = null;
let scrim = null;
let waitingOn = null;
let appView = null;
let introTimer = null;
let introDue = false;
// The pages the introduction may open over: the app itself, past every agreement and setup screen.
const APP_VIEWS = ["sessions", "faq", "referrals"];
const INTRO_DELAY_MS = 3000;

// "Nov 16", the UTC day of `at` (an ISO string or epoch ms).
export function dayLabel(at) {
  return dayFormat.format(new Date(at));
}

// Rounded down, so "20.0" never shows before the target is reached. The allowance keeps a sum of
// recording lengths that lands a hair under a tenth (8.2 h as 29519.999… s) from showing a tenth
// short.
export function hoursLabel(seconds) {
  return (Math.floor(Math.max(0, seconds) / 360 + 1e-6) / 10).toFixed(1);
}

// "$5", or "$5.50".
export function formatBonus(cents) {
  return cents % 100 === 0 ? `$${cents / 100}` : formatRateAmount(cents);
}

// "20 hours", or "1 hour".
export function plural(count, noun) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

// "2 weeks", or "10 days".
export function windowLabel(days) {
  if (days % 7) return plural(days, "day");
  return plural(days / 7, "week");
}

// The payout that pays a pay period's uploads, given a moment in the period: the 15th pays the
// 1st–14th, and the 1st pays the 15th to the end of the month before (UTC).
export function payoutDate(at) {
  const date = new Date(at);
  return date.getUTCDate() <= 14
    ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 15)
    : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

// The last day uploads count toward a referral: it ends at midnight UTC after that day.
function lastDay(referral) {
  return Date.parse(referral.ends_at) - DAY_MS;
}

// An earned bonus stays on screen through the third day after its payout, since Dots takes 1–3
// days to pay, and a missed deadline through the third day after it.
function stillShown(day, now) {
  return now < day + 4 * DAY_MS;
}

// Whether a referred account's sidebar card shows: while its referral counts, then a while after
// the payout that includes its bonus or after a missed deadline. Never once the bonus can't be paid
// (either account banned or moved off self-serve), so it never promises one.
export function cardShowing(referral, now = Date.now()) {
  if (!referral?.eligible) return false;
  if (referral.status === "earned") return stillShown(payoutDate(referral.reached_at), now);
  if (referral.status === "expired") return stillShown(lastDay(referral), now);
  return true;
}

// Each side's bonus from a referrer's code or a referral: { cents }, or { hours } of pay at that
// person's rate when the friend reaches the target.
const bonus = (kind, amount) => (kind === "hours" ? { hours: amount } : { cents: amount });
const referrerBonus = (from) => bonus(from.referrer_bonus_kind, from.referrer_bonus_amount);
const refereeBonus = (from) => bonus(from.referee_bonus_kind, from.referee_bonus_amount);
const sameBonus = (a, b) => (a.cents ?? null) === (b.cents ?? null) && (a.hours ?? null) === (b.hours ?? null);

// "$5 extra" the first time a sentence names an amount, "$5" after; hours read the same either way.
function bonusWords({ cents, hours }, first) {
  if (hours) return `${plural(hours, "bonus hour")} of pay`;
  return first ? `${formatBonus(cents)} extra` : formatBonus(cents);
}

// Both bonuses from the reader's side: "you both get $5 extra", or each when they differ. The
// reader's own hours are paid at their hourly rate.
export function bothGet(yours, theirs, they = "your friend gets") {
  if (sameBonus(yours, theirs)) return `you both get ${bonusWords(yours, true)}`;
  return `you get ${bonusWords(yours, true)}${yours.hours ? " at your hourly rate" : ""} and ${they} ${bonusWords(theirs, false)}`;
}

// The program as the introduction and the tab's How it works both tell it: sharing the code (left
// out once it isn't taking friends), the target, what each side gets, then when that's paid.
function programSteps(referrer, terms, sharing = true) {
  const amounts = bothGet(referrerBonus(referrer), refereeBonus(referrer));
  return {
    steps: [
      ...(sharing ? ["Share your code. Friends enter it during setup, before they record."] : []),
      `Your friend uploads ${plural(terms.target_hours, "hour")} of recordings within ${windowLabel(terms.window_days)} of signing up.`,
      `${amounts[0].toUpperCase()}${amounts.slice(1)}.`,
    ],
    note: `Both bonuses are included in the payout for the pay period in which your friend’s uploads reach `
      + `${plural(terms.target_hours, "hour")}.`,
  };
}

// The referrer's words to a friend, so "we" and "I".
function weBothGet(from) {
  const referrer = referrerBonus(from);
  const referee = refereeBonus(from);
  return sameBonus(referrer, referee)
    ? `we both get ${bonusWords(referee, true)}`
    : `you get ${bonusWords(referee, true)} and I get ${bonusWords(referrer, false)}`;
}

export function inviteMessage(referrer, terms) {
  return `Hey! I’ve been earning with Loggy3: it pays you to record your screen while you use your computer. `
    + `Download it at loggy3.com. While you’re setting it up, it will ask for a referral code: enter ${referrer.code} `
    + `before your first recording, or it won’t count. Once you’ve uploaded ${plural(terms.target_hours, "hour")} of recordings `
    + `in your first ${windowLabel(terms.window_days)}, ${weBothGet(referrer)}, `
    + `included in the payout for whichever pay period you reach ${plural(terms.target_hours, "uploaded hour")} in `
    + `(Loggy3 pays on the 1st and 15th).`;
}

// A nudge for a friend who is still counting, with the payout their bonus would come in if they
// reach the target this pay period.
export function nudgeMessage(friend, now = Date.now()) {
  const left = Math.max(0.1, Math.ceil((friend.target_hours * 3600 - friend.uploaded_seconds) / 360) / 10);
  const periodLastDay = payoutDate(now) - DAY_MS;
  const deadline = lastDay(friend);
  const target = plural(friend.target_hours, "hour");
  const timing = deadline <= periodLastDay
    ? `If your uploads reach ${target} by ${dayLabel(deadline)}, it’s in the ${dayLabel(payoutDate(now))} payout.`
    : `If your uploads reach ${target} by ${dayLabel(periodLastDay)}, it’s in the ${dayLabel(payoutDate(now))} payout. `
      + `You have until ${dayLabel(deadline)}.`;
  return `Hey! You’ve uploaded ${hoursLabel(friend.uploaded_seconds)} of ${target} on Loggy3. `
    + `Just ${left.toFixed(1)} more and ${weBothGet(friend)}. `
    + `${timing} Recordings only count once they’ve finished uploading.`;
}

// Where a friend stands: a label once they've stopped counting ("open" has none), and a line beside it.
// A friend who can't be paid (banned, or moved off self-serve) only shows as not eligible.
export function friendStatus(friend) {
  if (!friend.eligible) return { kind: "ineligible", label: "Not eligible", text: "no bonus" };
  if (friend.status === "earned") {
    return { kind: "earned", label: "Earned",
      text: `${formatBonus(friend.referrer_earned_cents)} in the ${dayLabel(payoutDate(friend.reached_at))} payout` };
  }
  if (friend.status === "expired") {
    return { kind: "expired", label: "Expired", text: `didn’t upload ${friend.target_hours} h by ${dayLabel(lastDay(friend))}` };
  }
  return { kind: "open", label: null,
    text: `${hoursLabel(friend.uploaded_seconds)} of ${friend.target_hours} h uploaded · until ${dayLabel(lastDay(friend))}` };
}

// Each friend with where they stand (friendStatus): friends still counting first, the soonest
// deadline first, then those who earned the bonus, then everyone else. Ties keep the server's
// order, newest first.
const STANDING = { open: 0, earned: 1 };
export function sortFriends(friends) {
  return friends.map((friend) => ({ friend, ...friendStatus(friend) })).sort((a, b) =>
    (STANDING[a.kind] ?? 2) - (STANDING[b.kind] ?? 2)
    || (a.kind === "open" ? Date.parse(a.friend.ends_at) - Date.parse(b.friend.ends_at) : 0));
}

// The figures across the top of the tab: the referrer's bonuses in payouts still to come (listed as
// long as the friend's own card shows them; quiet when there are none), then friends who earned the
// bonus and friends in all. While the code is on, `places` ({ used, cap }) counts the friends holding a
// place instead, since expired and banned friends free theirs.
export function friendsSummary(friends, places, now = Date.now()) {
  const earned = friends.filter((friend) => friend.status === "earned" && friend.eligible);
  const payouts = new Map();
  for (const friend of earned) {
    const date = payoutDate(friend.reached_at);
    if (stillShown(date, now)) payouts.set(date, (payouts.get(date) ?? 0) + friend.referrer_earned_cents);
  }
  const dates = [...payouts.keys()].sort((a, b) => a - b);
  const due = [...payouts.values()].reduce((sum, cents) => sum + cents, 0);
  return {
    due: formatBonus(due),
    dueLabel: dates.length ? `${dates.map(dayLabel).join(" and ")} ${dates.length === 1 ? "payout" : "payouts"}` : "bonuses due",
    quiet: due === 0,
    earned: earned.length,
    friends: places ? places.used : friends.length,
    cap: places?.cap ?? null,
  };
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // At worst the badge or the introduction shows again next launch.
    reportUiError("referrals_storage_failed", error);
  }
}

async function copy(button, text) {
  const label = button.dataset.label ??= button.textContent;
  try {
    await writeClipboardText(text);
    button.textContent = "Copied";
  } catch (error) {
    reportUiError("referrals_copy_failed", error);
    button.textContent = "Copy failed";
  }
  clearTimeout(restoreTimers.get(button));
  restoreTimers.set(button, setTimeout(() => { button.textContent = label; }, 1200));
}

// The newest thing a referrer hasn't seen: a friend entering the code or reaching the target.
function latestEvent(referrer) {
  return Math.max(0, ...referrer.friends.flatMap((friend) =>
    [friend.created_at, friend.reached_at].filter(Boolean).map(Date.parse)));
}

function lastSeen(userId) {
  return Math.max(badgeSeen.get(userId) ?? 0, Number(readStorage(seenKey(userId)) || 0));
}

function markSeen(userId, at) {
  if (at <= lastSeen(userId)) return;
  badgeSeen.set(userId, at);
  writeStorage(seenKey(userId), String(at));
}

// Most people have no code, so the screen asks first. "I don't have one" asks to confirm, since
// that answer is final, and "I have a code" opens the box with what a code means; each can go back
// to the choice ("choose", "none" or "code").
function renderCodeScreen() {
  get("referral-code-choices").hidden = codeStep !== "choose";
  get("referral-code-none-confirm").hidden = codeStep !== "none";
  get("referral-code-form").hidden = codeStep !== "code";
  const terms = state.referrals?.terms;
  const referral = state.referrals?.referral;
  if (!terms) return;
  // No amounts until a code is applied: a referrer can have their own, which only the code says.
  get("referral-code-facts").replaceChildren(...[
    `Upload ${plural(terms.target_hours, "hour")} of recordings within ${windowLabel(terms.window_days)} of signing up`,
    `You both get a bonus, included in the payout for the pay period in which your uploads reach ${plural(terms.target_hours, "hour")}`,
  ].map((line) => textElement("li", "", line)));
  const applied = state.referralCodeApplied;
  get("referral-code-title").textContent = applied ? "Code applied" : "Got a referral code?";
  get("referral-code-ask").hidden = applied;
  get("referral-code-continue").hidden = !applied;
  const message = get("referral-code-applied");
  message.hidden = !applied || !referral;
  message.textContent = applied && referral
    ? `Upload ${plural(referral.target_hours, "hour")} of recordings by ${dayLabel(lastDay(referral))} and `
      + `${bothGet(refereeBonus(referral), referrerBonus(referral))}.`
    : "";
}

async function answerCodeScreen(code) {
  const error = get("referral-code-error");
  // Continue too: until the reload lands, the screen still has the answer from before this one.
  const controls = ["referral-code", "referral-code-apply", "referral-code-back", "referral-code-none", "referral-code-have",
    "referral-code-none-back", "referral-code-skip", "referral-code-continue"].map(get);
  error.hidden = true;
  controls.forEach((control) => { control.disabled = true; });
  try {
    await invoke("submit_referral_code", { code });
    state.referralCodeApplied = code !== null;
  } catch (reason) {
    error.textContent = reason?.message || "Could not save your referral code.";
    error.hidden = false;
  }
  // Whatever the answer, ask the server again, without reusing a request that may predate it: a
  // refusal can mean the screen no longer applies (answered elsewhere, or a lost response).
  await reloadUploadedHistory();
  controls.forEach((control) => { control.disabled = false; });
  renderCodeScreen();
  updateLayout();
}

function renderFriends(referrer, terms) {
  const key = JSON.stringify([referrer, terms]);
  if (key === listKey) return;
  listKey = key;
  get("referrals-empty").hidden = referrer.friends.length > 0;
  get("referrals-friends").replaceChildren(...sortFriends(referrer.friends).map(({ friend, kind, label, text }) => {
    const row = textElement("li", "referrals-friend", "");
    const status = textElement("span", "referrals-friend-status", "");
    row.append(textElement("span", "referrals-friend-email", friend.email), status);
    if (kind !== "open") {
      status.append(textElement("span", `referrals-chip referrals-chip-${kind}`, label), textElement("span", "", text));
      return row;
    }
    const bar = textElement("span", "referrals-progress", "");
    bar.setAttribute("aria-hidden", "true");
    const fill = textElement("span", "", "");
    fill.style.width = `${Math.min(100, friend.uploaded_seconds / (friend.target_hours * 36))}%`;
    bar.append(fill);
    status.append(bar, textElement("span", "", text));
    // Copies a ready-made message; people edit it in whatever they send it with.
    const nudge = textElement("button", "referrals-nudge", "Nudge");
    nudge.type = "button";
    nudge.title = `Copy a reminder for ${friend.email}`;
    nudge.addEventListener("click", () => void copy(nudge, nudgeMessage(friend)));
    row.append(nudge);
    return row;
  }));
}

function renderTab(view) {
  const referrer = state.referrals?.referrer;
  const terms = state.referrals?.terms;
  const userId = state.currentUser?.id;
  if (!referralsAvailable() || !terms || !userId) return;
  if (view === "referrals") markSeen(userId, latestEvent(referrer));
  get("tab-referrals-badge").hidden = latestEvent(referrer) <= lastSeen(userId);
  if (view !== "referrals") return;
  // A turned-off or full code isn't for sharing; the rest still explains the bonus friends can earn.
  const accepting = referrer.active && !referrer.full;
  get("referrals-code-active").hidden = !accepting;
  get("referrals-code-closed").hidden = accepting;
  get("referrals-code-closed-text").textContent = referrer.active
    ? `Your code has reached its limit of ${plural(referrer.max_referrals, "friend")}.`
    : "Your code is no longer accepting new friends.";
  get("referrals-code").textContent = referrer.code;
  get("referrals-code-closed-code").textContent = referrer.code;
  // The card's top row: bonuses due on the left, counts on the right.
  const overview = get("referrals-overview");
  overview.hidden = referrer.friends.length === 0;
  const figures = friendsSummary(referrer.friends,
    referrer.active ? { used: referrer.places_used, cap: referrer.max_referrals } : null);
  const due = textElement("div", figures.quiet ? "referrals-due quiet" : "referrals-due", "");
  due.append(textElement("strong", "", figures.due), textElement("span", "", figures.dueLabel));
  const counts = textElement("div", "referrals-counts", "");
  counts.append(textElement("b", "", String(figures.earned)), " earned · ", textElement("b", "", String(figures.friends)),
    figures.cap ? ` of ${plural(figures.cap, "friend")}` : figures.friends === 1 ? " friend" : " friends");
  overview.replaceChildren(due, counts);
  const { steps, note } = programSteps(referrer, terms, accepting);
  get("referrals-how").replaceChildren(...steps.map((line) => textElement("li", "", line)));
  get("referrals-how-note").textContent = note;
  // Open until someone uses the code, when it's most of what the tab has to say; after that it's
  // the reader's to open or close.
  const empty = referrer.friends.length === 0;
  if (empty !== howShownEmpty) {
    howShownEmpty = empty;
    get("referrals-how-details").open = empty;
  }
  renderFriends(referrer, terms);
}

// A referred account's own progress (cardShowing says how long). The sidebar hides it during
// onboarding, with the rest of the account section.
function renderCard(now = Date.now()) {
  const card = get("sidebar-referral");
  const referral = state.isAuthenticated && state.selfServeUser ? state.referrals?.referral : null;
  card.hidden = !cardShowing(referral, now);
  if (card.hidden) return;
  const ended = referral.status === "expired";
  card.classList.toggle("sidebar-referral-ended", ended);
  // Hours of pay until earned, when they become dollars at this account's rate.
  const { cents, hours } = refereeBonus(referral);
  const amount = referral.status === "earned" ? formatBonus(referral.referee_earned_cents)
    : hours ? `${hours} h` : formatBonus(cents);
  const yours = hours ? `your ${plural(hours, "bonus hour")} of pay ${hours === 1 ? "is" : "are"}` : `your ${amount} is`;
  get("sidebar-referral-amount").textContent = ended ? "" : amount;
  const fill = get("sidebar-referral-fill");
  if (ended) {
    get("sidebar-referral-detail").textContent = `Ended ${dayLabel(lastDay(referral))} · no bonus`;
    fill.style.width = `${Math.min(100, referral.uploaded_seconds / (referral.target_hours * 36))}%`;
    get("sidebar-referral-tooltip").replaceChildren(textElement("p", "",
      `Uploaded ${hoursLabel(referral.uploaded_seconds)} of ${referral.target_hours} h by ${dayLabel(lastDay(referral))}.`));
    return;
  }
  if (referral.status === "earned") {
    const payout = dayLabel(payoutDate(referral.reached_at));
    get("sidebar-referral-detail").textContent = `Earned · ${payout} payout`;
    fill.style.width = "100%";
    get("sidebar-referral-tooltip").replaceChildren(textElement("p", "",
      `Uploaded ${referral.target_hours} h on ${dayLabel(referral.reached_at)}. Your ${amount} is in the ${payout} payout.`));
    return;
  }
  get("sidebar-referral-detail").textContent =
    `${hoursLabel(referral.uploaded_seconds)} of ${referral.target_hours} h · until ${dayLabel(lastDay(referral))}`;
  fill.style.width = `${Math.min(100, referral.uploaded_seconds / (referral.target_hours * 36))}%`;
  const waiting = waitingUploadSeconds();
  const periodLastDay = payoutDate(now) - DAY_MS;
  const deadline = lastDay(referral);
  get("sidebar-referral-tooltip").replaceChildren(textElement("p", "", [
    ...(waiting >= 360 ? [`${hoursLabel(waiting)} h waiting to upload.`] : []),
    deadline <= periodLastDay
      ? `Upload ${referral.target_hours} h by ${dayLabel(deadline)} and ${yours} in the `
        + `${dayLabel(payoutDate(now))} payout.`
      : `Upload ${referral.target_hours} h by ${dayLabel(periodLastDay)} and ${yours} in the `
        + `${dayLabel(payoutDate(now))} payout; after that, the ${dayLabel(payoutDate(periodLastDay + DAY_MS))} payout.`,
    "Recordings count once they finish uploading.",
  ].join(" ")));
}

// Written for whoever reads it: a referred account's own uploads count, a referrer's friends' do, and someone who
// is both reads it about whichever friend was referred.
export function faqAnswer(referring, referred, target) {
  const whose = !referring ? "your" : referred ? "the referred friend’s" : "your friend’s";
  return `In the payout for the pay period in which ${whose} uploaded recordings reach ${plural(target, "hour")}, `
    + `for both of you. Only uploaded recordings count, and each counts once it finishes uploading (UTC): reach `
    + `${plural(target, "uploaded hour")} between the 1st and 14th and the bonus is paid on the 15th; between the 15th `
    + "and the end of the month, on the 1st.";
}

function renderFaq() {
  const referrals = state.referrals;
  const question = get("faq-referrals");
  const referring = referralsAvailable();
  question.hidden = !referring && !referrals?.referral;
  if (question.hidden) return;
  const target = referrals.referral?.target_hours ?? referrals.terms.target_hours;
  question.querySelector(".faq-answer").textContent = faqAnswer(referring, !!referrals.referral, target);
}

function closeIntro() {
  if (scrim) scrim.hidden = true;
  if (dialog?.open) dialog.close();
}

// Introduces the tab once per account, when its code first takes friends and nothing else is up:
// three seconds after the account reaches the app itself, so it never covers Terms, the agreement
// or another setup screen. main.js syncs again once startup finishes, so the delay starts after it.
export function syncReferralsIntro() {
  const userId = state.currentUser?.id;
  const referrer = state.referrals?.referrer;
  if (!userId || !referrer?.active || referrer.full || !referralsAvailable() || guidedOnboardingPending() || state.accountBanned
      || state.logoutInFlight || introSeen.has(userId) || readStorage(introKey(userId)) || !APP_VIEWS.includes(appView)) {
    clearTimeout(introTimer);
    introTimer = null;
    introDue = false;
    closeIntro();
    return;
  }
  if (document.body.classList.contains("app-initializing") || dialog?.open) return;
  if (!introDue) {
    introTimer ??= setTimeout(() => {
      introTimer = null;
      introDue = true;
      syncReferralsIntro();
    }, INTRO_DELAY_MS);
    return;
  }
  // Another modal (a new rate) goes first; this one follows when it closes.
  const other = document.querySelector("dialog[open]");
  if (other) {
    if (waitingOn !== other) other.addEventListener("close", () => { waitingOn = null; syncReferralsIntro(); }, { once: true });
    waitingOn = other;
    return;
  }
  if (!dialog) {
    scrim = textElement("div", "rate-change-scrim", "");
    scrim.setAttribute("aria-hidden", "true");
    dialog = document.createElement("dialog");
    dialog.className = "rate-change-dialog referrals-intro";
    dialog.setAttribute("aria-labelledby", "referrals-intro-title");
    dialog.setAttribute("aria-describedby", "referrals-intro-steps referrals-intro-note");
    dialog.innerHTML = `
      <h2 id="referrals-intro-title">Invite friends to Loggy3 <span class="referrals-intro-new">New</span></h2>
      <ol id="referrals-intro-steps" class="referral-steps"></ol>
      <p id="referrals-intro-note" class="referrals-intro-note"></p>
      <div class="referrals-intro-actions">
        <button id="referrals-intro-later" class="btn" type="button">Not now</button>
        <button id="referrals-intro-open" class="btn btn-primary" type="button" autofocus>Show my code</button>
      </div>`;
    const dismiss = (open) => {
      introSeen.add(state.currentUser?.id);
      writeStorage(introKey(state.currentUser?.id), "seen");
      closeIntro();
      if (open && referralsAvailable()) setChosenView("referrals");
      updateLayout();
    };
    dialog.querySelector("#referrals-intro-later").addEventListener("click", () => dismiss(false));
    dialog.querySelector("#referrals-intro-open").addEventListener("click", () => dismiss(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dismiss(false);
    });
    document.body.append(scrim, dialog);
  }
  const { steps, note } = programSteps(referrer, state.referrals.terms);
  dialog.querySelector("#referrals-intro-steps").replaceChildren(...steps.map((line) => textElement("li", "", line)));
  dialog.querySelector("#referrals-intro-note").textContent = note;
  scrim.hidden = false;
  dialog.showModal();
}

function render(view) {
  appView = view;
  if (referralCodePending()) renderCodeScreen();
  renderTab(view);
  renderCard();
  renderFaq();
  syncReferralsIntro();
}

export function initReferrals() {
  let view = null;
  let accountUser = null;
  const codeInput = get("referral-code");
  const codeError = get("referral-code-error");
  const showStep = (step, focus) => {
    codeStep = step;
    codeError.hidden = true;
    renderCodeScreen();
    get(focus).focus();
  };
  get("referral-code-none").addEventListener("click", () => showStep("none", "referral-code-skip"));
  get("referral-code-none-back").addEventListener("click", () => showStep("choose", "referral-code-none"));
  get("referral-code-skip").addEventListener("click", () => void answerCodeScreen(null));
  get("referral-code-have").addEventListener("click", () => showStep("code", "referral-code"));
  get("referral-code-back").addEventListener("click", () => showStep("choose", "referral-code-have"));
  get("referral-code-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    if (code) {
      void answerCodeScreen(code);
      return;
    }
    codeError.textContent = "Enter the code your friend sent you.";
    codeError.hidden = false;
  });
  codeInput.addEventListener("input", () => { codeError.hidden = true; });
  get("referral-code-continue").addEventListener("click", () => {
    state.referralCodeApplied = false;
    updateLayout();
  });
  state.tabReferrals.addEventListener("click", () => {
    if (!referralsAvailable()) return;
    setChosenView("referrals");
    updateLayout();
    void refreshUploadedHistory({ ifStale: true });
  });
  get("referrals-code-copy").addEventListener("click", (event) => {
    void copy(event.currentTarget, state.referrals?.referrer?.code || "");
  });
  get("referrals-invite-copy").addEventListener("click", (event) => {
    const { referrer, terms } = state.referrals ?? {};
    if (referrer && terms) void copy(event.currentTarget, inviteMessage(referrer, terms));
  });
  window.addEventListener("loggy3-layout-changed", (event) => {
    view = event.detail.view;
    render(view);
  });
  window.addEventListener("loggy3-sessions-changed", () => renderCard());
  window.addEventListener("loggy3-account-access-changed", () => {
    if (state.currentUser?.id === accountUser) return;
    accountUser = state.currentUser?.id ?? null;
    listKey = null;
    codeStep = "choose";
    howShownEmpty = null;
    codeInput.value = "";
    codeError.hidden = true;
  });
}
