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
    }).then((r) => (r.ok ? r : Promise.reject(new Error("Comment failed"))));
  },

  setStatus(id: string, status: Status, note: string, author: string): Promise<unknown> {
    return fetch(`/queue/${encodeURIComponent(id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status, note, author }),
    }).then((r) => (r.ok ? r : Promise.reject(new Error("Status change failed"))));
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

/** Status drives colour everywhere; keep the mapping in exactly one place. */
export const statusClass: Record<Status, string> = {
  open: "bg-lb-open text-black/85",
  triaged: "bg-lb-triaged text-black/85",
  in_progress: "bg-lb-in-progress text-white",
  fixed: "bg-lb-fixed text-black/85",
  verified: "bg-lb-verified text-black/85",
  wontfix: "bg-lb-wontfix text-black/85",
};

export const severityClass: Record<Severity, string> = {
  p0: "text-lb-p0",
  p1: "text-lb-p1",
  p2: "text-lb-p2",
  p3: "text-lb-p3",
};
