import { useEffect, useMemo, useState } from "react";
import {
  api,
  statusClass,
  severityClass,
  STATUSES,
  type Filters,
  type Item,
  type Status,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { X } from "lucide-react";

/** Query string is the source of truth for filters, so every view is linkable. */
function readFilters(): Filters {
  const q = new URLSearchParams(window.location.search);
  const pick = (k: keyof Filters): string | undefined => q.get(k) ?? undefined;
  return {
    project: pick("project"),
    status: pick("status") as Filters["status"],
    type: pick("type") as Filters["type"],
    severity: pick("severity") as Filters["severity"],
    assignee_agent: pick("assignee_agent"),
  };
}

function writeFilters(next: Filters): void {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
  const qs = q.toString();
  window.history.replaceState({}, "", qs ? `/queue?${qs}` : "/queue");
}

export function QueueList({
  navigate,
  themeToggle,
}: {
  navigate: (to: string) => void;
  themeToggle: React.ReactNode;
}): React.JSX.Element {
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [all, setAll] = useState<Item[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch the project scope once; status/type/severity narrow it in the client
  // so the tiles can always show their counts and clicking never dead-ends.
  useEffect(() => {
    setLoading(true);
    api
      .list({ project: filters.project }, 500)
      .then((r) => {
        setAll(r.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filters.project]);

  useEffect(() => writeFilters(filters), [filters]);

  const counts = useMemo(() => {
    const c = new Map<Status, number>();
    for (const i of all) c.set(i.status, (c.get(i.status) ?? 0) + 1);
    return c;
  }, [all]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter(
      (i) =>
        (!filters.status || i.status === filters.status) &&
        (!filters.type || i.type === filters.type) &&
        (!filters.severity || i.severity === filters.severity) &&
        (!filters.assignee_agent || i.assignee_agent === filters.assignee_agent) &&
        (!needle ||
          i.title.toLowerCase().includes(needle) ||
          i.body.toLowerCase().includes(needle) ||
          i.id.toLowerCase().includes(needle)),
    );
  }, [all, filters, q]);

  const toggle = (key: keyof Filters, value: string): void =>
    setFilters((f) => ({ ...f, [key]: f[key] === value ? undefined : value }));

  const active = Object.entries(filters).filter(([, v]) => v) as [string, string][];

  return (
    <>
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">
          Loopback queue{filters.project ? ` — ${filters.project}` : ""}
        </h1>
        <span className="text-sm text-muted-foreground">
          {shown.length}
          {shown.length !== all.length ? ` of ${all.length}` : ""} item
          {shown.length === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, body, id…"
            className="h-8 w-56"
          />
          {themeToggle}
        </div>
      </header>

      <p className="mt-2 text-sm text-muted-foreground">
        Something wrong or clumsy on <em>this</em> page? Pin it — feedback about
        Loopback files to the <code className="font-mono text-xs">loopback</code>{" "}
        project, the same loop everything else uses.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {STATUSES.filter((s) => counts.get(s)).map((s) => (
          <button
            key={s}
            onClick={() => toggle("status", s)}
            aria-pressed={filters.status === s}
            className={`rounded-full transition ${
              filters.status === s ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : "hover:opacity-85"
            }`}
            title={filters.status === s ? "Clear this filter" : `Show only ${s}`}
          >
            <Badge className={`${statusClass[s]} rounded-full`}>
              {counts.get(s)} {s}
            </Badge>
          </button>
        ))}
        {active.length > 0 && (
          <div className="ml-1 flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">·</span>
            {active.map(([k, v]) => (
              <button
                key={k}
                onClick={() => setFilters((f) => ({ ...f, [k]: undefined }))}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
                title="Remove this filter"
              >
                {k.replace("_agent", "")}: <strong>{v}</strong>
                <X className="size-3" />
              </button>
            ))}
            <button
              onClick={() => setFilters({})}
              className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent"
            >
              clear all
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="mt-6 text-sm text-destructive">
          Could not reach the hub: {error}
        </p>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[220px]">id</TableHead>
              <TableHead>project</TableHead>
              <TableHead>sev / type</TableHead>
              <TableHead>title</TableHead>
              <TableHead>status</TableHead>
              <TableHead>assignee</TableHead>
              <TableHead>change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {!loading && shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  Nothing matches. {active.length > 0 && (
                    <button className="underline" onClick={() => setFilters({})}>
                      Clear filters
                    </button>
                  )}
                </TableCell>
              </TableRow>
            )}
            {shown.map((i) => (
              <TableRow
                key={i.id}
                className="cursor-pointer"
                onClick={() => navigate(`/queue/${encodeURIComponent(i.id)}`)}
              >
                <TableCell>
                  <code className="font-mono text-xs">{i.id}</code>
                </TableCell>
                <TableCell>
                  <button
                    className="hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("project", i.project);
                    }}
                  >
                    {i.project}
                  </button>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <button
                    className={`font-mono text-xs font-semibold hover:underline ${severityClass[i.severity]}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("severity", i.severity);
                    }}
                  >
                    {i.severity}
                  </button>{" "}
                  <button
                    className="text-xs text-muted-foreground hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("type", i.type);
                    }}
                  >
                    {i.type}
                  </button>
                </TableCell>
                <TableCell className="font-medium">
                  {i.title}
                  {(i.attachments?.length ?? 0) > 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      📎 {i.attachments?.length}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("status", i.status);
                    }}
                  >
                    <Badge className={`${statusClass[i.status]} rounded-full`}>
                      {i.status}
                    </Badge>
                  </button>
                </TableCell>
                <TableCell className="text-sm">
                  {i.assignee_agent ?? (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {i.links.pr_url ? (
                    <a
                      href={i.links.pr_url}
                      onClick={(e) => e.stopPropagation()}
                      className="underline"
                    >
                      PR
                    </a>
                  ) : i.links.commit ? (
                    <code className="font-mono text-xs">
                      {i.links.commit.slice(0, 9)}
                    </code>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Click a row to open it. Filters live in the URL — this view is linkable.
      </p>
    </>
  );
}
