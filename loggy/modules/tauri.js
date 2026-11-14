// The one place the Tauri global is touched; everything else imports native bindings here.
export const { invoke } = window.__TAURI__.core;
export const { listen } = window.__TAURI__.event;
export const { writeText: writeClipboardText } = window.__TAURI__.clipboardManager;
export const { openUrl: openExternalUrl } = window.__TAURI__.opener;
