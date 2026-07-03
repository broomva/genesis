"use client";

import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitVertical,
  Loader2,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import {
  type DirListing,
  type FileContent,
  classifyFile,
  fetchDir,
  fetchFile,
  parseFrontmatter,
  rawFileUrl,
  splitFrontmatter,
} from "@/lib/files";
import {
  type GitFileEntry,
  type GitStatusData,
  commitAndPush,
  fetchGitDiff,
  fetchGitStatus,
  fileIsStagedOnly,
  statusBadge,
  validateCommitMessage,
} from "@/lib/git";
import { cn } from "@/lib/utils";

type Tab = "files" | "changes";

/** Join a relative dir path with a child name (both relative to the workspace root). */
function childPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Human-readable byte size (files only). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type DirState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; listing: DirListing };

/** Fetch a directory listing when `enabled`. Aborts on unmount / dep change. */
function useDir(workspaceId: string, path: string, enabled: boolean): DirState | null {
  const [state, setState] = useState<DirState | null>(null);
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchDir(workspaceId, path, ctrl.signal)
      .then((listing) => {
        if (!ctrl.signal.aborted) setState({ status: "ready", listing });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ status: "error", error: e instanceof Error ? e.message : "failed to load" });
      });
    return () => ctrl.abort();
  }, [workspaceId, path, enabled]);
  return state;
}

const ROW =
  "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-[var(--bv-canvas-soft-2)] [@media(pointer:coarse)]:py-2";

/** A file leaf — tap to open it in the viewer. */
function FileRow({
  entry,
  path,
  depth,
  onOpen,
}: {
  entry: { name: string; size?: number };
  path: string;
  depth: number;
  onOpen: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={ROW}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onClick={() => onOpen(path)}
      data-testid="ws-tree-row"
      data-path={path}
    >
      <FileIcon className="text-muted-foreground size-4 shrink-0" />
      <span className="truncate">{entry.name}</span>
      {typeof entry.size === "number" ? (
        <span className="text-muted-foreground ml-auto shrink-0 pl-2 text-[0.7rem] tabular-nums">
          {formatSize(entry.size)}
        </span>
      ) : null}
    </button>
  );
}

/** A directory node — lazily fetches its children the first time it's expanded. */
function DirRow({
  workspaceId,
  entry,
  path,
  depth,
  onOpenFile,
}: {
  workspaceId: string;
  entry: { name: string };
  path: string;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const dir = useDir(workspaceId, path, open);
  return (
    <>
      <button
        type="button"
        className={ROW}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="ws-tree-row"
        data-path={path}
      >
        <ChevronRight
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <Folder className="size-4 shrink-0 text-[var(--bv-blue-text)]" />
        <span className="truncate">{entry.name}</span>
      </button>
      {open ? (
        <div>
          {dir?.status === "loading" ? (
            <p
              className="text-muted-foreground flex items-center gap-1.5 py-1 text-xs"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
            >
              <Loader2 className="size-3 animate-spin" /> Loading…
            </p>
          ) : null}
          {dir?.status === "error" ? (
            <p
              className="text-[var(--bv-danger)] py-1 text-xs"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
            >
              {dir.error}
            </p>
          ) : null}
          {dir?.status === "ready" ? (
            dir.listing.entries.length === 0 ? (
              <p
                className="text-muted-foreground py-1 text-xs italic"
                style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
              >
                empty
              </p>
            ) : (
              <FsNodes
                workspaceId={workspaceId}
                listing={dir.listing}
                depth={depth + 1}
                onOpenFile={onOpenFile}
              />
            )
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Render a listing's entries as rows (dirs, then files — server already sorts). */
function FsNodes({
  workspaceId,
  listing,
  depth,
  onOpenFile,
}: {
  workspaceId: string;
  listing: DirListing;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  return (
    <>
      {listing.entries.map((entry) => {
        const path = childPath(listing.path, entry.name);
        return entry.type === "dir" ? (
          <DirRow
            key={path}
            workspaceId={workspaceId}
            entry={entry}
            path={path}
            depth={depth}
            onOpenFile={onOpenFile}
          />
        ) : (
          <FileRow key={path} entry={entry} path={path} depth={depth} onOpen={onOpenFile} />
        );
      })}
      {listing.truncated ? (
        <p
          className="text-muted-foreground py-1 text-xs italic"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          …folder truncated (showing {listing.entries.length})
        </p>
      ) : null}
    </>
  );
}

type FileTextState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; file: FileContent };

/** Fetch a file's TEXT contents when `enabled` (skipped for image/pdf, and for html
 *  in rendered view). Aborts on unmount / dep change. */
function useFileText(workspaceId: string, path: string, enabled: boolean): FileTextState | null {
  const [state, setState] = useState<FileTextState | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchFile(workspaceId, path, ctrl.signal)
      .then((file) => {
        if (!ctrl.signal.aborted) setState({ status: "ready", file });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ status: "error", error: e instanceof Error ? e.message : "failed to load" });
      });
    return () => ctrl.abort();
  }, [workspaceId, path, enabled]);
  return state;
}

/** An "open in a new tab" affordance for binary / non-renderable files + a label. */
function OpenRaw({ src, label }: { src: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 p-8 text-center">
      <p className="text-muted-foreground text-sm italic">{label}</p>
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--bv-blue-text)] inline-flex items-center gap-1.5 text-sm underline underline-offset-2"
      >
        <ExternalLink className="size-4" /> Open in a new tab
      </a>
    </div>
  );
}

/** Render an image via <img> (SVG included — img-context SVG can't run scripts). */
function ImageView({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <OpenRaw src={src} label="Couldn't display this image." />;
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      {/* Raw workspace bytes (dynamic, not a static asset) — next/image can't optimize it. */}
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/** The parsed YAML frontmatter of a markdown file, as a distinct metadata panel. */
function FrontmatterPanel({ raw }: { raw: string }) {
  const rows = parseFrontmatter(raw);
  return (
    <div className="border-border bg-[var(--bv-canvas-soft-2)] mb-4 rounded-lg border p-3">
      <p className="text-muted-foreground mb-2 text-[0.65rem] font-semibold tracking-wider uppercase">
        Frontmatter
      </p>
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map((r) => (
            <Fragment key={r.key}>
              <dt className="text-muted-foreground font-mono">{r.key}</dt>
              <dd className="text-foreground min-w-0 break-words">{r.value || "—"}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <pre className="text-foreground overflow-x-auto font-mono text-xs whitespace-pre-wrap">
          {raw}
        </pre>
      )}
    </div>
  );
}

/** Truncation notice shared across text renderers. */
function TruncNote({ size }: { size: number }) {
  return (
    <p className="text-muted-foreground border-border border-t px-4 py-2 text-xs italic">
      Truncated — showing the first {formatSize(256 * 1024)} of {formatSize(size)}.
    </p>
  );
}

/** Render fetched text per kind/view: markdown (frontmatter + Streamdown), highlighted
 *  code, or plain monospace source; binary/empty/loading/error notices. */
function TextContent({
  text,
  kind,
  lang,
  view,
  rawUrl,
}: {
  text: FileTextState | null;
  kind: "markdown" | "html" | "code" | "text";
  lang?: string;
  view: "rendered" | "source";
  rawUrl: string;
}) {
  if (!text || text.status === "loading")
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 p-4 text-xs">
        <Loader2 className="size-3 animate-spin" /> Loading…
      </p>
    );
  if (text.status === "error")
    return <p className="text-[var(--bv-danger)] p-4 text-sm">{text.error}</p>;
  const file = text.file;
  if (file.binary)
    return <OpenRaw src={rawUrl} label={`Binary file (${formatSize(file.size)}) — not shown.`} />;
  if (file.content.length === 0)
    return <p className="text-muted-foreground p-4 text-sm italic">Empty file.</p>;

  const trunc = file.truncated ? <TruncNote size={file.size} /> : null;

  // Markdown, rendered: frontmatter panel + streamdown body.
  if (kind === "markdown" && view === "rendered") {
    const { frontmatter, body } = splitFrontmatter(file.content);
    return (
      <div className="p-4">
        {frontmatter ? <FrontmatterPanel raw={frontmatter} /> : null}
        <div className="text-foreground text-[0.9rem] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Streamdown>{body}</Streamdown>
        </div>
        {trunc}
      </div>
    );
  }
  // Code, small + no stray fence: syntax-highlighted via a fenced block.
  if (kind === "code" && lang && file.content.length < 100_000 && !file.content.includes("```")) {
    return (
      <div className="p-4 text-xs">
        <Streamdown>{`\`\`\`${lang}\n${file.content}\n\`\`\``}</Streamdown>
        {trunc}
      </div>
    );
  }
  // Plain source (text, large/edge code, markdown-source, html-source).
  return (
    <>
      <pre className="text-foreground overflow-x-auto p-4 font-mono text-xs leading-relaxed whitespace-pre">
        {file.content}
      </pre>
      {trunc}
    </>
  );
}

/** The open-file viewer — routes by file type (BRO-1667): markdown (frontmatter +
 *  rendered body), images/SVG (<img>), HTML (sandboxed iframe), highlighted code, or
 *  plain text. Markdown + HTML get a Rendered/Source toggle. */
function FileViewer({
  workspaceId,
  path,
  onBack,
}: {
  workspaceId: string;
  path: string;
  onBack: () => void;
}) {
  const cls = classifyFile(path);
  const [view, setView] = useState<"rendered" | "source">("rendered");
  const rawUrl = rawFileUrl(workspaceId, path);
  const canToggle = cls.kind === "markdown" || cls.kind === "html";
  // Text is needed for md/code/text, and for html only in Source view.
  const wantText =
    cls.kind === "markdown" ||
    cls.kind === "code" ||
    cls.kind === "text" ||
    (cls.kind === "html" && view === "source");
  const text = useFileText(workspaceId, path, wantText);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ws-file-view">
      <div className="border-border flex items-center gap-2 border-b px-2 py-2">
        <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label="Back to files">
          <ArrowLeft className="size-4" />
        </Button>
        <span
          className="text-foreground min-w-0 flex-1 truncate font-mono text-xs"
          title={path}
          data-testid="ws-file-path"
        >
          {path}
        </span>
        {canToggle ? (
          <SegmentedControl
            type="single"
            value={view}
            onValueChange={(v) => {
              if (v === "rendered" || v === "source") setView(v);
            }}
            aria-label="View mode"
            className="shrink-0"
          >
            <SegmentedControlItem value="rendered" className="h-6 px-2 text-xs">
              Rendered
            </SegmentedControlItem>
            <SegmentedControlItem value="source" className="h-6 px-2 text-xs">
              Source
            </SegmentedControlItem>
          </SegmentedControl>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {cls.kind === "image" ? (
          <ImageView src={rawUrl} alt={path} />
        ) : cls.kind === "pdf" ? (
          <OpenRaw src={rawUrl} label="PDF document." />
        ) : cls.kind === "html" && view === "rendered" ? (
          <iframe
            title={path}
            sandbox=""
            src={rawUrl}
            className="h-full w-full border-0 bg-white"
            data-testid="ws-html-frame"
          />
        ) : (
          <TextContent text={text} kind={cls.kind} lang={cls.lang} view={view} rawUrl={rawUrl} />
        )}
      </div>
    </div>
  );
}

/** Tailwind color per porcelain status badge. */
function badgeClass(badge: string): string {
  switch (badge) {
    case "M":
      return "text-[var(--bv-amber-text,#b8860b)] border-[var(--bv-amber-text,#b8860b)]/40";
    case "A":
      return "text-[var(--bv-green-text,#2e7d32)] border-[var(--bv-green-text,#2e7d32)]/40";
    case "D":
      return "text-[var(--bv-danger)] border-[var(--bv-danger)]/40";
    case "U":
      return "text-muted-foreground border-border";
    default: // R / C / others
      return "text-[var(--bv-blue-text)] border-[var(--bv-blue-text)]/40";
  }
}

/** Per-line class for a unified-diff line (add/remove/hunk/header/context). */
function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground";
  if (line.startsWith("@@")) return "text-[var(--bv-blue-text)] bg-[var(--bv-blue-text)]/8";
  if (line.startsWith("+"))
    return "text-[var(--bv-green-text,#2e7d32)] bg-[var(--bv-green-text,#2e7d32)]/8";
  if (line.startsWith("-")) return "text-[var(--bv-danger)] bg-[var(--bv-danger)]/8";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-muted-foreground";
  return "text-foreground";
}

/** The diff viewer for one changed file — colored unified diff, binary/empty notices. */
function DiffViewer({
  workspaceId,
  path,
  cached,
  onBack,
}: {
  workspaceId: string;
  path: string;
  cached: boolean;
  onBack: () => void;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "ready"; diff: string; binary: boolean; truncated: boolean }
  >({ status: "loading" });
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchGitDiff(workspaceId, path, cached, ctrl.signal)
      .then((d) => {
        if (!ctrl.signal.aborted)
          setState({ status: "ready", diff: d.diff, binary: d.binary, truncated: d.truncated });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ status: "error", error: e instanceof Error ? e.message : "failed to load" });
      });
    return () => ctrl.abort();
  }, [workspaceId, path, cached]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ws-diff-view">
      <div className="border-border flex items-center gap-2 border-b px-2 py-2">
        <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label="Back to changes">
          <ArrowLeft className="size-4" />
        </Button>
        <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
        </span>
        {cached ? (
          <span className="text-muted-foreground border-border shrink-0 rounded border px-1.5 py-0.5 text-[0.65rem]">
            staged
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-xs leading-relaxed">
        {state.status === "loading" ? (
          <p className="text-muted-foreground flex items-center gap-1.5 p-4">
            <Loader2 className="size-3 animate-spin" /> Loading…
          </p>
        ) : null}
        {state.status === "error" ? (
          <p className="text-[var(--bv-danger)] p-4 text-sm">{state.error}</p>
        ) : null}
        {state.status === "ready" ? (
          state.binary ? (
            <p className="text-muted-foreground p-4 text-sm italic">
              Binary file — diff not shown.
            </p>
          ) : state.diff.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm italic">
              No diff to show — the file may be untracked (open it in Repo Files) or unchanged.
            </p>
          ) : (
            <>
              {state.diff.split("\n").map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are stable + ordered
                <div key={i} className={cn("whitespace-pre px-4", diffLineClass(line))}>
                  {line || " "}
                </div>
              ))}
              {state.truncated ? (
                <p className="text-muted-foreground border-border mt-2 border-t px-4 py-2 text-xs italic">
                  Diff truncated (large file).
                </p>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

/** One changed-file row: a status badge, the path (with rename origin), +/- counts. */
function FileStatusRow({ file, onOpen }: { file: GitFileEntry; onOpen: () => void }) {
  const badge = statusBadge(file);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-[var(--bv-canvas-soft-2)] [@media(pointer:coarse)]:py-2"
      onClick={onOpen}
      data-testid="ws-change-row"
      data-path={file.path}
    >
      <span
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded border font-mono text-[0.7rem] font-medium",
          badgeClass(badge),
        )}
      >
        {badge}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {file.orig ? <span className="text-muted-foreground">{file.orig} → </span> : null}
        {file.path}
      </span>
      {file.added !== null || file.deleted !== null ? (
        <span className="shrink-0 pl-2 font-mono text-[0.7rem] tabular-nums">
          {file.added !== null ? (
            <span className="text-[var(--bv-green-text,#2e7d32)]">+{file.added}</span>
          ) : null}{" "}
          {file.deleted !== null ? (
            <span className="text-[var(--bv-danger)]">-{file.deleted}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/** Commit & Push composer (BRO-1666 Slice 3, owner-only) — a message field + a
 *  Commit&Push action. Commits TRACKED edits (not untracked, P20 HIGH-1), pushes to
 *  the upstream; owner-gated at the BFF (an agent principal gets 403, surfaced here as
 *  an error). The success confirmation is lifted to the PARENT (`onCommitted(note)`),
 *  because a clean tree after commit unmounts this box (CodeRabbit) — the note would
 *  otherwise vanish before it's read. */
function CommitBox({
  workspaceId,
  hasUntracked,
  onCommitted,
}: {
  workspaceId: string;
  /** True when the change set includes untracked files — they are NOT committed
   *  (commit stages tracked edits only, P20 HIGH-1), so tell the user. */
  hasUntracked: boolean;
  /** Called on a successful commit with a human-readable confirmation note; the
   *  parent owns + persists it (this box may unmount when the tree goes clean). */
  onCommitted: (note: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const invalid = validateCommitMessage(message);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const r = await commitAndPush(workspaceId, message, true);
      const short = r.sha.slice(0, 7);
      setMessage("");
      onCommitted(
        r.pushed
          ? `Committed + pushed (${short}).`
          : r.pushError
            ? `Committed (${short}) — ${r.pushError}`
            : `Committed (${short}).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "commit failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-border mt-2 border-t px-2 pt-3">
      <textarea
        value={message}
        onChange={(e) => {
          setMessage(e.target.value);
          setError(null);
        }}
        placeholder="Commit message…"
        rows={2}
        data-testid="ws-commit-message"
        className="border-border bg-background focus-visible:ring-ring/50 w-full resize-none rounded-md border px-2.5 py-2 text-sm outline-none focus-visible:ring-3"
      />
      {hasUntracked ? (
        <p className="text-muted-foreground mt-1 px-0.5 text-xs">
          New (U) files aren't included — only edits to tracked files are committed.
        </p>
      ) : null}
      {error ? <p className="text-[var(--bv-danger)] mt-1 px-0.5 text-xs">{error}</p> : null}
      <div className="mt-2 flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={busy || message.trim().length === 0}
          data-testid="ws-commit-submit"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <GitCommitVertical className="size-3.5" />
          )}
          Commit &amp; Push
        </Button>
      </div>
    </div>
  );
}

/** The Changes tab (BRO-1666 Slice 2/3): git status list + per-file diff (read-only)
 *  + a Commit&Push composer (Slice 3, owner-only). Fetches status when the tab becomes
 *  active (and after a commit); tapping a file opens its diff (staged when the file is
 *  staged-only, else the working-tree diff). */
function ChangesPanel({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; error: string }
    | { status: "ready"; data: GitStatusData }
    | null
  >(null);
  const [openDiff, setOpenDiff] = useState<{ path: string; cached: boolean } | null>(null);
  // Bumped after a commit so the status list refetches (files should clear).
  const [reloadKey, setReloadKey] = useState(0);
  // Commit confirmation, owned HERE so it survives CommitBox unmounting when the tree
  // goes clean after a commit (CodeRabbit).
  const [commitNote, setCommitNote] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a deliberate refetch trigger
  useEffect(() => {
    if (!active || !workspaceId) return;
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetchGitStatus(workspaceId, ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ status: "ready", data });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        setState({ status: "error", error: e instanceof Error ? e.message : "failed to load" });
      });
    return () => ctrl.abort();
  }, [workspaceId, active, reloadKey]);
  // Close any open diff + clear the commit note when the workspace changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on workspace change
  useEffect(() => {
    setOpenDiff(null);
    setCommitNote(null);
  }, [workspaceId]);

  if (openDiff) {
    return (
      <DiffViewer
        workspaceId={workspaceId}
        path={openDiff.path}
        cached={openDiff.cached}
        onBack={() => setOpenDiff(null)}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
      {!workspaceId ? (
        <p className="text-muted-foreground p-4 text-sm">No workspace selected.</p>
      ) : !state || state.status === "loading" ? (
        <p className="text-muted-foreground flex items-center gap-1.5 p-4 text-sm">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </p>
      ) : state.status === "error" ? (
        <p className="text-[var(--bv-danger)] p-4 text-sm">{state.error}</p>
      ) : !state.data.isGitRepo ? (
        <p className="text-muted-foreground p-4 text-sm italic">
          This workspace is not a git repository.
        </p>
      ) : (
        <>
          {state.data.branch ? (
            <div className="text-muted-foreground mb-1 flex items-center gap-1.5 px-2 py-1 text-xs">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="text-foreground truncate font-medium">{state.data.branch}</span>
              {state.data.ahead > 0 ? <span title="ahead">↑{state.data.ahead}</span> : null}
              {state.data.behind > 0 ? <span title="behind">↓{state.data.behind}</span> : null}
              {state.data.upstream ? (
                <span className="truncate">· {state.data.upstream}</span>
              ) : null}
            </div>
          ) : null}
          {commitNote ? (
            <p
              className="mb-1 rounded-md bg-[var(--bv-canvas-soft-2)] px-2.5 py-1.5 text-xs text-[var(--bv-green-text,#2e7d32)]"
              data-testid="ws-commit-note"
            >
              {commitNote}
            </p>
          ) : null}
          {state.data.files.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm italic">
              No changes — the working tree is clean.
            </p>
          ) : (
            state.data.files.map((f) => (
              <FileStatusRow
                key={f.path}
                file={f}
                onOpen={() => setOpenDiff({ path: f.path, cached: fileIsStagedOnly(f) })}
              />
            ))
          )}
          {state.data.truncated ? (
            <p className="text-muted-foreground px-2 py-1 text-xs italic">
              …too many changes to show all.
            </p>
          ) : null}
          {state.data.files.length > 0 ? (
            <CommitBox
              workspaceId={workspaceId}
              hasUntracked={state.data.files.some((f) => f.untracked)}
              onCommitted={(note) => {
                setCommitNote(note);
                setReloadKey((k) => k + 1);
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** The read-only workspace filesystem browser (BRO-1666): a right-anchored slide-over
 *  (radix Dialog — focus-trap + Escape + scroll-lock), cloning the SettingsSheet
 *  structure. Two live tabs — Repo Files (Slice 1, lazy tree) + Changes (Slice 2, git
 *  status + diff); Checks is a stub for Slice 4. Browses the ACTIVE thread's bound
 *  workspace root. */
export function WorkspaceBrowser({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The active thread's bound workspace id (else the selected one). "" → nothing to
   *  browse (the body shows an empty state). */
  workspaceId: string;
  /** Display name for the header subtitle. */
  workspaceName?: string;
}) {
  const [tab, setTab] = useState<Tab>("files");
  // Root listing — (re)fetched when the sheet opens or the workspace changes.
  const root = useDir(workspaceId, "", open);
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  // Reset the open file + tab whenever the workspace changes or the sheet re-opens
  // (the tree remounts via key={workspaceId}; this clears the viewer + returns to Files).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open/workspace change
  useEffect(() => {
    setOpenFilePath(null);
    setTab("files");
  }, [workspaceId, open]);

  const onOpenFile = useCallback((path: string) => setOpenFilePath(path), []);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[oklch(0.14_0.025_270/0.45)] duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          data-slot="workspace-browser"
          data-testid="workspace-browser"
          className={cn(
            "bg-background text-foreground border-border fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l shadow-xl outline-none sm:max-w-lg",
            "duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          )}
        >
          <div className="border-border flex items-center justify-between gap-2 border-b px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-3">
            <div className="flex min-w-0 items-center gap-2">
              <FolderGit2 className="size-4 shrink-0 text-[var(--bv-blue-text)]" />
              <div className="min-w-0">
                <DialogPrimitive.Title className="font-heading text-base font-medium leading-tight tracking-tight">
                  Files
                </DialogPrimitive.Title>
                {workspaceName ? (
                  <p className="text-muted-foreground truncate text-xs leading-tight">
                    {workspaceName}
                  </p>
                ) : null}
              </div>
            </div>
            <DialogPrimitive.Close asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Close files">
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">
            Browse the files in this session's workspace.
          </DialogPrimitive.Description>

          {/* Tab strip (screenshot parity) — Repo Files (Slice 1) + Changes (Slice 2)
              are live; Checks is a stub for Slice 4. */}
          <div className="border-border border-b px-4 py-2.5">
            <SegmentedControl
              type="single"
              value={tab}
              onValueChange={(v) => {
                if (v === "files" || v === "changes") setTab(v);
              }}
              aria-label="Workspace section"
            >
              <SegmentedControlItem value="files" data-testid="ws-tab-files">
                Repo Files
              </SegmentedControlItem>
              <SegmentedControlItem value="changes" data-testid="ws-tab-changes">
                Changes
              </SegmentedControlItem>
              <SegmentedControlItem value="checks" disabled title="Coming soon">
                Checks
              </SegmentedControlItem>
            </SegmentedControl>
          </div>

          {tab === "changes" ? (
            <ChangesPanel workspaceId={workspaceId} active={open && tab === "changes"} />
          ) : openFilePath ? (
            <FileViewer
              workspaceId={workspaceId}
              path={openFilePath}
              onBack={() => setOpenFilePath(null)}
            />
          ) : (
            <div
              key={workspaceId}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
            >
              {!workspaceId ? (
                <p className="text-muted-foreground p-4 text-sm">No workspace selected.</p>
              ) : root?.status === "loading" ? (
                <p className="text-muted-foreground flex items-center gap-1.5 p-4 text-sm">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </p>
              ) : root?.status === "error" ? (
                <p className="text-[var(--bv-danger)] p-4 text-sm">{root.error}</p>
              ) : root?.status === "ready" ? (
                root.listing.entries.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-sm italic">
                    This workspace is empty.
                  </p>
                ) : (
                  <FsNodes
                    workspaceId={workspaceId}
                    listing={root.listing}
                    depth={0}
                    onOpenFile={onOpenFile}
                  />
                )
              ) : null}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
