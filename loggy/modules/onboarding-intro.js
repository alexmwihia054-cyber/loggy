import { onboardingIntroPending, state } from "./state.js";
import { openExternalUrl } from "./tauri.js";
import { reportUiError } from "./errors.js";
import { currentRateTier, formatRateAmount, loadRateTierCatalog, noteRateTiersIntroduced, rateTierCatalog, textElement } from "./rates.js";
import { setOnboardingIntroStep } from "./onboarding.js";
import { updateLayout } from "./views.js";

const pages = [
  {
    label: 'Meet Loggy3',
    title: 'Welcome to Loggy3!',
    copy: 'Work, play or browse as you normally would. Earn for the time you’re actively using your computer while recording.',
    detailTitle: 'What gets recorded',
    detail: 'Loggy3 captures your screen, computer inputs and metadata. You decide when to start and stop.',
    icon: '<rect x="3" y="4" width="26" height="18" rx="3"/><path d="M11 28h10M16 22v6M9 10h7M9 14h4"/><path d="m21 14 7 4-4 1-1 4z" fill="currentColor" stroke="none"/>',
  },
  {
    label: 'Why you earn',
    title: 'Help teach AI to use computers',
    copy: 'AI learns from real examples. Your recordings show how people navigate apps and complete everyday tasks.',
    detailTitle: 'Why we pay you',
    detail: 'This training data is valuable, so you’re compensated for the active recording time you contribute.',
    icon: '<rect x="7" y="8" width="18" height="18" rx="5"/><path d="M16 3v5M11 3v2M21 3v2M3 13h4M3 21h4M25 13h4M25 21h4M11 26v3M21 26v3"/><circle cx="12" cy="15" r="1" fill="currentColor"/><circle cx="20" cy="15" r="1" fill="currentColor"/><path d="M12 20q4 3 8 0"/>',
  },
  {
    label: 'Your rate',
    title: 'Your hourly rate',
    copy: 'Your tier sets what you earn per hour. New contributors start on Basic, and the app lets you know whenever your rate changes.',
    tiers: true,
    note: 'Each recording keeps the rate it started at. Up to 10 paid hours per UTC day.',
    icon: '<path d="M4 27h24"/><rect x="5" y="19" width="4" height="8" rx="1"/><rect x="11.5" y="14" width="4" height="13" rx="1"/><rect x="18" y="9" width="4" height="18" rx="1"/><rect x="24.5" y="4" width="3.5" height="23" rx="1"/>',
  },
  {
    label: 'Getting paid',
    title: 'Paid on the 1st and 15th',
    copy: 'Payments are processed on the 1st and 15th of each month through our payment provider, <a href="https://usedots.com/">Dots</a>. Expect 1–3 days for processing.',
    steps: ['Check your email for a payout link.', 'Enter your payment details securely.', 'Choose your withdrawal method.'],
    note: 'Withdrawal options include GCash, PayMaya, GrabPay, M-Pesa, UPI, PayPal, AirTM, and Payoneer. Availability varies by country.',
    icon: '<rect x="3" y="6" width="26" height="21" rx="3"/><path d="m4 8 12 9L28 8"/><circle cx="25" cy="24" r="6" fill="white"/><path d="m22 24 2 2 4-4"/>',
  },
];

let section;
let displayedStep = null;
let outgoingContent;

// Lays the tiers out as a ladder, cheapest to highest, and marks the account's own. Until
// the list loads, the page shows only its explanation. The intro re-renders on every layout
// change, so the ladder is rebuilt (and its bars rise again) only when its contents change.
function renderRateTiers() {
  const list = section.querySelector('#onboarding-intro-tiers');
  const page = pages[state.onboardingIntroStep];
  const rateTiers = rateTierCatalog();
  list.hidden = !page?.tiers || !rateTiers;
  if (list.hidden) return;
  const own = currentRateTier()?.tier;
  // Seeing every tier with their own here introduces tiers, so no modal repeats it later.
  if (own) noteRateTiersIntroduced();
  const renderKey = JSON.stringify([own, rateTiers]);
  if (list.dataset.renderKey === renderKey) return;
  list.dataset.renderKey = renderKey;
  list.style.setProperty('--tier-count', rateTiers.length);
  list.replaceChildren(...rateTiers.map((tier, index) => {
    const column = document.createElement('li');
    column.className = 'onboarding-intro-tier';
    column.classList.toggle('onboarding-intro-tier-own', tier.tier === own);
    column.style.setProperty('--tier-index', index);
    column.style.setProperty('--tier-level', (index + 1) / rateTiers.length);
    if (tier.tier === own) column.append(textElement('span', 'onboarding-intro-tier-badge', 'Your tier'));
    const track = textElement('span', 'onboarding-intro-tier-track', '');
    track.setAttribute('aria-hidden', 'true');
    track.append(textElement('span', 'onboarding-intro-tier-bar', ''));
    const rate = textElement('span', 'onboarding-intro-tier-rate', formatRateAmount(tier.hourly_rate_cents));
    rate.append(textElement('span', '', '/hour'));
    column.append(track, textElement('span', 'onboarding-intro-tier-name', tier.name), rate);
    return column;
  }));
}

export function initOnboardingIntro() {
  window.addEventListener("loggy3-layout-changed", () => {
    const visible = onboardingIntroPending();
    document.body.classList.toggle("onboarding-intro-active", visible);
    if (!visible) {
      if (section) section.hidden = true;
      outgoingContent?.remove();
      outgoingContent = null;
      displayedStep = null;
      return;
    }
    renderIntro();
  });
}

function renderIntro() {
  if (!section) {
    section = document.createElement('section');
    section.id = 'onboarding-intro';
    section.setAttribute('aria-label', 'Welcome to Loggy3');
    section.innerHTML = `
      <button class="onboarding-intro-signout" type="button">Sign out</button>
      <article class="auth-card onboarding-intro-card">
        <ol class="onboarding-intro-progress" aria-label="Welcome progress">
          ${pages.map(page => `<li><button type="button"><span class="onboarding-intro-step-label"><svg aria-hidden="true" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${page.icon}</svg>${page.label}</span></button></li>`).join('')}
        </ol>
        <div class="onboarding-intro-pages">
          <div class="onboarding-intro-content" aria-live="polite">
            <h1 id="onboarding-intro-title" tabindex="-1"></h1>
            <p id="onboarding-intro-copy"></p>
            <div class="onboarding-intro-detail"><h2 id="onboarding-intro-detail-title"></h2><p id="onboarding-intro-detail-copy"></p></div>
            <ol id="onboarding-intro-tiers" class="onboarding-intro-tiers" aria-label="Hourly rate tiers" hidden></ol>
            <ol id="onboarding-intro-payment-steps" class="onboarding-intro-payment-steps" hidden></ol>
            <p id="onboarding-intro-note" class="onboarding-intro-note" hidden></p>
          </div>
        </div>
        <button id="onboarding-intro-next" class="btn btn-primary" type="button">Continue</button>
      </article>`;
    document.querySelector('.main-panel').append(section);
    section.querySelector('.onboarding-intro-signout').onclick = () => document.getElementById('logout-btn').click();
    section.querySelectorAll('.onboarding-intro-progress button').forEach((button, index) => {
      button.onclick = () => {
        if (!onboardingIntroPending() || state.logoutInFlight || index === state.onboardingIntroStep) return;
        setOnboardingIntroStep(index);
        updateLayout();
      };
    });
    section.querySelector('#onboarding-intro-next').onclick = () => {
      if (!onboardingIntroPending() || state.logoutInFlight) return;
      if (state.onboardingIntroStep < pages.length - 1) {
        setOnboardingIntroStep(state.onboardingIntroStep + 1);
        updateLayout();
        return;
      }
      const userId = state.currentUser.id;
      section.inert = true;
      const exit = section.animate(
        [{opacity: 1}, {opacity: 0}],
        {duration: 140, easing: 'ease-out', fill: 'forwards'},
      );
      exit.onfinish = () => {
        section.inert = false;
        exit.cancel();
        if (!onboardingIntroPending() || state.logoutInFlight || state.currentUser?.id !== userId
            || state.onboardingIntroStep !== pages.length - 1) return;
        setOnboardingIntroStep(null);
        updateLayout();
      };
    };
    section.addEventListener('click', event => {
      const link = event.target.closest('a');
      if (!link) return;
      event.preventDefault();
      void openExternalUrl(link.href).catch(error => reportUiError("payment_provider_link_open_failed", error));
    });
  }
  section.hidden = false;
  void loadRateTierCatalog().then(() => {
    if (section && !section.hidden) renderRateTiers();
  });
  section.querySelector('.onboarding-intro-signout').disabled = state.logoutInFlight || state.authTransitionBusyCount > 0;
  section.querySelector('#onboarding-intro-next').disabled = state.logoutInFlight;
  section.querySelectorAll('.onboarding-intro-progress button').forEach(button => {
    button.disabled = state.logoutInFlight;
  });
  if (displayedStep === state.onboardingIntroStep) return;
  const content = section.querySelector('.onboarding-intro-content');
  const viewport = section.querySelector('.onboarding-intro-pages');
  const previousHeight = getComputedStyle(viewport).height;
  const previousOpacity = getComputedStyle(content).opacity;
  content.getAnimations().forEach(animation => animation.cancel());
  viewport.getAnimations().forEach(animation => animation.cancel());
  outgoingContent?.getAnimations().forEach(animation => animation.cancel());
  outgoingContent?.remove();
  outgoingContent = null;
  if (displayedStep !== null) {
    outgoingContent = content.cloneNode(true);
    outgoingContent.classList.add('onboarding-intro-outgoing');
    outgoingContent.setAttribute('aria-hidden', 'true');
    outgoingContent.removeAttribute('aria-live');
    outgoingContent.inert = true;
    outgoingContent.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  }
  const page = pages[state.onboardingIntroStep];
  section.querySelectorAll('.onboarding-intro-progress button').forEach((item, index) => {
    item.dataset.progress = index < state.onboardingIntroStep ? 'complete' : index === state.onboardingIntroStep ? 'current' : 'next';
    item.setAttribute('aria-current', index === state.onboardingIntroStep ? 'step' : 'false');
  });
  section.querySelector('#onboarding-intro-title').textContent = page.title;
  section.querySelector('#onboarding-intro-copy').innerHTML = page.copy;
  section.querySelector('.onboarding-intro-detail').hidden = !!page.steps || !!page.tiers;
  section.querySelector('#onboarding-intro-detail-title').textContent = page.detailTitle || '';
  section.querySelector('#onboarding-intro-detail-copy').textContent = page.detail || '';
  section.querySelector('#onboarding-intro-payment-steps').hidden = !page.steps;
  section.querySelector('#onboarding-intro-payment-steps').innerHTML = page.steps?.map(step => `<li>${step}</li>`).join('') || '';
  section.querySelector('#onboarding-intro-note').hidden = !page.note;
  section.querySelector('#onboarding-intro-note').textContent = page.note || '';
  renderRateTiers();
  section.querySelector('#onboarding-intro-next').textContent = state.onboardingIntroStep === pages.length - 1 ? 'Continue to Terms & Privacy' : 'Continue';
  const timing = {duration: 650, easing: 'cubic-bezier(.45,0,.25,1)'};
  if (outgoingContent) {
    const outgoing = outgoingContent;
    viewport.append(outgoing);
    outgoing.animate(
      [{opacity: previousOpacity}, {opacity: 0}],
      {duration: 260, easing: 'ease-out', fill: 'forwards'},
    ).onfinish = () => outgoing.remove();
    viewport.animate([{height: previousHeight}, {height: getComputedStyle(content).height}], timing);
  }
  content.animate(
    [{opacity: 0}, {opacity: 1}],
    {duration: displayedStep === null ? 500 : 455, delay: displayedStep === null ? 0 : 60,
      easing: 'ease-in-out', fill: 'backwards'},
  );
  if (displayedStep !== null) section.querySelector('#onboarding-intro-title').focus({preventScroll: true});
  displayedStep = state.onboardingIntroStep;
}
