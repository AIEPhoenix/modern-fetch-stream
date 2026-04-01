/**
 * Detect whether we are running inside a browser with a real `document`.
 * Returns `false` in Node.js, Deno, Bun, and Web Worker contexts.
 */
function isBrowser() {
  return (
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function"
  );
}

/**
 * Subscribe to page visibility changes in browser environments.
 *
 * When the page becomes hidden, `onHidden` is called so the SSE client can
 * tear down the active connection. When the page becomes visible again,
 * `onVisible` is called to re-establish it.
 *
 * In non-browser environments the function is a no-op: it returns a
 * disposer that does nothing.
 *
 * @returns A function that removes the event listener when called.
 */
export function setupVisibility(
  onHidden: () => void,
  onVisible: () => void,
): () => void {
  if (!isBrowser()) return () => {};

  const handler = () => {
    if (document.hidden) {
      onHidden();
    } else {
      onVisible();
    }
  };

  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
