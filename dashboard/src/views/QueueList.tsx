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
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Paperclip, X } from "lucide-react";

/** The server caps /feedback at 1000; ask for all of it and say so when we hit it. */
const PAGE = 1000;

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
      .list({ project: filters.project }, PAGE)
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
        <h1 className="text-xl font-semibold tracking-tight">
          Loopback queue{filters.project ? ` — ${filters.project}` : ""}
        </h1>
        {/* `all.length` is what we fetched, not what exists. At the cap those
            differ, and reporting the cap as the total is a lie — say "first N"
            instead. Paging is not worth building for a queue this size. */}
        <span className="text-sm text-muted-foreground">
          {shown.length}
          {shown.length !== all.length ? ` of ${all.length}` : ""} item
          {shown.length === 1 ? "" : "s"}
          {all.length === PAGE ? ` (first ${PAGE})` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, body, id…"
            aria-label="Search feedback"
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
        {/* Badge asChild renders the real <button>, so the chip keeps Badge's
            own shape and typography instead of a wrapper re-declaring them.
            Badge is already rounded-full — re-applying it here was a no-op. */}
        {STATUSES.filter((s) => counts.get(s)).map((s) => (
          <Tooltip key={s}>
            <TooltipTrigger asChild>
              <Badge
                asChild
                className={`${statusClass[s]} cursor-pointer transition ${
                  filters.status === s
                    ? "ring-2 ring-ring ring-offset-1 ring-offset-background"
                    : "hover:opacity-85"
                }`}
              >
                <button onClick={() => toggle("status", s)} aria-pressed={filters.status === s}>
                  {counts.get(s)} {s}
                </button>
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {filters.status === s ? "Clear this filter" : `Show only ${s}`}
            </TooltipContent>
          </Tooltip>
        ))}
        {active.length > 0 && (
          <div className="ml-1 flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">·</span>
            {active.map(([k, v]) => (
              <Tooltip key={k}>
                <TooltipTrigger asChild>
                  <Badge asChild variant="outline" className="cursor-pointer gap-1 hover:bg-accent">
                    <button onClick={() => setFilters((f) => ({ ...f, [k]: undefined }))}>
                      {k.replace("_agent", "")}: <strong>{v}</strong>
                      <X className="size-3" />
                    </button>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Remove this filter</TooltipContent>
              </Tooltip>
            ))}
            <Badge asChild variant="outline" className="cursor-pointer hover:bg-accent">
              <button onClick={() => setFilters({})}>clear all</button>
            </Badge>
          </div>
        )}
      </div>

      {/* role="alert" comes from the Alert primitive — a bare <p> announces
          nothing, so a screen-reader user just sees an empty table. */}
      {error && (
        <Alert variant="destructive" className="mt-6">
          <AlertTitle>Could not reach the hub</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="mt-4 rounded-lg border">
        <Table>
          {/* TableCaption is the table's own accessible description, and shadcn
              renders it below the table — exactly where the loose <p> used to
              sit. One element now, correctly associated, same position. */}
          <TableCaption className="mt-3 text-xs">
            Click a row to open it. Filters live in the URL — this view is linkable.
          </TableCaption>
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
            {/* Skeleton rows hold the table's height, so the page does not
                jump when the data lands. */}
            {loading &&
              Array.from({ length: 5 }, (_, n) => (
                <TableRow key={`sk-${n}`}>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {/* Two different situations, two different messages: an empty
                project reads nothing like a filter that excluded everything. */}
            {!loading && shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Empty className="border-0 bg-transparent">
                    <EmptyHeader>
                      <EmptyTitle>
                        {active.length > 0 || q ? "Nothing matches" : "The queue is empty"}
                      </EmptyTitle>
                      <EmptyDescription>
                        {active.length > 0 || q
                          ? "No item matches the current filters."
                          : "Pin something with the widget and it lands here."}
                      </EmptyDescription>
                    </EmptyHeader>
                    {(active.length > 0 || q) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setFilters({});
                          setQ("");
                        }}
                      >
                        Clear filters
                      </Button>
                    )}
                  </Empty>
                </TableCell>
              </TableRow>
            )}
            {shown.map((i) => (
              <TableRow
                key={i.id}
                className="cursor-pointer"
                onClick={() => navigate(`/queue/${encodeURIComponent(i.id)}`)}
              >
                {/* The row click is a mouse convenience. The id is the real
                    control — a focusable button in the tab order — so the queue
                    is navigable without a pointer. Row onClick alone left
                    keyboard users with no way in at all. */}
                <TableCell>
                  <Button
                    variant="link"
                    className="h-auto p-0 font-mono text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/queue/${encodeURIComponent(i.id)}`);
                    }}
                  >
                    {i.id}
                  </Button>
                </TableCell>
                <TableCell>
                  <Button
                    variant="link"
                    className="h-auto p-0 text-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("project", i.project);
                    }}
                  >
                    {i.project}
                  </Button>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Button
                    variant="link"
                    className={`h-auto p-0 font-mono text-xs font-semibold ${severityClass[i.severity]}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("severity", i.severity);
                    }}
                  >
                    {i.severity}
                  </Button>{" "}
                  <Button
                    variant="link"
                    className="h-auto p-0 text-xs text-muted-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("type", i.type);
                    }}
                  >
                    {i.type}
                  </Button>
                </TableCell>
                <TableCell className="font-medium">
                  {i.title}
                  {(i.attachments?.length ?? 0) > 0 && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Paperclip className="size-3" aria-hidden />
                      <span className="sr-only">Attachments:</span>
                      {i.attachments?.length}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge asChild className={`${statusClass[i.status]} cursor-pointer`}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle("status", i.status);
                      }}
                    >
                      {i.status}
                    </button>
                  </Badge>
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
                      target="_blank"
                      rel="noreferrer noopener"
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

    </>
  );
}
