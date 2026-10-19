/**
 * Which kind of device the webview is running on. The tablet builds (iPadOS,
 * Android) differ from the desktop in two ways the UI has to know about:
 * there is no window chrome to make room for, and the only way a library gets
 * in is the system file picker, whose result is copied into the app's own
 * data directory by `import_library` rather than opened in place.
 *
 * iPadOS reports a Macintosh user agent, so touch points are checked as well.
 */
export const isMobile: boolean =
  typeof navigator !== "undefined" &&
  (/Android|iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
