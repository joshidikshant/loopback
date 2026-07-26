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
import { toast } from "sonner";
import { ArrowLeft, Paperclip, Pencil, Trash2 } from "lucide-react";

const AUTHOR = "dj";

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
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
        <h1 className="text-lg font-semibold">Could not load {id}</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={() => navigate("/queue")}>
          Back to the queue
        </Button>
      </div>
    );
  }
  if (!item) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const failed = (item.extra as {
    failed_responses?: { url: string; status: number; body: string }[];
  }).failed_responses;
  const context = (item.extra as { context?: Record<string, unknown> }).context;

  const save = async (): Promise<void> => {
    try {
      await api.update(id, { ...draft, author: AUTHOR });
      toast.success("Saved — the change is on the audit trail");
      setEditing(false);
      setDraft({});
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const upload = async (file: File): Promise<void> => {
    if (intent === "asset" && !target.trim()) {
      toast.error("An asset needs a target path — where should it land in the repo?");
      return;
    }
    try {
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
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/queue")}>
          <ArrowLeft className="size-4" /> Queue
        </Button>
        <Badge className={`${statusClass[item.status]} rounded-full`}>
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
          <Input
            value={draft.title ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            className="text-base font-medium"
          />
          <Textarea
            value={draft.body ?? ""}
            rows={6}
            onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
          />
          <div className="flex flex-wrap gap-2">
            <Select
              value={draft.severity}
              onValueChange={(v) => setDraft((d) => ({ ...d, severity: v as Severity }))}
            >
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
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
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={save}>Save</Button>
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
                      <a className="underline" href={String(v)}>{String(v)}</a>
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
          <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
            <Badge
              className={`rounded-full ${
                a.intent === "asset" ? statusClass.verified : "bg-muted text-foreground"
              }`}
            >
              {a.intent}
            </Badge>
            {a.mime.startsWith("image/") && (
              <img src={a.url} alt={a.name} className="h-10 w-10 rounded border object-cover" />
            )}
            <a className="underline" href={a.url} target="_blank" rel="noreferrer">{a.name}</a>
            <span className="text-xs text-muted-foreground">{bytes(a.size)}</span>
            {a.target_path && (
              <span className="text-xs">
                → <code className="font-mono">{a.target_path}</code>
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={async () => {
                await api.detach(id, a.id);
                toast.success("Removed");
                reload();
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}

        <div className="grid gap-2 sm:grid-cols-[150px_1fr_auto] sm:items-center">
          <Select value={intent} onValueChange={(v) => setIntent(v as "reference" | "asset")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="reference">reference</SelectItem>
              <SelectItem value="asset">asset</SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder={
              intent === "asset"
                ? "Target path in the repo, e.g. public/logos/adpushup.svg"
                : "Context for the fix — no target path needed"
            }
            value={target}
            disabled={intent === "reference"}
            onChange={(e) => setTarget(e.target.value)}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            Choose file
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
            {item.comments.map((c) => (
              <div key={c.id} className="border-l-2 pl-2.5">
                <div className="text-xs text-muted-foreground">
                  {c.author} · {c.created_at}
                </div>
                <div className="whitespace-pre-wrap text-sm">{c.body}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="grid gap-2 p-4">
          <span className="text-[11px] font-medium text-muted-foreground">Add a comment</span>
          <Textarea
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What you noticed, decided, or want the agent to know"
          />
          <Button
            size="sm"
            disabled={!comment.trim()}
            onClick={async () => {
              await api.comment(id, comment, AUTHOR);
              setComment("");
              toast.success("Comment added");
              reload();
            }}
          >
            Comment
          </Button>
        </Card>

        <Card className="grid gap-2 p-4">
          <span className="text-[11px] font-medium text-muted-foreground">Change status</span>
          <Select
            value={item.status}
            onValueChange={async (v) => {
              await api.setStatus(id, v as Status, note, AUTHOR);
              setNote("");
              toast.success(`Status is now ${v}`);
              reload();
            }}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="Why (recorded on the trail)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Card>
      </div>
    </div>
  );
}
