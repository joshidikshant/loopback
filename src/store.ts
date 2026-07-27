/**
 * SQLite-backed store for the Loopback feedback bus.
 * Uses Node's built-in node:sqlite (Node >= 22.13) — zero native dependencies.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  Attachment,
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
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id),
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  -- 'reference' = context for the fix, never ships. 'asset' = a deliverable the
  -- agent must copy into the repo at target_path and commit. Same storage, very
  -- different meaning, and only the reporter knows which it is.
  intent TEXT NOT NULL DEFAULT 'reference',
  target_path TEXT,
  file TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_feedback ON attachments(feedback_id);
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
  /**
   * Blobs sit beside the DB rather than inside it: an attached logo set would
   * bloat every query that reads a row, and copying the folder keeps the
   * attachments with the database.
   */
  readonly blobRoot: string;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.blobRoot = join(dbPath === ":memory:" ? tmpdir() : dirname(dbPath), "blobs");
    // A busy timeout is not optional here: the architecture EXPECTS concurrent
    // writers (the --http hub serving widgets while agents spawn their own
    // stdio instances against the same file). With the default of 0, a
    // collision throws SQLITE_BUSY instantly, which surfaces to the reporter as
    // "can't reach Loopback" on a hub that is running perfectly well.
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
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
    // Agents get an absolute path so they can read or copy the file directly,
    // rather than round-tripping bytes through the protocol.
    item.attachments = this.rawAttachments(id).map((a) => ({
      id: a.id,
      created_at: a.created_at,
      name: a.name,
      mime: a.mime,
      size: a.size,
      intent: a.intent as Attachment["intent"],
      ...(a.target_path ? { target_path: a.target_path } : {}),
      path: join(this.blobRoot, id, a.file),
      url: `/blob/${id}/${a.id}`,
    }));
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
  }, lean = false): ListResult {
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

    // `lean` skips the four heavy JSON columns at the SQL level, so they are
    // never read and never parsed.
    //
    // The HTTP projections added earlier recovered WIRE bytes only: `SELECT *`
    // plus five JSON.parse calls per row ran first, so the parse cost and the
    // retained heap — which a comment in http.ts claimed the projection had
    // fixed — were untouched. Measured at 3.64ms of synchronous, event-loop
    // blocking work per widget poll and 63ms per dashboard load.
    const LEAN_COLS =
      "id, project, created_at, updated_at, source, reporter, type, severity, " +
      "title, body, route, url, dom_selector, status, assignee_agent, resolution, links_json";
    const rows = this.db
      .prepare(
        `SELECT ${lean ? LEAN_COLS : "*"} FROM feedback ${whereSql}
         ORDER BY severity ASC, created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, filters.limit, filters.offset) as unknown as FeedbackRow[];

    const items = rows.map((r) =>
      lean
        ? ({
            ...this.rowToItem({
              ...r,
              console_json: "[]",
              network_json: "[]",
              repro_json: "[]",
              extra_json: "{}",
            } as FeedbackRow),
            // Attachments are a second query per item; a lean list never needs
            // more than the count, which the caller derives from the array.
            attachments: undefined,
          } as FeedbackItem)
        : this.rowToItem(r),
    );
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
    // The trail is what makes the queue trustworthy. A claim moves the item to
    // in_progress and takes ownership — a mutation like any other, and it wrote
    // nothing.
    this.addComment(id, agent, force ? `[force-claimed by ${agent}]` : `[claimed by ${agent}]`);
    return { ok: true, item: this.get(id) ?? undefined };
  }

  updateStatus(
    id: string,
    status: Status,
    note?: string,
    author = "agent",
  ): FeedbackItem | null {
    // `resolution` is cleared here. It used to survive a move back out of a
    // resolved state, so an item displayed as `open` still reported
    // resolution="verified" to the detail page and to the next agent — the
    // trail contradicting the status it sits next to. verified/wontfix never
    // reach this method; they route through resolve(), which sets it.
    const res = this.db
      .prepare(
        `UPDATE feedback SET status = ?, resolution = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(status, nowIso(), id);
    if (res.changes === 0) return null;
    // Always, like resolve(). The label on the control that reaches this says
    // "recorded on the trail" — that has to be true even when the note is blank.
    this.addComment(
      id,
      author,
      note ? `[status → ${status}] ${note}` : `[status → ${status}] (no note given)`,
    );
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

  /**
   * Correct an item after filing.
   *
   * You file fast — that is the point — so the first version is often wrong
   * about severity or type, or has a typo in the title. Every change is
   * recorded as a comment naming the old and new value: the queue is only
   * trustworthy if history cannot be quietly rewritten.
   */
  update(
    id: string,
    patch: {
      title?: string;
      body?: string;
      severity?: string;
      type?: string;
      project?: string;
      route?: string;
    },
    author = "human",
  ): FeedbackItem | null {
    const before = this.get(id);
    if (!before) return null;

    const cols: string[] = [];
    const params: (string | number)[] = [];
    const changes: string[] = [];
    const FIELDS = ["title", "body", "severity", "type", "project", "route"] as const;
    for (const field of FIELDS) {
      const next = patch[field];
      if (next === undefined) continue;
      const prev = (before as unknown as Record<string, unknown>)[field];
      if (String(prev ?? "") === next) continue;
      cols.push(`${field} = ?`);
      params.push(next);
      // The old value, not a summary of it. The dashboard tells the human
      // "every edit is recorded on the trail with its old value — nothing is
      // rewritten silently", and the MCP tool repeats it to agents. For `body`
      // this recorded a CHARACTER COUNT, so the original report — the thing the
      // reporter actually wrote — was gone and unrecoverable. Bodies are capped
      // at 5000 chars by the submit schema, so keeping them is bounded.
      changes.push(
        field === "body"
          ? `body rewritten. Previous value:\n\n${String(prev ?? "(empty)")}`
          : `${field}: ${JSON.stringify(prev ?? null)} → ${JSON.stringify(next)}`,
      );
    }
    if (!cols.length) return before;

    this.db
      .prepare(`UPDATE feedback SET ${cols.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...params, nowIso(), id);
    this.addComment(id, author, `[edited] ${changes.join("; ")}`);
    return this.get(id);
  }

  addAttachment(
    feedbackId: string,
    att: {
      id: string;
      name: string;
      mime: string;
      size: number;
      intent: string;
      target_path?: string;
      file: string;
    },
    author = "human",
  ): FeedbackItem | null {
    const exists = this.db.prepare(`SELECT 1 FROM feedback WHERE id = ?`).get(feedbackId);
    if (!exists) return null;
    this.db
      .prepare(
        `INSERT INTO attachments (id, feedback_id, created_at, name, mime, size, intent, target_path, file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        att.id,
        feedbackId,
        nowIso(),
        att.name,
        att.mime,
        att.size,
        att.intent,
        att.target_path ?? null,
        att.file,
      );
    this.addComment(
      feedbackId,
      author,
      att.intent === "asset"
        ? `[attached asset] ${att.name} — copy it to \`${att.target_path ?? "(no target path given)"}\` in the repo and commit it.`
        : `[attached reference] ${att.name} — context for the fix; it does not ship.`,
    );
    return this.get(feedbackId);
  }

  /** Rows as stored; the HTTP layer adds absolute path + URL. */
  rawAttachments(feedbackId: string): {
    id: string;
    created_at: string;
    name: string;
    mime: string;
    size: number;
    intent: string;
    target_path: string | null;
    file: string;
  }[] {
    return this.db
      .prepare(
        `SELECT id, created_at, name, mime, size, intent, target_path, file
         FROM attachments WHERE feedback_id = ? ORDER BY created_at ASC`,
      )
      .all(feedbackId) as never;
  }

  getAttachment(feedbackId: string, attachmentId: string): {
    name: string;
    mime: string;
    file: string;
  } | null {
    const row = this.db
      .prepare(`SELECT name, mime, file FROM attachments WHERE feedback_id = ? AND id = ?`)
      .get(feedbackId, attachmentId) as unknown as
      | { name: string; mime: string; file: string }
      | undefined;
    return row ?? null;
  }

  deleteAttachment(feedbackId: string, attachmentId: string, author = "human"): boolean {
    // Read the name BEFORE deleting, so the trail can say what went.
    const row = this.db
      .prepare(`SELECT name FROM attachments WHERE feedback_id = ? AND id = ?`)
      .get(feedbackId, attachmentId) as { name?: string } | undefined;
    const res = this.db
      .prepare(`DELETE FROM attachments WHERE feedback_id = ? AND id = ?`)
      .run(feedbackId, attachmentId);
    if (res.changes === 0) return false;
    // The only irreversible operation in the product, and it recorded nothing.
    this.addComment(feedbackId, author, `[removed attachment] ${row?.name ?? attachmentId}`);
    return true;
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
    this.addComment(
      id,
      "agent",
      `[linked change] ${[links.repo, links.branch, links.commit, links.pr_url]
        .filter(Boolean)
        .join(" · ")}`,
    );
    return this.get(id);
  }

  resolve(
    id: string,
    resolution: "verified" | "wontfix",
    note?: string,
    author = "agent",
  ): FeedbackItem | null {
    const res = this.db
      .prepare(
        `UPDATE feedback SET status = ?, resolution = ?, updated_at = ? WHERE id = ?`,
      )
      .run(resolution, resolution, nowIso(), id);
    if (res.changes === 0) return null;
    // Was hardcoded "agent". This is the write that turns a pin saturated
    // green — the one moment the product is entirely about — so recording the
    // wrong actor here undermines the trail precisely where it matters most.
    // Always write a trail entry. `if (note)` meant the single most consequential
    // transition in the product — the one that turns a reporter's pin full green
    // — could land with no record of who did it or when, which is reachable from
    // the dashboard's Status select by leaving the note field empty.
    this.addComment(
      id,
      author,
      note ? `[${resolution}] ${note}` : `[${resolution}] (no note given)`,
    );
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
