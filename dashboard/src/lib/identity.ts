/**
 * Who is writing to the audit trail.
 *
 * This was the constant `"dj"`, so every comment, edit, status change and
 * attachment in every install was attributed to one person — the author's own
 * name, shipped in an MIT tool other teams run. The trail is Loopback's trust
 * mechanism; a log that confidently names the wrong person is worse than no log.
 *
 * Loopback has no accounts and should not grow them for this: the hub is a
 * local, single-user dev tool. So identity is a name the human states once and
 * the browser remembers. It is not authentication and does not pretend to be —
 * it is the difference between "someone" and "nobody".
 */
const KEY = "lb-author";

function safeGet(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // private mode
  }
}

function safeSet(value: string): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* private mode — the name just will not persist */
  }
}

/** A stable fallback that is honest about not knowing, rather than guessing. */
export const ANONYMOUS = "unknown-human";

export function getAuthor(): string {
  return safeGet()?.trim() || ANONYMOUS;
}

export function setAuthor(name: string): void {
  const clean = name.trim().slice(0, 40);
  if (clean) safeSet(clean);
}

export function hasAuthor(): boolean {
  return Boolean(safeGet()?.trim());
}
