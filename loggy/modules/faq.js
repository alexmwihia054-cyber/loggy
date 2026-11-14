import { reportUiError } from "./errors.js";
import { state } from "./state.js";
import { openExternalUrl } from "./tauri.js";
import { setChosenView, updateLayout } from "./views.js";

export function initFaq() {
  const list = state.faqSection.querySelector(".faq-list");
  const frame = state.faqSection.querySelector(".faq-scroll-frame");
  const questions = Array.from(list.querySelectorAll("details"));
  const animations = new Map();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function updateScrollEdges() {
    frame.classList.toggle("has-more-above", list.clientHeight > 0 && list.scrollTop > 1);
    frame.classList.toggle("has-more-below", list.clientHeight > 0
      && list.scrollHeight - list.clientHeight - list.scrollTop > 1);
  }
  list.addEventListener("scroll", updateScrollEdges, { passive: true });
  const observer = new ResizeObserver(updateScrollEdges);
  observer.observe(list);
  questions.forEach(question => observer.observe(question));

  function revealQuestion(question) {
    const item = question.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    if (item.top < box.top) list.scrollTop -= box.top - item.top;
    else if (item.bottom > box.bottom) {
      list.scrollTop += Math.min(item.bottom - box.bottom + 8, item.top - box.top);
    }
  }

  function setExpanded(question, expanded) {
    const summary = question.querySelector("summary");
    const startHeight = question.getBoundingClientRect().height;
    animations.get(question)?.cancel();
    animations.delete(question);
    question.dataset.expanded = String(expanded);
    summary.setAttribute("aria-expanded", String(expanded));
    question.open = true;
    question.style.height = "";
    const endHeight = expanded
      ? question.getBoundingClientRect().height
      : summary.getBoundingClientRect().height + parseFloat(getComputedStyle(question).borderBottomWidth);
    const finish = () => {
      question.open = expanded;
      question.style.height = "";
      animations.delete(question);
      if (expanded) revealQuestion(question);
    };
    if (reducedMotion.matches || Math.abs(startHeight - endHeight) < 1) {
      finish();
      return;
    }
    question.style.height = `${startHeight}px`;
    const animation = question.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    animations.set(question, animation);
    animation.onfinish = finish;
  }

  questions.forEach(question => {
    question.dataset.expanded = String(question.open);
    const summary = question.querySelector("summary");
    summary.setAttribute("aria-expanded", String(question.open));
    summary.addEventListener("click", event => {
      event.preventDefault();
      const expanded = question.dataset.expanded !== "true";
      if (expanded) questions.forEach(other => {
        if (other !== question && other.dataset.expanded === "true") setExpanded(other, false);
      });
      setExpanded(question, expanded);
    });
  });

  list.querySelectorAll("a").forEach(anchor => {
    anchor.addEventListener("click", event => {
      event.preventDefault();
      openExternalUrl(anchor.href)
        .catch(error => reportUiError("faq_link_open_failed", error));
    });
  });
  state.tabFaq.addEventListener("click", () => {
    if (!state.isAuthenticated || !state.selfServeUser) return;
    setChosenView("faq");
    updateLayout();
  });
  updateScrollEdges();
}
