import { useEffect, useRef, useState } from "react";
import {
  api,
  bytes,
  statusClass,
  severityClass,
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

const AUTHOR = "dj";

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
 * controls, so this stays a <span>: a <label> here would point at nothing.
 */
function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <span className={LABEL}>{label}</span>
      <div>{children}</div>
    </div>
  );
}

const Pre = ({ children }: { children: string }): React.JSX.Element => (
  <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap rounded-md border bg-background p-2.5 font-mono text-xs">
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
  // Skeletons in the shape of the real page, so it does not reflow on arrival.
  if (!item)
    return (
      <div className="grid gap-4">
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
  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    run(async () => {
      await api.update(id, { ...draft, author: AUTHOR });
      toast.success("Saved — the change is on the audit trail");
      setEditing(false);
      setDraft({});
      reload();
    });

  const upload = async (file: File): Promise<void> => {
    if (intent === "asset" && !target.trim()) {
      toast.error("An asset needs a target path — where should it land in the repo?");
      return;
    }
    return run(async () => {
      await api.attach(id, file, {
        intent,
        target: intent === "asset" ? target.trim() : undefined,
        author: AUTHOR,
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
    <div className="grid gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/queue")}>
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
              }}
            >
              <Pencil className="size-4" /> Edit
            </Button>
          )}
          {themeToggle}
        </div>
      </header>

      {editing ? (
        <Card className="grid gap-3 p-4">
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
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft({}); }}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Every edit is recorded on the trail with its old value — nothing is
            rewritten silently.
          </p>
        </Card>
      ) : (
        <>
          <h1 className="text-xl font-semibold tracking-tight">{item.title}</h1>
          <code className="font-mono text-xs text-muted-foreground">{item.id}</code>
        </>
      )}

      <Card className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3 p-4">
        <Section label="Project">{item.project}</Section>
        <Section label="Severity / type">
          <span className={`font-mono text-xs font-semibold ${severityClass[item.severity]}`}>
            {item.severity}
          </span>{" "}
          <span className="text-sm text-muted-foreground">{item.type}</span>
        </Section>
        <Section label="Source / reporter">
          <span className="text-sm">{item.source} · {item.reporter}</span>
        </Section>
        <Section label="Assignee">
          <span className="text-sm">{item.assignee_agent ?? "unclaimed"}</span>
        </Section>
        <Section label="Route">
          <code className="font-mono text-xs">{item.route ?? "—"}</code>
        </Section>
        <Section label="Updated">
          <span className="text-sm text-muted-foreground">{item.updated_at}</span>
        </Section>
      </Card>

      <div className="grid gap-3.5">
        {item.body && !editing && (
          <Section label="Report">
            <div className="whitespace-pre-wrap text-sm">{item.body}</div>
          </Section>
        )}
        {item.repro_steps.length > 0 && (
          <Section label="Repro steps">
            <ol className="list-decimal pl-5 text-sm">
              {item.repro_steps.map((s, n) => <li key={n}>{s}</li>)}
            </ol>
          </Section>
        )}
        {failed && failed.length > 0 && (
          <Section label="Failed requests (captured at report time)">
            {failed.map((f, n) => (
              <div key={n} className="mb-2">
                <code className="font-mono text-xs">{f.status} {f.url}</code>
                {f.body && <Pre>{f.body}</Pre>}
              </div>
            ))}
          </Section>
        )}
        {context && (
          <Section label="Run context (AI / automation)">
            <Pre>{JSON.stringify(context, null, 2)}</Pre>
          </Section>
        )}
        {item.console.length > 0 && (
          <Section label={`Console (${item.console.length})`}>
            <Pre>{item.console.join("\n")}</Pre>
          </Section>
        )}
        {Object.values(item.links).some(Boolean) && (
          <Section label="Linked change">
            <div className="text-sm">
              {Object.entries(item.links)
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <span className="text-muted-foreground">{k}:</span>{" "}
                    {k === "pr_url" ? (
                      <a
                        className="underline"
                        href={String(v)}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {String(v)}
                      </a>
                    ) : (
                      <code className="font-mono text-xs">{String(v)}</code>
                    )}
                  </div>
                ))}
            </div>
          </Section>
        )}
        {item.dom_selector && (
          <Section label="Anchor">
            <code className="font-mono text-xs break-all">{item.dom_selector}</code>
          </Section>
        )}
      </div>

      {/* Attachments — intent is the whole point, so it is the first thing chosen. */}
      <Card className="grid gap-3 p-4">
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
            <AttachmentContent>
              <AttachmentTitle>
                <a className="underline" href={a.url} target="_blank" rel="noreferrer noopener">
                  {a.name}
                </a>
              </AttachmentTitle>
              <AttachmentDescription>
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
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove “{a.name}”?</AlertDialogTitle>
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
                        })
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

        <div className="grid gap-2 sm:grid-cols-[150px_1fr_auto] sm:items-center">
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
                ? "Target path in the repo, e.g. public/logos/adpushup.svg"
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
          <input
            ref={fileRef}
            type="file"
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
        <Section label={`Trail (${item.comments.length})`}>
          <div className="grid gap-2">
            {/* A divided list, not a stack of accent-bordered cards. The trail is
                a log; separators between entries read as one, side-tabs read as
                several unrelated callouts. */}
            {item.comments.map((c) => (
              <div key={c.id} className="py-2 not-last:border-b">
                <div className="text-xs text-muted-foreground">
                  {c.author} · {c.created_at}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap text-sm">{c.body}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="grid gap-2 p-4">
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
                await api.comment(id, comment, AUTHOR);
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
        <Card className="grid gap-2 p-4">
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
                await api.setStatus(id, v as Status, note, AUTHOR);
                setNote("");
                toast.success(`Status is now ${v}`);
                reload();
              })
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
