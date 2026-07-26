import { useEffect, useMemo, useState } from "react";
import {
  api,
  statusClass,
  severityClass,
  severityWeight,
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

/**
 * How long an item has been sitting. `created_at` was on the type and rendered
 * nowhere, which meant the queue could not answer the first question anyone
 * asks of a triage queue: what has been waiting longest?
 */
export function age(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

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

/** The search term is part of the view, so it belongs in the URL too. */
function readSearch(): string {
  return new URLSearchParams(window.location.search).get("q") ?? "";
}

let urlTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Debounced and guarded. Called from an effect on every keystroke, this used to
 * hit history.replaceState directly — Safari throws SecurityError past roughly
 * 100 calls in 30 seconds, and the throw would surface inside a passive effect
 * with no error boundary above it, taking the page down over a typed search.
 */
function writeFilters(next: Filters, search: string): void {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    try {
      applyUrl(next, search);
    } catch {
      /* URL state is a convenience; never let it break the view */
    }
  }, 150);
}

function applyUrl(next: Filters, search: string): void {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
  // The caption promises "this view is linkable". It was not: the search term
  // lived only in component state, so copying the URL mid-search silently
  // dropped the thing actually narrowing the list.
  if (search.trim()) q.set("q", search.trim());
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
  const [q, setQ] = useState(readSearch);
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

  useEffect(() => writeFilters(filters, q), [filters, q]);

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
        {/* role=status so filtering and searching announce their result count.
            Silently swapping the rows told a screen-reader user nothing. */}
        <span className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {loading
            ? "Loading feedback…"
            : `${shown.length}${shown.length !== all.length ? ` of ${all.length}` : ""} item${
                shown.length === 1 ? "" : "s"
              }${all.length === PAGE ? ` (first ${PAGE})` : ""}`}
        </span>
        {/* min-w-0 lets this shrink instead of pushing the page wider than the
            viewport; w-56 alone made the flex item refuse to give ground. */}
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, body, id…"
            aria-label="Search feedback"
            className="h-11 w-full min-w-0 sm:w-56"
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
        {/* The chip is the visual, but the hit area is 44px tall: the padded
            <button> wraps it, so the target clears SC 2.5.8 without inflating
            the badge itself. */}
        {STATUSES.filter((s) => counts.get(s)).map((s) => (
          <Tooltip key={s}>
            <TooltipTrigger asChild>
              <button
                onClick={() => toggle("status", s)}
                aria-pressed={filters.status === s}
                aria-label={`${counts.get(s)} ${s}. ${
                  filters.status === s ? "Clear this filter" : `Show only ${s} items`
                }`}
                className="inline-flex h-11 items-center rounded-md px-1"
              >
                <Badge
                  className={`${statusClass[s]} pointer-events-none transition ${
                    filters.status === s
                      ? "ring-2 ring-ring ring-offset-1 ring-offset-background"
                      : "hover:opacity-85"
                  }`}
                >
                  {counts.get(s)} {s}
                </Badge>
              </button>
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
                  <button
                    onClick={() => setFilters((f) => ({ ...f, [k]: undefined }))}
                    aria-label={`Remove the ${k.replace("_agent", "")} filter, currently ${v}`}
                    className="inline-flex h-11 items-center rounded-md px-1"
                  >
                    <Badge variant="outline" className="pointer-events-none gap-1">
                      {k.replace("_agent", "")}: <strong>{v}</strong>
                      <X className="size-3" />
                    </Badge>
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove this filter</TooltipContent>
              </Tooltip>
            ))}
            <button
              onClick={() => {
                setFilters({});
                setQ("");
              }}
              aria-label="Clear all filters and search"
              className="inline-flex h-11 items-center rounded-md px-1"
            >
              <Badge variant="outline" className="pointer-events-none">
                clear all
              </Badge>
            </button>
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

      {/* ---- Phone: a card per item ----------------------------------------
          The table is ~1334px wide intrinsically. At 375px roughly a quarter of
          it was visible and the title column started past the right edge, so a
          phone showed ids and nothing readable. A table forced through a narrow
          viewport is the wrong shape; below `sm` this is a list. */}
      <div className="mt-4 grid gap-2 sm:hidden">
        {loading &&
          Array.from({ length: 4 }, (_, n) => (
            <Skeleton key={`msk-${n}`} className="h-24 w-full rounded-lg" />
          ))}
        {!loading &&
          shown.map((i) => (
            <button
              key={i.id}
              onClick={() => navigate(`/queue/${encodeURIComponent(i.id)}`)}
              className="grid min-w-0 gap-1.5 rounded-lg border p-3 text-left hover:bg-muted/50 [&>*]:min-w-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={statusClass[i.status]}>{i.status}</Badge>
                <span
                  className={`font-mono text-xs ${severityClass[i.severity]} ${severityWeight[i.severity]}`}
                >
                  {i.severity}
                </span>
                <span className="text-xs text-muted-foreground">{i.type}</span>
                {(i.attachments?.length ?? 0) > 0 && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Paperclip className="size-3" aria-hidden />
                    <span className="sr-only">Attachments:</span>
                    {i.attachments?.length}
                  </span>
                )}
              </div>
              <div className="font-medium break-all">{i.title}</div>
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{i.project}</span>
                <span aria-hidden>·</span>
                <span>{age(i.created_at)}</span>
                {i.assignee_agent && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{i.assignee_agent}</span>
                  </>
                )}
              </div>
            </button>
          ))}
        {!loading && shown.length === 0 && (
          <Empty className="border">
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
          </Empty>
        )}
      </div>

      {/* ---- Tablet and up: the full table ---- */}
      <div className="mt-4 hidden rounded-lg border sm:block">
        <Table>
          {/* TableCaption is the table's own accessible description, and shadcn
              renders it below the table — exactly where the loose <p> used to
              sit. One element now, correctly associated, same position. */}
          <TableCaption className="mt-3 text-xs">
            Click a row to open it. Filters live in the URL — this view is linkable.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>id</TableHead>
              <TableHead>project</TableHead>
              <TableHead>sev / type</TableHead>
              <TableHead>title</TableHead>
              <TableHead>age</TableHead>
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
                  <TableCell colSpan={8}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {/* Two different situations, two different messages: an empty
                project reads nothing like a filter that excluded everything. */}
            {!loading && shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={8}>
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
                    className="h-auto min-h-6 min-w-6 p-0 font-mono text-xs"
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
                    className="h-auto min-h-6 min-w-6 p-0 text-sm"
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
                    className={`h-auto min-h-6 min-w-6 p-0 font-mono text-xs ${severityClass[i.severity]} ${severityWeight[i.severity]}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("severity", i.severity);
                    }}
                  >
                    {i.severity}
                  </Button>{" "}
                  <Button
                    variant="link"
                    className="h-auto min-h-6 min-w-6 p-0 text-xs text-muted-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle("type", i.type);
                    }}
                  >
                    {i.type}
                  </Button>
                </TableCell>
                <TableCell className="min-w-[16rem] font-medium break-all whitespace-normal">
                  {i.title}
                  {(i.attachments?.length ?? 0) > 0 && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Paperclip className="size-3" aria-hidden />
                      <span className="sr-only">Attachments:</span>
                      {i.attachments?.length}
                    </span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  <time dateTime={i.created_at}>{age(i.created_at)}</time>
                </TableCell>
                <TableCell>
                  <Badge asChild className={`${statusClass[i.status]} min-h-6 cursor-pointer`}>
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
                      className="inline-flex min-h-6 min-w-6 items-center justify-center underline"
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
