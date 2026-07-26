/** Typed client for the hub. Same-origin, so no base URL and no CORS dance. */

export type Status =
  | "open"
  | "triaged"
  | "in_progress"
  | "fixed"
  | "verified"
  | "wontfix";
export type Severity = "p0" | "p1" | "p2" | "p3";
export type FeedbackType = "ui" | "backend" | "usage" | "ux";

export const STATUSES: Status[] = [
  "open",
  "triaged",
  "in_progress",
  "fixed",
  "verified",
  "wontfix",
];
export const SEVERITIES: Severity[] = ["p0", "p1", "p2", "p3"];
export const TYPES: FeedbackType[] = ["ui", "backend", "usage", "ux"];

export interface Attachment {
  id: string;
  created_at: string;
  name: string;
  mime: string;
  size: number;
  intent: "reference" | "asset";
  target_path?: string;
  path: string;
  url: string;
}

export interface Comment {
  id: number;
  created_at: string;
  author: string;
  body: string;
}

export interface Item {
  id: string;
  project: string;
  created_at: string;
  updated_at: string;
  source: string;
  reporter: string;
  type: FeedbackType;
  severity: Severity;
  title: string;
  body: string;
  route?: string;
  url?: string;
  dom_selector?: string;
  console: string[];
  network: { url: string; method?: string; status?: number; ms?: number }[];
  repro_steps: string[];
  status: Status;
  assignee_agent?: string;
  resolution?: string;
  links: {
    repo?: string;
    branch?: string;
    commit?: string;
    pr_url?: string;
    diff_summary?: string;
  };
  extra: Record<string, unknown>;
  comments?: Comment[];
  attachments?: Attachment[];
}

export interface ListResult {
  total: number;
  count: number;
  offset: number;
  items: Item[];
  has_more: boolean;
  next_offset?: number;
}

export interface Filters {
  project?: string;
  status?: Status;
  type?: FeedbackType;
  severity?: Severity;
  assignee_agent?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}) as Record<string, unknown>);
    throw new Error(
      (detail as { error?: string }).error ?? `${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * For the form-encoded endpoints, which answer with a redirect rather than JSON.
 * They still say something useful when they refuse, and throwing a fixed string
 * ("Comment failed") threw that away — the user saw a toast that named the
 * action but never the reason.
 */
async function okOrThrow(res: Response, action: string): Promise<Response> {
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  let reason = "";
  try {
    reason = (JSON.parse(text) as { error?: string }).error ?? "";
  } catch {
    reason = text.slice(0, 200).trim();
  }
  throw new Error(reason ? `${action}: ${reason}` : `${action} (${res.status} ${res.statusText})`);
}

export const api = {
  list(filters: Filters, limit = 200): Promise<ListResult> {
    const qs = new URLSearchParams({ limit: String(limit) });
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    return fetch(`/feedback?${qs}`).then(json<ListResult>);
  },

  get(id: string): Promise<Item> {
    return fetch(`/feedback/${encodeURIComponent(id)}`).then(json<Item>);
  },

  update(id: string, patch: Partial<Item> & { author?: string }): Promise<{ item: Item }> {
    return fetch(`/feedback/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<{ item: Item }>(r));
  },

  comment(id: string, body: string, author: string): Promise<unknown> {
    return fetch(`/queue/${encodeURIComponent(id)}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ body, author }),
    }).then((r) => okOrThrow(r, "Comment failed"));
  },

  setStatus(id: string, status: Status, note: string, author: string): Promise<unknown> {
    return fetch(`/queue/${encodeURIComponent(id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status, note, author }),
    }).then((r) => okOrThrow(r, "Status change failed"));
  },

  /**
   * The file IS the body — the hub takes no multipart dependency, so metadata
   * rides in the query string.
   */
  attach(
    id: string,
    file: File,
    opts: { intent: "reference" | "asset"; target?: string; author?: string },
  ): Promise<{ item: Item }> {
    const qs = new URLSearchParams({ name: file.name, intent: opts.intent });
    if (opts.target) qs.set("target", opts.target);
    if (opts.author) qs.set("author", opts.author);
    return fetch(`/feedback/${encodeURIComponent(id)}/attachments?${qs}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }).then((r) => json<{ item: Item }>(r));
  },

  detach(id: string, attachmentId: string): Promise<unknown> {
    return fetch(
      `/feedback/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" },
    ).then(json);
  },
};

export const bytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/**
 * Status drives colour everywhere; keep the mapping in exactly one place.
 *
 * Both halves come from design/tokens.css. The paired `-foreground` token is
 * not decoration — the two themes invert the relationship (light pairs a dark
 * status colour with white text, dark pairs a bright one with near-black), so
 * a literal `text-white`/`text-black` is correct in one theme and fails
 * contrast in the other.
 */
export const statusClass: Record<Status, string> = {
  open: "bg-lb-open text-lb-open-foreground",
  triaged: "bg-lb-triaged text-lb-triaged-foreground",
  in_progress: "bg-lb-in-progress text-lb-in-progress-foreground",
  fixed: "bg-lb-fixed text-lb-fixed-foreground",
  verified: "bg-lb-verified text-lb-verified-foreground",
  wontfix: "bg-lb-wontfix text-lb-wontfix-foreground",
};

export const severityClass: Record<Severity, string> = {
  p0: "text-lb-p0",
  p1: "text-lb-p1",
  p2: "text-lb-p2",
  p3: "text-lb-p3",
};

/**
 * The second axis of the severity scale.
 *
 * All four levels have to clear 4.5:1 against the page background, and once
 * they do they cannot also stay separable by lightness — a compliant p3 lands
 * within 0.01 of p2 in oklch. Weight carries the hierarchy that colour alone
 * can no longer express, which also means severity survives being read in
 * greyscale or by someone who cannot distinguish the hues at all.
 */
export const severityWeight: Record<Severity, string> = {
  p0: "font-bold",
  p1: "font-semibold",
  p2: "font-medium",
  p3: "font-normal",
};
