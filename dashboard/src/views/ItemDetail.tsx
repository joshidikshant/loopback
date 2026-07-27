import { useEffect, useRef, useState } from "react";
import {
  api,
  bytes,
  statusClass,
  severityClass,
  severityWeight,
  safeHref,
  SEVERITIES,
  STATUSES,
  TYPES,
  type Item,
  type Severity,
  type Status,
  type FeedbackType,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAuthor, setAuthor, hasAuthor } from "@/lib/identity";
import { age } from "@/views/QueueList";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { ArrowLeft, File, Paperclip, Pencil, Trash2 } from "lucide-react";

/**
 * Was the constant "dj". Every human write in every install carried one
 * person's name; see lib/identity.ts. Read at call time, not module load, so a
 * name set mid-session applies immediately.
 */
const author = (): string => getAuthor();

/**
 * Loopback's label recipe, in one place.
 *
 * 11px is not an off-scale invention — it is the shared `.lb-label` token
 * (design/components.css: 0.6875rem / 500 / muted-foreground), which the widget
 * renders identically. Tailwind's scale has no 11px step, so the bracket value
 * is the only way to say it here; `text-xs` would silently diverge the
 * dashboard from the widget and the published registry.
 */
const LABEL = "text-[11px] font-medium text-muted-foreground";

/**
 * A read-only display group — NOT a form field. These label values, not
 * controls, so the label is never a <label>: it would point at nothing.
 *
 * `region` promotes the group to a real <section> with an <h2>. The page used
 * to carry exactly one heading and one landmark, with a dozen visually-labelled
 * groups rendered as bare spans — so heading and region navigation stopped at
 * the title and a screen-reader user had no way to move between the report, the
 * console, the failed requests and the trail. Compact metadata (Project, Route,
 * Age) stays a plain div: promoting six one-line facts to headings is noise.
 */
function Section({
  label,
  children,
  region,
}: {
  label: string;
  children: React.ReactNode;
  region?: boolean;
}): React.JSX.Element {
  if (region) {
    return (
      <section className="grid min-w-0 gap-1.5" aria-label={label}>
        <h2 className={LABEL}>{label}</h2>
        {/* min-w-0 belongs HERE, not only on the wrapper: this div is the grid
            item holding the content, and a grid item defaults to
            min-width:auto — it refuses to shrink below its longest unbreakable
            token no matter what the parent says. */}
        <div className="min-w-0">{children}</div>
      </section>
    );
  }
  return (
    <div className="grid min-w-0 gap-1.5">
      <span className={LABEL}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * tabIndex={0} because this box scrolls. A scrollable region with no focusable
 * descendant cannot be reached by keyboard at all — measured at 2000px of
 * console capture inside a 1130px box, with everything past the fold
 * unreachable. role/aria-label give the stop a name once it is in the tab order.
 */
const Pre = ({ children, label }: { children: string; label: string }): React.JSX.Element => (
  <pre
    tabIndex={0}
    role="group"
    aria-label={label}
    className="mt-0.5 overflow-x-auto whitespace-pre-wrap rounded-md border bg-background p-2.5 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)]"
  >
    {children}
  </pre>
);

export function ItemDetail({
  id,
  navigate,
  themeToggle,
}: {
  id: string;
  navigate: (to: string) => void;
  themeToggle: React.ReactNode;
}): React.JSX.Element {
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Item>>({});
  const [comment, setComment] = useState("");
  const [note, setNote] = useState("");
  const [intent, setIntent] = useState<"reference" | "asset">("reference");
  const [target, setTarget] = useState("");
  // Every write goes through this. Without it, a slow hub means a second click
  // fires a second POST — a duplicate comment, or a status set twice.
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = (): void => {
    api
      .get(id)
      .then((i) => {
        setItem(i);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };
  useEffect(reload, [id]);

  // Same reason as the queue: an agent can resolve this item while it is open,
  // and the widget on this very page would repaint its pin green while the
  // detail view kept the old status. Paused while a write is in flight so a
  // poll cannot clobber what the user is doing.
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden && !busy && !editing) reload();
    }, 10000);
    return () => clearInterval(t);
  }, [id, busy, editing]);

  if (error) {
    return (
      <div className="grid gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Could not load {id}</h1>
        <Alert variant="destructive">
          <AlertTitle>The hub did not return this item</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => navigate("/queue")}>
          Back to the queue
        </Button>
      </div>
    );
  }
  // Skeletons in the shape of the real page, so it does not reflow on arrival —
  // plus a heading and a live status, because the route change moves focus into
  // <main> and this branch used to give it nothing to announce.
  if (!item)
    return (
      <div className="grid gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Loading feedback item</h1>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Loading {id}…
        </p>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  const failed = (item.extra as {
    failed_responses?: { url: string; status: number; body: string }[];
  }).failed_responses;
  const context = (item.extra as { context?: Record<string, unknown> }).context;

  /** Every write funnels through here: one in-flight guard, one error path. */
  const run = async (fn: () => Promise<void>, region?: string): Promise<void> => {
    if (busy) return;
    // Disabling the control that is currently focused sends focus to <body>,
    // which drops a keyboard user out of the form mid-task. Remember where they
    // were and put them back once the control is enabled again.
    const focused = document.activeElement as HTMLElement | null;
    // Two fallbacks, because closest() alone is not enough:
    //   - SAVE unmounts its own Card inside fn(), so a captured element is gone.
    //   - STATUS is a Radix Select whose focused item is PORTALED to <body>, so
    //     closest("[data-slot=card]") is null before we even start.
    // A stable id resolved AFTER the write always exists, so record where to
    // land rather than which node to return to.
    const closestCard = focused?.closest("[data-slot=card], header") as HTMLElement | null;
    // The region is passed IN, not derived. Deriving it from the focused
    // element's ancestors fails on exactly the paths that need it: a Radix
    // Select portals its item to <body> (no card ancestor at all), and Save
    // unmounts the card the id sits on. Only the comment path ever worked.
    const anchorId =
      region ?? focused?.closest("[data-lb-region]")?.getAttribute("data-lb-region") ?? null;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        const stillUsable =
          focused && document.contains(focused) && !(focused as HTMLButtonElement).disabled;
        if (stillUsable) {
          focused.focus();
          return;
        }
        // Resolve the landing zone NOW, after the re-render.
        const byId = anchorId
          ? (document.querySelector(`[data-lb-region="${anchorId}"]`) as HTMLElement | null)
          : null;
        const target =
          byId ?? (closestCard && document.contains(closestCard) ? closestCard : null);
        if (target) {
          target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
        }
      });
    }
  };

  const save = (): Promise<void> =>
    run(async () => {
      await api.update(id, { ...draft, author: author() });
      toast.success("Saved — the change is on the audit trail");
      setEditing(false);
      setDraft({});
      reload();
    }, "detail-header");

  const upload = async (file: File): Promise<void> => {
    if (intent === "asset" && !target.trim()) {
      toast.error("An asset needs a target path — where should it land in the repo?");
      return;
    }
    return run(async () => {
      await api.attach(id, file, {
        intent,
        target: intent === "asset" ? target.trim() : undefined,
        author: author(),
      });
      toast.success(
        intent === "asset"
          ? `Attached as an asset — an agent will copy it to ${target.trim()}`
          : "Attached as reference — context for the fix",
      );
      setTarget("");
      reload();
    });
  };

  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <header data-lb-region="detail-header" className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" className="h-11" onClick={() => navigate("/queue")}>
          <ArrowLeft className="size-4" /> Queue
        </Button>
        <Badge className={statusClass[item.status]}>
          {item.status}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          {!editing && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft({
                  title: item.title,
                  body: item.body,
                  severity: item.severity,
                  type: item.type,
                });
                setEditing(true);
                // This button unmounts itself, so nothing restores focus for it.
                requestAnimationFrame(() => {
                  document.getElementById("lb-edit-title")?.focus();
                });
              }}
            >
              <Pencil className="size-4" /> Edit
            </Button>
          )}
          {themeToggle}
        </div>
      </header>

      {/* The h1 lives outside the edit branch. It used to be inside the "not
          editing" side, so entering edit mode left the page with no heading at
          all — heading navigation just stopped working mid-task. */}
      <h1 className="text-xl font-semibold tracking-tight break-all">{item.title}</h1>

      {editing ? (
        <Card data-lb-region="edit" className="grid min-w-0 gap-3 p-4 [&>*]:min-w-0">
          <Label htmlFor="lb-edit-title" className="sr-only">
            Title
          </Label>
          <Input
            id="lb-edit-title"
            value={draft.title ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            className="text-base font-medium"
          />
          <Label htmlFor="lb-edit-body" className="sr-only">
            Report
          </Label>
          <Textarea
            id="lb-edit-body"
            value={draft.body ?? ""}
            rows={6}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />
          <div className="flex flex-wrap gap-2">
            <Select
              value={draft.severity}
              onValueChange={(v) => setDraft((d) => ({ ...d, severity: v as Severity }))}
            >
              <SelectTrigger className="w-32" aria-label="Severity"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={draft.type}
              onValueChange={(v) => setDraft((d) => ({ ...d, type: v as FeedbackType }))}
            >
              <SelectTrigger className="w-36" aria-label="Type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setDraft({});
                // Same: Cancel unmounts its own card.
                requestAnimationFrame(() => {
                  const header = document.querySelector('[data-lb-region="detail-header"]') as HTMLElement | null;
                  header?.setAttribute("tabindex", "-1");
                  header?.focus({ preventScroll: true });
                });
              }}
            >
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Every edit is recorded on the trail with its old value — nothing is
            rewritten silently.
          </p>
        </Card>
      ) : (
        <code className="font-mono text-xs break-all text-muted-foreground">{item.id}</code>
      )}

      <Card className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3 p-4">
        <Section label="Project"><span className="break-all">{item.project}</span></Section>
        <Section label="Severity / type">
          <span className={`font-mono text-xs ${severityClass[item.severity]} ${severityWeight[item.severity]}`}>
            {item.severity}
          </span>{" "}
          <span className="text-sm text-muted-foreground">{item.type}</span>
        </Section>
        <Section label="Source / reporter">
          <span className="text-sm break-all">{item.source} · {item.reporter}</span>
        </Section>
        <Section label="Assignee">
          <span className="text-sm break-all">{item.assignee_agent ?? "unclaimed"}</span>
        </Section>
        <Section label="Route">
          <code className="font-mono text-xs break-all">{item.route ?? "—"}</code>
        </Section>
        {/* created_at was on the type and rendered nowhere. Age is the first
            thing anyone wants from a triage queue. */}
        <Section label="Age">
          <time dateTime={item.created_at} className="text-sm" title={item.created_at}>
            {age(item.created_at)}
          </time>
        </Section>
        <Section label="Updated">
          <span className="text-sm text-muted-foreground">{item.updated_at}</span>
        </Section>
        {item.resolution && (
          <Section label="Resolution">
            <span className="text-sm">{item.resolution}</span>
          </Section>
        )}
      </Card>

      <div className="grid gap-3.5">
        {item.body && !editing && (
          <Section region label="Report">
            <div className="whitespace-pre-wrap break-all text-sm">{item.body}</div>
          </Section>
        )}
        {item.repro_steps.length > 0 && (
          <Section region label="Repro steps">
            <ol className="list-decimal pl-5 text-sm break-all">
              {item.repro_steps.map((s, n) => <li key={n}>{s}</li>)}
            </ol>
          </Section>
        )}
        {failed && failed.length > 0 && (
          <Section region label="Failed requests (captured at report time)">
            {failed.map((f, n) => (
              <div key={n} className="mb-2">
                <code className="font-mono text-xs break-all">{f.status} {f.url}</code>
                {f.body && <Pre label={`Response body for ${f.status} ${f.url}`}>{f.body}</Pre>}
              </div>
            ))}
          </Section>
        )}
        {context && (
          <Section region label="Run context (AI / automation)">
            <Pre label="Run context JSON">{JSON.stringify(context, null, 2)}</Pre>
          </Section>
        )}
        {item.console.length > 0 && (
          <Section region label={`Console (${item.console.length})`}>
            <Pre label="Console capture">{item.console.join("\n")}</Pre>
          </Section>
        )}
        {Object.values(item.links).some(Boolean) && (
          <Section region label="Linked change">
            <div className="text-sm">
              {Object.entries(item.links)
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <span className="text-muted-foreground">{k}:</span>{" "}
                    {k === "pr_url" && safeHref(String(v)) ? (
                      <a
                        className="inline-block min-h-6 break-all underline"
                        href={safeHref(String(v)) ?? undefined}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {String(v)}
                      </a>
                    ) : (
                      <code className="font-mono text-xs break-all">{String(v)}</code>
                    )}
                  </div>
                ))}
            </div>
          </Section>
        )}
        {item.dom_selector && (
          <Section region label="Anchor">
            <code className="font-mono text-xs break-all">{item.dom_selector}</code>
          </Section>
        )}
        {/* `url` and `network` were typed on Item and rendered nowhere, so the
            agent's view of an item was strictly richer than the human's. */}
        {item.url && (
          <Section region label="Reported from">
            {safeHref(item.url) ? (
              <a
                className="inline-block min-h-6 text-sm break-all underline"
                href={safeHref(item.url) ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
              >
                {item.url}
              </a>
            ) : (
              // Not http(s) — show it, never link it.
              <span className="text-sm break-all">{item.url}</span>
            )}
          </Section>
        )}
        {item.network.length > 0 && (
          <Section region label={`Network at report time (${item.network.length})`}>
            <div className="grid gap-1">
              {item.network.slice(-8).map((n, i) => (
                <div key={i} className="flex flex-wrap items-baseline gap-2 font-mono text-xs">
                  <span
                    className={
                      (n.status ?? 0) >= 400 || n.status === 0
                        ? "text-lb-p0 font-semibold"
                        : "text-muted-foreground"
                    }
                  >
                    {n.status ?? "—"}
                  </span>
                  <span className="text-muted-foreground">{n.method ?? "GET"}</span>
                  <span className="break-all">{n.url}</span>
                  {n.ms !== undefined && <span className="text-muted-foreground">{n.ms}ms</span>}
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>

      {/* Attachments — intent is the whole point, so it is the first thing chosen. */}
      <Card data-lb-region="attachments" className="grid gap-3 p-4">
        <div className="flex items-center gap-2">
          <Paperclip className="size-4" />
          <span className="text-sm font-medium">
            Attachments{item.attachments?.length ? ` (${item.attachments.length})` : ""}
          </span>
        </div>

        {item.attachments?.map((a) => (
          <Attachment key={a.id} className="w-full">
            <AttachmentMedia variant={a.mime.startsWith("image/") ? "image" : "icon"}>
              {a.mime.startsWith("image/") ? (
                <img src={a.url} alt="" />
              ) : (
                <File aria-hidden />
              )}
            </AttachmentMedia>
            <AttachmentContent className="min-w-0">
              <AttachmentTitle className="whitespace-normal" title={a.name}>
                {safeHref(a.url) ? (
                  <a
                    className="inline-block min-h-6 break-all underline"
                    href={safeHref(a.url) ?? undefined}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {a.name}
                  </a>
                ) : (
                  <span className="break-all">{a.name}</span>
                )}
              </AttachmentTitle>
              <AttachmentDescription
                className="whitespace-normal break-all"
                title={a.target_path ?? undefined}
              >
                {/* `asset` is the consequential one — it gets copied into the
                    repo — so it takes the emphasis. Reusing the green "verified"
                    status colour here said nothing true about the attachment. */}
                <Badge variant={a.intent === "asset" ? "default" : "secondary"}>
                  {a.intent}
                </Badge>{" "}
                {bytes(a.size)}
                {a.target_path ? ` → ${a.target_path}` : ""}
              </AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions>
              {/* Detaching deletes the blob and cannot be undone, so it asks. */}
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <AttachmentAction aria-label={`Remove attachment ${a.name}`} disabled={busy}>
                    <Trash2 />
                  </AttachmentAction>
                </AlertDialogTrigger>
                <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
                  <AlertDialogHeader className="min-w-0">
                    <AlertDialogTitle className="min-w-0 break-all">
                      Remove “{a.name}”?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      The file is deleted from the hub. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() =>
                        run(async () => {
                          await api.detach(id, a.id);
                          toast.success("Removed");
                          reload();
                        }, "attachments")
                      }
                    >
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </AttachmentActions>
          </Attachment>
        ))}

        {/* A fixed 150px track does not scale with text, so at 200% zoom the
            Select overlapped the Input. min-content lets the track grow with its
            own contents instead. */}
        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)_auto] sm:items-center [&>*]:min-w-0">
          <Select value={intent} onValueChange={(v) => setIntent(v as "reference" | "asset")}>
            <SelectTrigger aria-label="Attachment intent"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="reference">reference</SelectItem>
              <SelectItem value="asset">asset</SelectItem>
            </SelectContent>
          </Select>
          <Input
            aria-label="Target path in the repo"
            placeholder={
              intent === "asset"
                ? "Target path in the repo, e.g. public/logos/acme.svg"
                : "Context for the fix — no target path needed"
            }
            value={target}
            disabled={intent === "reference"}
            onChange={(e) => setTarget(e.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? "Uploading…" : "Choose file"}
          </Button>
          {/* Proxied by the "Choose file" button, which is the real control.
              It still needs a name — it is a form control in the tree — and it
              stays out of the tab order so keyboard users are not sent to an
              invisible input. */}
          <input
            ref={fileRef}
            type="file"
            aria-label="Choose a file to attach"
            tabIndex={-1}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = "";
            }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          <strong>reference</strong> is context for the fix and never ships.{" "}
          <strong>asset</strong> is a deliverable — an agent copies it to the target
          path in the repo and commits it.
        </p>
      </Card>

      {item.comments && item.comments.length > 0 && (
        <Section region label={`Trail (${item.comments.length})`}>
          <div className="grid gap-2">
            {/* A divided list, not a stack of accent-bordered cards. The trail is
                a log; separators between entries read as one, side-tabs read as
                several unrelated callouts. */}
            {item.comments.map((c) => (
              <div key={c.id} className="min-w-0 py-2 not-last:border-b">
                <div className="text-xs break-all text-muted-foreground">
                  {c.author} · {c.created_at}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap break-all text-sm">{c.body}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Ask once, before the first write. The trail is only worth trusting if
          it names whoever actually acted. */}
      {!hasAuthor() && (
        <Alert>
          <AlertTitle>Who is writing to this trail?</AlertTitle>
          <AlertDescription>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Label htmlFor="lb-author" className="sr-only">
                Your name
              </Label>
              <Input
                id="lb-author"
                className="h-11 w-full max-w-48 min-w-0"
                placeholder="Your name or handle"
                defaultValue=""
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  setAuthor((e.target as HTMLInputElement).value);
                  reload();
                }}
              />
              <Button
                size="sm"
                className="h-11"
                onClick={() => {
                  const el = document.getElementById("lb-author") as HTMLInputElement | null;
                  if (el) setAuthor(el.value);
                  reload();
                  // This alert unmounts itself once a name exists, so nothing
                  // restores focus for it — and it is the first write every new
                  // user performs.
                  requestAnimationFrame(() => {
                    const c = document.querySelector('[data-lb-region="comment"]') as HTMLElement | null;
                    c?.setAttribute("tabindex", "-1");
                    c?.focus({ preventScroll: true });
                  });
                }}
              >
                Save
              </Button>
              <span className="text-xs text-muted-foreground">
                Stored in this browser only. Until then, writes are recorded as{" "}
                <code className="font-mono">unknown-human</code>.
              </span>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* min-w-0 on the row AND on the cards: the page wrapper's
          [&>*]:min-w-0 only reaches direct children, and these are
          grandchildren. */}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Card data-lb-region="comment" className="grid gap-2 p-4">
          <Label htmlFor="lb-comment" className={LABEL}>
            Add a comment
          </Label>
          <Textarea
            id="lb-comment"
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What you noticed, decided, or want the agent to know"
          />
          <Button
            size="sm"
            disabled={busy || !comment.trim()}
            onClick={() =>
              run(async () => {
                await api.comment(id, comment, author());
                setComment("");
                toast.success("Comment added");
                reload();
              })
            }
          >
            {busy ? "Adding…" : "Comment"}
          </Button>
        </Card>

        {/* The note is captured BEFORE the Select, because the Select is what
            commits it. Reading order was the bug: pick a status first and the
            note is still empty — and store.updateStatus only writes a trail
            entry `if (note)`, so the change landed with no trail at all. */}
        <Card data-lb-region="status" className="grid gap-2 p-4">
          <Label htmlFor="lb-status-note" className={LABEL}>
            Change status
          </Label>
          <Input
            id="lb-status-note"
            placeholder="Why — recorded on the trail. Type this first."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Select
            value={item.status}
            onValueChange={(v) =>
              run(async () => {
                await api.setStatus(id, v as Status, note, author());
                setNote("");
                toast.success(`Status is now ${v}`);
                reload();
              }, "status")
            }
          >
            <SelectTrigger aria-label="Status" disabled={busy}><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Card>
      </div>
    </div>
  );
}
