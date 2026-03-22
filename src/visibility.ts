const isBrowser =
  typeof document !== 'undefined' &&
  typeof document.addEventListener === 'function'

/**
 * Subscribe to page visibility changes in browser environments.
 * Returns a no-op dispose function in Node.js, Deno, and Bun.
 *
 * @returns A function that removes the event listener when called.
 */
export function setupVisibility(
  onHidden: () => void,
  onVisible: () => void,
): () => void {
  if (!isBrowser) return () => {}

  const handler = () => {
    if (document.hidden) {
      onHidden()
    } else {
      onVisible()
    }
  }

  document.addEventListener('visibilitychange', handler)
  return () => document.removeEventListener('visibilitychange', handler)
}
