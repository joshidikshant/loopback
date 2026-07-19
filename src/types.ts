/** Shared type definitions for the Loopback feedback bus. */

export type FeedbackType = "ui" | "backend" | "usage" | "ux";
export type Severity = "p0" | "p1" | "p2" | "p3";
export type Status =
  | "open"
  | "triaged"
  | "in_progress"
  | "fixed"
  | "verified"
  | "wontfix";
export type Source =
  | "manual"
  | "widget"
  | "stagewise"
  | "sentry"
  | "posthog"
  | "jam"
  | "other";
export type Reporter = "human" | "agent" | "system";

export interface NetworkEntry {
  url: string;
  method?: string;
  status?: number;
  ms?: number;
}

export interface ChangeLinks {
  repo?: string;
  branch?: string;
  commit?: string;
  pr_url?: string;
  diff_summary?: string;
}

export interface FeedbackComment {
  id: number;
  created_at: string;
  author: string;
  body: string;
}

export interface FeedbackItem {
  id: string;
  project: string;
  created_at: string;
  updated_at: string;
  source: Source;
  reporter: Reporter;
  type: FeedbackType;
  severity: Severity;
  title: string;
  body: string;
  route?: string;
  url?: string;
  dom_selector?: string;
  screenshot_path?: string;
  replay_url?: string;
  console: string[];
  network: NetworkEntry[];
  repro_steps: string[];
  status: Status;
  assignee_agent?: string;
  resolution?: string;
  links: ChangeLinks;
  /** Free-form context: LLM run ids, automation trace URLs, viewport, outer HTML, etc. */
  extra: Record<string, unknown>;
  comments?: FeedbackComment[];
}

export interface ListResult {
  total: number;
  count: number;
  offset: number;
  items: FeedbackItem[];
  has_more: boolean;
  next_offset?: number;
}

export interface ProjectStats {
  project: string;
  by_status: Record<string, number>;
  total: number;
}

export interface StatsResult {
  total: number;
  projects: ProjectStats[];
}

export interface ClaimResult {
  ok: boolean;
  error?: string;
  item?: FeedbackItem;
}
