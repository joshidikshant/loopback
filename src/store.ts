/**
 * SQLite-backed store for the Loopback feedback bus.
 * Uses Node's built-in node:sqlite (Node >= 22.13) — zero native dependencies.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  ChangeLinks,
  ClaimResult,
  FeedbackComment,
  FeedbackItem,
  ListResult,
  StatsResult,
  Status,
} from "./types.js";
import type { SubmitInput } from "./schemas.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  reporter TEXT NOT NULL DEFAULT 'human',
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'p2',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  route TEXT,
  url TEXT,
  dom_selector TEXT,
  screenshot_path TEXT,
  replay_url TEXT,
  console_json TEXT NOT NULL DEFAULT '[]',
  network_json TEXT NOT NULL DEFAULT '[]',
  repro_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  assignee_agent TEXT,
  resolution TEXT,
  links_json TEXT NOT NULL DEFAULT '{}',
  extra_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_feedback_project_status ON feedback(project, status);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id TEXT NOT NULL REFERENCES feedback(id),
  created_at TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_feedback ON comments(feedback_id);
`;

interface FeedbackRow {
  id: string;
  project: string;
  created_at: string;
  updated_at: string;
  source: string;
  reporter: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  route: string | null;
  url: string | null;
  dom_selector: string | null;
  screenshot_path: string | null;
  replay_url: string | null;
  console_json: string;
  network_json: string;
  repro_json: string;
  status: string;
  assignee_agent: string | null;
  resolution: string | null;
  links_json: string;
  extra_json: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function genId(): string {
  return `fb_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export class LoopbackStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // Migration for databases created before v0.2.0 (no extra_json column).
    try {
      this.db.exec(
        "ALTER TABLE feedback ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'",
      );
    } catch {
      /* column already exists */
    }
  }

  close(): void {
    this.db.close();
  }

  private rowToItem(row: FeedbackRow): FeedbackItem {
    return {
      id: row.id,
      project: row.project,
      created_at: row.created_at,
      updated_at: row.updated_at,
      source: row.source as FeedbackItem["source"],
      reporter: row.reporter as FeedbackItem["reporter"],
      type: row.type as FeedbackItem["type"],
      severity: row.severity as FeedbackItem["severity"],
      title: row.title,
      body: row.body,
      route: row.route ?? undefined,
      url: row.url ?? undefined,
      dom_selector: row.dom_selector ?? undefined,
      screenshot_path: row.screenshot_path ?? undefined,
      replay_url: row.replay_url ?? undefined,
      console: JSON.parse(row.console_json) as string[],
      network: JSON.parse(row.network_json) as FeedbackItem["network"],
      repro_steps: JSON.parse(row.repro_json) as string[],
      status: row.status as Status,
      assignee_agent: row.assignee_agent ?? undefined,
      resolution: row.resolution ?? undefined,
      links: JSON.parse(row.links_json) as ChangeLinks,
      extra: JSON.parse(row.extra_json ?? "{}") as Record<string, unknown>,
    };
  }

  submit(input: SubmitInput): FeedbackItem {
    const id = genId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO feedback (
          id, project, created_at, updated_at, source, reporter, type, severity,
          title, body, route, url, dom_selector, screenshot_path, replay_url,
          console_json, network_json, repro_json, status, links_json, extra_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', '{}', ?)`,
      )
      .run(
        id,
        input.project,
        now,
        now,
        input.source,
        input.reporter,
        input.type,
        input.severity,
        input.title,
        input.body,
        input.route ?? null,
        input.url ?? null,
        input.dom_selector ?? null,
        input.screenshot_path ?? null,
        input.replay_url ?? null,
        JSON.stringify(input.console),
        JSON.stringify(input.network),
        JSON.stringify(input.repro_steps),
        JSON.stringify(input.extra ?? {}),
      );
    const item = this.get(id);
    if (!item) throw new Error("Insert failed unexpectedly");
    return item;
  }

  get(id: string): FeedbackItem | null {
    const row = this.db
      .prepare(`SELECT * FROM feedback WHERE id = ?`)
      .get(id) as unknown as FeedbackRow | undefined;
    if (!row) return null;
    const item = this.rowToItem(row);
    item.comments = this.db
      .prepare(
        `SELECT id, created_at, author, body FROM comments WHERE feedback_id = ? ORDER BY id ASC`,
      )
      .all(id) as unknown as FeedbackComment[];
    return item;
  }

  list(filters: {
    project?: string;
    route?: string;
    status?: string;
    type?: string;
    severity?: string;
    source?: string;
    assignee_agent?: string;
    limit: number;
    offset: number;
  }): ListResult {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const eq = (col: string, val: string | undefined) => {
      if (val !== undefined) {
        where.push(`${col} = ?`);
        params.push(val);
      }
    };
    eq("project", filters.project);
    eq("route", filters.route);
    eq("status", filters.status);
    eq("type", filters.type);
    eq("severity", filters.severity);
    eq("source", filters.source);
    eq("assignee_agent", filters.assignee_agent);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM feedback ${whereSql}`)
      .get(...params) as unknown as { c: number };
    const total = totalRow.c;

    const rows = this.db
      .prepare(
        `SELECT * FROM feedback ${whereSql}
         ORDER BY severity ASC, created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, filters.limit, filters.offset) as unknown as FeedbackRow[];

    const items = rows.map((r) => this.rowToItem(r));
    const hasMore = total > filters.offset + items.length;
    return {
      total,
      count: items.length,
      offset: filters.offset,
      items,
      has_more: hasMore,
      ...(hasMore ? { next_offset: filters.offset + items.length } : {}),
    };
  }

  claim(id: string, agent: string, force: boolean): ClaimResult {
    const guard = force ? "" : "AND (assignee_agent IS NULL OR assignee_agent = ?)";
    const params: (string | number)[] = force
      ? [agent, nowIso(), id]
      : [agent, nowIso(), id, agent];
    const res = this.db
      .prepare(
        `UPDATE feedback SET
           assignee_agent = ?,
           updated_at = ?,
           status = CASE WHEN status IN ('open','triaged') THEN 'in_progress' ELSE status END
         WHERE id = ? ${guard}`,
      )
      .run(...params);
    if (res.changes === 0) {
      const existing = this.get(id);
      if (!existing) return { ok: false, error: `Feedback '${id}' not found.` };
      return {
        ok: false,
        error: `Feedback '${id}' is already claimed by '${existing.assignee_agent}'. Pass force=true to take over.`,
      };
    }
    return { ok: true, item: this.get(id) ?? undefined };
  }

  updateStatus(
    id: string,
    status: Status,
    note?: string,
    author = "agent",
  ): FeedbackItem | null {
    const res = this.db
      .prepare(`UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowIso(), id);
    if (res.changes === 0) return null;
    if (note) {
      this.addComment(id, author, `[status → ${status}] ${note}`);
    }
    return this.get(id);
  }

  addComment(id: string, author: string, body: string): FeedbackItem | null {
    const exists = this.db
      .prepare(`SELECT 1 FROM feedback WHERE id = ?`)
      .get(id);
    if (!exists) return null;
    this.db
      .prepare(
        `INSERT INTO comments (feedback_id, created_at, author, body) VALUES (?, ?, ?, ?)`,
      )
      .run(id, nowIso(), author, body);
    this.db
      .prepare(`UPDATE feedback SET updated_at = ? WHERE id = ?`)
      .run(nowIso(), id);
    return this.get(id);
  }

  linkChange(id: string, links: ChangeLinks): FeedbackItem | null {
    const item = this.get(id);
    if (!item) return null;
    const merged: ChangeLinks = { ...item.links };
    for (const key of [
      "repo",
      "branch",
      "commit",
      "pr_url",
      "diff_summary",
    ] as const) {
      const val = links[key];
      if (val !== undefined) merged[key] = val;
    }
    this.db
      .prepare(`UPDATE feedback SET links_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(merged), nowIso(), id);
    return this.get(id);
  }

  resolve(
    id: string,
    resolution: "verified" | "wontfix",
    note?: string,
  ): FeedbackItem | null {
    const res = this.db
      .prepare(
        `UPDATE feedback SET status = ?, resolution = ?, updated_at = ? WHERE id = ?`,
      )
      .run(resolution, resolution, nowIso(), id);
    if (res.changes === 0) return null;
    if (note) this.addComment(id, "agent", `[${resolution}] ${note}`);
    return this.get(id);
  }

  stats(project?: string): StatsResult {
    const whereSql = project ? "WHERE project = ?" : "";
    const params = project ? [project] : [];
    const rows = this.db
      .prepare(
        `SELECT project, status, COUNT(*) AS c FROM feedback ${whereSql}
         GROUP BY project, status ORDER BY project`,
      )
      .all(...params) as unknown as {
      project: string;
      status: string;
      c: number;
    }[];
    const byProject = new Map<string, Record<string, number>>();
    let total = 0;
    for (const row of rows) {
      const rec = byProject.get(row.project) ?? {};
      rec[row.status] = row.c;
      byProject.set(row.project, rec);
      total += row.c;
    }
    return {
      total,
      projects: [...byProject.entries()].map(([proj, by_status]) => ({
        project: proj,
        by_status,
        total: Object.values(by_status).reduce((a, b) => a + b, 0),
      })),
    };
  }
}
