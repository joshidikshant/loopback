/** Zod schemas (raw shapes) for Loopback tool inputs and the HTTP /ingest endpoint. */

import { z } from "zod";

export const typeEnum = z.enum(["ui", "backend", "usage", "ux"]);
export const severityEnum = z.enum(["p0", "p1", "p2", "p3"]);
export const statusEnum = z.enum([
  "open",
  "triaged",
  "in_progress",
  "fixed",
  "verified",
  "wontfix",
]);
export const sourceEnum = z.enum([
  "manual",
  "widget",
  "stagewise",
  "sentry",
  "posthog",
  "jam",
  "other",
]);
export const reporterEnum = z.enum(["human", "agent", "system"]);
export const responseFormatEnum = z.enum(["markdown", "json"]);
export const resolutionEnum = z.enum(["verified", "wontfix"]);

export const networkEntrySchema = z.object({
  url: z.string().max(2000).describe("Request URL"),
  method: z.string().max(10).optional().describe("HTTP method"),
  status: z.number().int().optional().describe("HTTP status code"),
  ms: z.number().optional().describe("Duration in milliseconds"),
});

/** Shape for submitting a new feedback item (also validates HTTP POST /ingest bodies). */
export const submitShape = {
  project: z
    .string()
    .min(1)
    .max(100)
    .describe("Project/repo slug this feedback belongs to, e.g. 'appbroda-web'"),
  type: typeEnum.describe(
    "Feedback dimension: 'ui' (visual/design), 'backend' (errors/API), 'usage' (analytics/behavior), 'ux' (flow/experience)",
  ),
  title: z
    .string()
    .min(3)
    .max(200)
    .describe("Short summary, e.g. 'Checkout button dead on mobile Safari'"),
  body: z
    .string()
    .max(10000)
    .default("")
    .describe("Full description of the feedback/observation"),
  severity: severityEnum
    .default("p2")
    .describe("p0=critical, p1=high, p2=normal, p3=nice-to-have"),
  source: sourceEnum
    .default("manual")
    .describe("Where this feedback came from"),
  reporter: reporterEnum.default("human").describe("Who reported it"),
  route: z
    .string()
    .max(500)
    .optional()
    .describe("App route where observed, e.g. '/checkout'"),
  url: z.string().max(2000).optional().describe("Full URL where observed"),
  dom_selector: z
    .string()
    .max(500)
    .optional()
    .describe("CSS selector of the affected element"),
  screenshot_path: z
    .string()
    .max(1000)
    .optional()
    .describe("Path or URL of a screenshot"),
  replay_url: z
    .string()
    .max(2000)
    .optional()
    .describe("Session replay link (e.g. PostHog replay URL)"),
  console: z
    .array(z.string().max(2000))
    .max(50)
    .default([])
    .describe("Recent console log lines relevant to the issue"),
  network: z
    .array(networkEntrySchema)
    .max(50)
    .default([])
    .describe("Relevant network requests (url, method, status, ms)"),
  repro_steps: z
    .array(z.string().max(500))
    .max(30)
    .default([])
    .describe("Steps to reproduce"),
  extra: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      "Free-form context object: LLM run ids/model/trace URLs for AI features, automation run metadata, viewport, element HTML snippet, etc.",
    ),
};

export const submitSchema = z.object(submitShape);
export type SubmitInput = z.infer<typeof submitSchema>;

export const listShape = {
  project: z
    .string()
    .optional()
    .describe("Filter by project slug; omit for all projects"),
  route: z
    .string()
    .optional()
    .describe("Filter by app route where observed, e.g. '/checkout'"),
  status: statusEnum.optional().describe("Filter by status"),
  type: typeEnum.optional().describe("Filter by feedback type"),
  severity: severityEnum.optional().describe("Filter by severity"),
  source: sourceEnum.optional().describe("Filter by source"),
  assignee_agent: z
    .string()
    .optional()
    .describe("Filter by claiming agent, e.g. 'claude-code'"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Maximum results to return"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip (pagination)"),
  response_format: responseFormatEnum
    .default("markdown")
    .describe("'markdown' for human-readable, 'json' for machine-readable"),
};

export const listSchema = z.object(listShape);
export type ListInput = z.infer<typeof listSchema>;

export const idShape = {
  id: z.string().min(1).describe("Feedback id, e.g. 'fb_mabc12_3f9a1c'"),
};

export const getShape = {
  ...idShape,
  response_format: responseFormatEnum
    .default("markdown")
    .describe("'markdown' for human-readable, 'json' for machine-readable"),
};

export const claimShape = {
  ...idShape,
  agent: z
    .string()
    .min(1)
    .max(100)
    .describe("Name of the claiming agent, e.g. 'claude-code', 'codex', 'gemini'"),
  force: z
    .boolean()
    .default(false)
    .describe("Take over even if another agent already claimed the item"),
};

export const updateStatusShape = {
  ...idShape,
  status: statusEnum.describe(
    "New status. Workflow: open → triaged → in_progress → fixed → verified | wontfix",
  ),
  note: z
    .string()
    .max(5000)
    .optional()
    .describe("Optional note recorded as a comment alongside the change"),
  author: z
    .string()
    .max(100)
    .default("agent")
    .describe("Who is making the change (for the audit trail)"),
};

export const addCommentShape = {
  ...idShape,
  author: z.string().min(1).max(100).describe("Comment author, e.g. 'claude-code' or 'dj'"),
  body: z.string().min(1).max(10000).describe("Comment text (markdown ok)"),
};

export const linkChangeShape = {
  ...idShape,
  repo: z.string().max(300).optional().describe("Repository, e.g. 'dj/appbroda-web'"),
  branch: z.string().max(200).optional().describe("Branch name of the fix"),
  commit: z.string().max(100).optional().describe("Commit SHA of the fix"),
  pr_url: z.string().max(1000).optional().describe("Pull request URL"),
  diff_summary: z
    .string()
    .max(5000)
    .optional()
    .describe("One-paragraph summary of what changed"),
};

export const resolveShape = {
  ...idShape,
  resolution: resolutionEnum.describe(
    "'verified' = fix confirmed against the running app/metric; 'wontfix' = intentionally not addressing",
  ),
  note: z
    .string()
    .max(5000)
    .optional()
    .describe("Optional closing note recorded as a comment"),
};

export const statsShape = {
  project: z
    .string()
    .optional()
    .describe("Limit stats to one project; omit for all projects"),
};
