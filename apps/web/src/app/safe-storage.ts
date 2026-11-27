/*
 * localStorage that never throws: a page whose storage is blocked (a sandboxed frame without
 * allow-same-origin, a browser blocking all site data, a full quota) reads nothing and keeps
 * nothing, instead of failing the panel that asked.
 */

/** The value stored under `key`, null when there is none or storage is blocked. */
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` under `key` (null removes it); does nothing when storage is blocked or full. */
export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked or full */
  }
}
