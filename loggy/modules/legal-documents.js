// The Terms, Privacy Notice and Recording Consent come from the server, with their versions and
// this account's acceptance records. The server decides which version is current; the app shows
// that text and accepts exactly the version it showed.
import { reportUiError } from "./errors.js";
import { invoke, openExternalUrl } from "./tauri.js";

let loaded = null;

// { terms, privacy, recording_consent }, each { version, html, accepted, previously_accepted }.
export async function fetchLegalDocuments() {
  const { documents } = await invoke("get_legal_documents");
  loaded = documents;
  return documents;
}

// A document from the last successful fetch, or null before one.
export function loadedLegalDocument(name) {
  return loaded?.[name] ?? null;
}

// `versions` maps each document to the version that was shown.
export async function acceptLegalDocuments(versions) {
  const documents = Object.entries(versions).map(([document, version]) => {
    if (!version) {
      throw new Error("The documents haven’t loaded yet. Check your connection and try again.");
    }
    return { document, version };
  });
  await invoke("accept_legal_documents", { documents });
}

// A document's links open in the browser, never inside the app, and only https ones.
export function openLinksExternally(container, failure) {
  container.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || !container.contains(anchor)) return;
    event.preventDefault();
    const url = new URL(anchor.getAttribute("href"), window.location.href);
    if (url.protocol !== "https:") {
      reportUiError("legal_link_rejected", `Unsupported legal link: ${url.protocol}`);
      return;
    }
    openExternalUrl(url.href).catch((error) => reportUiError(failure, error));
  });
}

// The app's pages can call its native commands, so a document from the server keeps only plain
// formatting: no scripts, styles, frames, event handlers or other attributes, and links only to
// https addresses. Elements not listed here are unwrapped, keeping their words.
const KEPT_ELEMENTS = new Set([
  "h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em", "b", "i", "a", "span", "br",
]);
const DROPPED_ELEMENTS = new Set([
  "script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math",
  "textarea", "select", "title",
]);
// The consent's lead-in paragraphs are laid out without the (a), (b) label column.
const KEPT_CLASSES = new Set(["recording-consent-intro"]);
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function httpsUrl(value) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function copyFormatting(source, target) {
  for (const node of source.childNodes) {
    if (node.nodeType === TEXT_NODE) {
      target.append(node.data);
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE || DROPPED_ELEMENTS.has(node.localName)) continue;
    if (!KEPT_ELEMENTS.has(node.localName)) {
      copyFormatting(node, target);
      continue;
    }
    const element = document.createElement(node.localName);
    if (node.localName === "a") {
      const href = httpsUrl(node.getAttribute("href"));
      if (href) element.setAttribute("href", href);
    }
    const classes = (node.getAttribute("class") ?? "").split(/\s+/)
      .filter((name) => KEPT_CLASSES.has(name));
    if (classes.length > 0) element.className = classes.join(" ");
    copyFormatting(node, element);
    target.append(element);
  }
}

// The document's HTML, parsed without running anything and rebuilt from the formatting kept above.
export function legalDocumentFragment(html) {
  const fragment = document.createDocumentFragment();
  copyFormatting(new DOMParser().parseFromString(html, "text/html").body, fragment);
  return fragment;
}
