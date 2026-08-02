/** MCP server definition: nine loopback_* tools over the feedback store. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LoopbackStore } from "./store.js";
import { z } from "zod";
import {
  addCommentShape,
  claimShape,
  feedbackItemShape,
  getShape,
  idShape,
  linkChangeShape,
  listResultShape,
  listShape,
  resolveShape,
  statsResultShape,
  statsShape,
  submitShape,
  updateShape,
  updateStatusShape,
} from "./schemas.js";
import { itemMarkdown, listMarkdown } from "./format.js";
import type { FeedbackItem } from "./types.js";

export const SERVER_VERSION = "0.9.2";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function notFound(id: string): ToolResult {
  return err(
    `Feedback '${id}' not found. Use loopback_list_feedback to see valid ids.`,
  );
}

function itemJson(item: FeedbackItem): Record<string, unknown> {
  return item as unknown as Record<string, unknown>;
}

/**
 * Tool inputs are STRICT: an unknown key is an error, not something to drop.
 *
 * Zod's default is to silently strip unknown keys, which turns an agent's typo
 * into a quiet wrong answer — `sevrity: "p0"` filed a p2 and reported success
 * (reproduced through the MCP Inspector). Strict objects also emit
 * `additionalProperties: false` into the published JSON Schema, so a client can
 * catch the mistake before the call is even made.
 *
 * The HTTP /ingest boundary deliberately stays permissive: an older hub must
 * not reject a newer widget's payload. Different contract, different rule.
 */
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export function buildServer(store: LoopbackStore): McpServer {
  const server = new McpServer({
    name: "loopback-mcp-server",
    version: SERVER_VERSION,
  });

  server.registerTool(
    "loopback_submit_feedback",
    {
      title: "Submit feedback",
      description: `Create a new feedback item in the Loopback bus.

Use this to file any observation about a running product: a UI defect, a backend error, a usage insight, or a UX papercut. Every item is tagged to a project so the right agent picks it up later.

Args: project (slug), type (ui|backend|usage|ux), title, and optionally body, severity (p0-p3, default p2), source, reporter, route, url, dom_selector, screenshot_path, replay_url, console[], network[], repro_steps[].

Returns the created item as JSON, including its generated id (fb_...). New items start with status 'open'.

Example: file "Pay button dead on iOS Safari" with project='shop-web', type='ui', severity='p1', route='/checkout'.`,
      inputSchema: strict(submitShape),
      outputSchema: feedbackItemShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const item = store.submit(args);
      return ok(
        `Created ${item.id} in '${item.project}' (status: open).\n\n` +
          JSON.stringify(item, null, 2),
        itemJson(item),
      );
    },
  );

  server.registerTool(
    "loopback_list_feedback",
    {
      title: "List feedback",
      description: `List feedback items, filtered and paginated. This is the entry point for "work the queue".

Args (all optional): project, status (open|triaged|in_progress|fixed|verified|wontfix), type (ui|backend|usage|ux), severity (p0-p3), source, assignee_agent, limit (default 20), offset (default 0), response_format (markdown|json).

Returns items ordered most-severe first, then newest. Pagination metadata: total, count, offset, has_more, next_offset.

Typical agent flow: loopback_list_feedback(project='X', status='open') → loopback_claim_feedback → fix → loopback_link_change → loopback_update_status(status='fixed').`,
      inputSchema: strict(listShape),
      outputSchema: listResultShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { response_format, ...filters } = args;
      const result = store.list(filters);
      const structured = result as unknown as Record<string, unknown>;
      if (response_format === "json") {
        return ok(JSON.stringify(result, null, 2), structured);
      }
      return ok(listMarkdown(result), structured);
    },
  );

  server.registerTool(
    "loopback_get_feedback",
    {
      title: "Get feedback item",
      description: `Fetch one feedback item with full context: description, repro steps, console lines, network entries, screenshot/replay links, linked change (commit/PR), and the complete comment trail.

Args: id (fb_...), response_format (markdown|json).

Read this before starting a fix — it contains everything captured at report time.`,
      inputSchema: strict(getShape),
      outputSchema: feedbackItemShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, response_format }) => {
      const item = store.get(id);
      if (!item) return notFound(id);
      if (response_format === "json") {
        return ok(JSON.stringify(item, null, 2), itemJson(item));
      }
      return ok(itemMarkdown(item), itemJson(item));
    },
  );

  server.registerTool(
    "loopback_claim_feedback",
    {
      title: "Claim feedback item",
      description: `Atomically claim a feedback item for an agent before working on it. Prevents two agents from fixing the same thing.

Args: id, agent (your name, e.g. 'claude-code', 'codex', 'gemini'), force (default false).

On success the item's assignee_agent is set and status moves to 'in_progress' (from open/triaged). If another agent already holds the claim, this fails with a message naming the holder — pass force=true only if you intend to take over.`,
      inputSchema: strict(claimShape),
      outputSchema: feedbackItemShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, agent, force }) => {
      const result = store.claim(id, agent, force);
      if (!result.ok || !result.item) {
        return err(result.error ?? "Claim failed.");
      }
      return ok(
        `Claimed ${id} for '${agent}' (status: ${result.item.status}).`,
        itemJson(result.item),
      );
    },
  );

  server.registerTool(
    "loopback_update_status",
    {
      title: "Update feedback status",
      description: `Move a feedback item through the workflow: open → triaged → in_progress → fixed → verified | wontfix.

Args: id, status, note (optional — recorded as a comment for the audit trail), author (default 'agent').

Use 'fixed' after making the change; use loopback_resolve_feedback for final verified/wontfix closure.`,
      inputSchema: strict(updateStatusShape),
      outputSchema: feedbackItemShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, status, note, author }) => {
      // `verified`/`wontfix` are resolutions, not plain status writes: they
      // must go through resolve() so `resolution` is recorded. Without this a
      // pin reached full green with resolution NULL over MCP, while the HTTP
      // route guarded the same transition.
      const item =
        status === "verified" || status === "wontfix"
          ? store.resolve(id, status, note, author)
          : store.updateStatus(id, status, note, author);
      if (!item) return notFound(id);
      return ok(`Updated ${id} → ${status}.`, itemJson(item));
    },
  );

  server.registerTool(
    "loopback_add_comment",
    {
      title: "Comment on feedback",
      description: `Append a comment to a feedback item's discussion trail. Use for investigation notes, questions back to the reporter, or reasoning worth preserving.

Args: id, author, body (markdown ok).`,
      inputSchema: strict(addCommentShape),
      outputSchema: feedbackItemShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, author, body }) => {
      const item = store.addComment(id, author, body);
      if (!item) return notFound(id);
      return ok(
        `Comment added to ${id} (${item.comments?.length ?? 0} total).`,
        itemJson(item),
      );
    },
  );

  server.registerTool(
    "loopback_link_change",
    {
      title: "Link code change",
      description: `Attach the fix to a feedback item so the loop is auditable: which repo/branch/commit/PR addressed it and a one-paragraph diff summary.

Args: id, plus any of repo, branch, commit, pr_url, diff_summary. Provided fields merge into existing links.

Call this right after committing the fix, before updating status to 'fixed'.`,
      inputSchema: strict(linkChangeShape),
      outputSchema: feedbackItemShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, ...links }) => {
      const item = store.linkChange(id, links);
      if (!item) return notFound(id);
      return ok(
        `Linked change to ${id}: ${JSON.stringify(item.links)}.`,
        itemJson(item),
      );
    },
  );

  server.registerTool(
    "loopback_resolve_feedback",
    {
      title: "Resolve feedback",
      description: `Close a feedback item with a final outcome.

Args: id, resolution ('verified' = the fix was confirmed against the running app, tests, or the relevant metric/replay; 'wontfix' = intentionally not addressing), note (optional closing comment), agent (YOUR name — this is the write that turns the reporter's pin full green, and omitting it records the generic default instead of you).

Prefer verifying before resolving: re-check the UI via your browser tools, or confirm the error/metric cleared, then call this.`,
      inputSchema: strict(resolveShape),
      outputSchema: feedbackItemShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, resolution, note, agent }) => {
      const item = store.resolve(id, resolution, note, agent);
      if (!item) return notFound(id);
      return ok(`Resolved ${id} as ${resolution}.`, itemJson(item));
    },
  );

  server.registerTool(
    "loopback_update_feedback",
    {
      title: "Edit feedback item",
      description: `Correct an item after it was filed: title, body, severity, type, project, or route.

Feedback is filed fast and imprecisely on purpose — that is what makes people file it at all. Use this to re-rank a severity you now understand, fix a mis-guessed type, correct a typo, or move an item to the right project.

Args: id, plus any of title, body, severity (p0-p3), type (ui|backend|usage|ux), project, route. Also author (default 'human') — use your agent name so the trail says who re-triaged it.

Every change is recorded as a comment naming the old and new value; nothing is silently rewritten. Fields you omit are left alone.

This is for correcting the REPORT. To record progress use loopback_update_status, and to record the fix use loopback_link_change.`,
      inputSchema: strict({ ...idShape, ...updateShape }),
      outputSchema: feedbackItemShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, author, ...patch }) => {
      const item = store.update(id, patch, author);
      if (!item) return notFound(id);
      return ok(`Updated ${id}.`, itemJson(item));
    },
  );

  server.registerTool(
    "loopback_get_stats",
    {
      title: "Queue stats",
      description: `Overview of the feedback queue: counts by project and status. Use to orient before picking work, or to report queue health.

Args: project (optional — omit for all projects).

Returns { total, projects: [{ project, by_status, total }] }.`,
      inputSchema: strict(statsShape),
      outputSchema: statsResultShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project }) => {
      const stats = store.stats(project);
      return ok(
        JSON.stringify(stats, null, 2),
        stats as unknown as Record<string, unknown>,
      );
    },
  );

  return server;
}
