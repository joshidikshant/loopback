/** Markdown/JSON formatting helpers for tool responses. */

import type { FeedbackItem, ListResult } from "./types.js";

export const CHARACTER_LIMIT = 25000;

export function itemLine(item: FeedbackItem): string {
  const assignee = item.assignee_agent ? ` · @${item.assignee_agent}` : "";
  return `- **${item.id}** [${item.severity}/${item.type}] ${item.title} — \`${item.status}\`${assignee} (${item.project})`;
}

export function listMarkdown(result: ListResult): string {
  if (result.total === 0) {
    return "No feedback items match these filters.";
  }
  const lines = [
    `# Feedback queue`,
    ``,
    `${result.total} total · showing ${result.count} from offset ${result.offset}` +
      (result.has_more ? ` · more available (next_offset=${result.next_offset})` : ""),
    ``,
    ...result.items.map(itemLine),
  ];
  return truncate(lines.join("\n"));
}

export function itemMarkdown(item: FeedbackItem): string {
  const lines: string[] = [
    `# ${item.title}`,
    ``,
    `- **id**: ${item.id}`,
    `- **project**: ${item.project}`,
    `- **type/severity**: ${item.type} / ${item.severity}`,
    `- **status**: ${item.status}` +
      (item.assignee_agent ? ` (claimed by ${item.assignee_agent})` : ""),
    `- **source/reporter**: ${item.source} / ${item.reporter}`,
    `- **created**: ${item.created_at}  ·  **updated**: ${item.updated_at}`,
  ];
  if (item.route) lines.push(`- **route**: ${item.route}`);
  if (item.url) lines.push(`- **url**: ${item.url}`);
  if (item.dom_selector) lines.push(`- **selector**: \`${item.dom_selector}\``);
  if (item.screenshot_path) lines.push(`- **screenshot**: ${item.screenshot_path}`);
  if (item.replay_url) lines.push(`- **replay**: ${item.replay_url}`);
  if (item.resolution) lines.push(`- **resolution**: ${item.resolution}`);

  if (item.body) lines.push(``, `## Description`, ``, item.body);

  if (item.repro_steps.length) {
    lines.push(``, `## Repro steps`, ``);
    item.repro_steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  if (item.console.length) {
    lines.push(``, `## Console`, ``, "```", ...item.console, "```");
  }
  if (item.network.length) {
    lines.push(``, `## Network`, ``);
    for (const n of item.network) {
      lines.push(
        `- ${n.method ?? "GET"} ${n.url} → ${n.status ?? "?"}${n.ms !== undefined ? ` (${n.ms}ms)` : ""}`,
      );
    }
  }

  // The two fields the agent playbook tells every agent to read. They live in
  // `extra`, which markdown previously dropped entirely — so on the DEFAULT
  // response format the product's whole differentiator (a frontend pin carrying
  // the backend's own error body, and an AI pin carrying its run metadata) was
  // invisible unless the agent happened to ask for JSON.
  const failed = (item.extra as {
    failed_responses?: { url?: string; status?: number; body?: string }[];
  }).failed_responses;
  if (Array.isArray(failed) && failed.length) {
    lines.push(``, `## Failed responses (captured at report time)`, ``);
    for (const f of failed) {
      lines.push(`- **${f.status ?? "ERR"} ${f.url ?? "?"}**`);
      if (f.body) lines.push("", "```", f.body, "```");
    }
  }
  const context = (item.extra as { context?: Record<string, unknown> }).context;
  if (context) {
    lines.push(
      ``,
      `## Run context (AI / automation)`,
      ``,
      "```json",
      JSON.stringify(context, null, 2),
      "```",
    );
  }
  const links = Object.entries(item.links).filter(([, v]) => v !== undefined);
  if (links.length) {
    lines.push(``, `## Linked change`, ``);
    for (const [k, v] of links) lines.push(`- **${k}**: ${v}`);
  }
  if (item.comments?.length) {
    lines.push(``, `## Comments (${item.comments.length})`, ``);
    for (const c of item.comments) {
      lines.push(`- _${c.created_at}_ **${c.author}**: ${c.body}`);
    }
  }
  return truncate(lines.join("\n"));
}

export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n…[truncated at ${CHARACTER_LIMIT} characters — use filters/limit/offset or fetch a single item]`
  );
}
