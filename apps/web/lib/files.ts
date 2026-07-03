// Client helpers for the read-only workspace filesystem browser (BRO-1666 Slice 1).
// Talks to the BFF proxy (/api/workspaces/:id/files|file) — never the engine
// directly. Only RELATIVE paths + file contents ever come back; the server-only
// rootPath never leaves the engine. The normalizers are pure (testable without a
// fetch) and defensive: a malformed entry is dropped rather than crashing the tree.

/** One filesystem entry in a directory listing. */
export interface FsEntry {
  /** A single path segment (never a path). */
  name: string;
  type: "dir" | "file";
  /** Byte size, files only. */
  size?: number;
}

/** A directory listing: the canonical relative `path` (""= root) + its entries.
 *  `truncated` is true when the directory had more than the server cap (the entries
 *  are the first N — dirs-first). */
export interface DirListing {
  path: string;
  entries: FsEntry[];
  truncated: boolean;
}

/** A file read result — mirrors the engine's `readWorkspaceFile` shape. */
export interface FileContent {
  path: string;
  /** UTF-8 contents (empty when `binary`), capped server-side (~256 KB). */
  content: string;
  /** True when the file exceeds the server cap (content is the leading slice). */
  truncated: boolean;
  /** True when the file is binary (content is ""). */
  binary: boolean;
  /** The file's full byte size on disk. */
  size: number;
}

/** Coerce an untrusted `/files` body into a clean {@link DirListing}. Drops any
 *  malformed entry (bad name / type) so a single bad row can't break the tree. */
export function normalizeListing(data: unknown): DirListing {
  const d = (data ?? {}) as { path?: unknown; entries?: unknown };
  const entries: FsEntry[] = Array.isArray(d.entries)
    ? d.entries
        .filter(
          (e): e is { name: string; type: "dir" | "file"; size?: unknown } =>
            typeof (e as FsEntry)?.name === "string" &&
            (e as FsEntry).name.length > 0 &&
            ((e as FsEntry)?.type === "dir" || (e as FsEntry)?.type === "file"),
        )
        .map((e) => ({
          name: e.name,
          type: e.type,
          ...(typeof e.size === "number" ? { size: e.size } : {}),
        }))
    : [];
  return {
    path: typeof d.path === "string" ? d.path : "",
    entries,
    truncated: (d as { truncated?: unknown }).truncated === true,
  };
}

/** Coerce an untrusted `/file` body into a clean {@link FileContent}. */
export function normalizeFile(data: unknown): FileContent {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    path: typeof d.path === "string" ? d.path : "",
    content: typeof d.content === "string" ? d.content : "",
    truncated: d.truncated === true,
    binary: d.binary === true,
    size: typeof d.size === "number" ? d.size : 0,
  };
}

/** BFF URL for a file's RAW bytes (images / pdf / html), for `<img>` / `<iframe>`. */
export function rawFileUrl(workspaceId: string, path: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/file/raw?path=${encodeURIComponent(path)}`;
}

/** How the viewer should render a file. */
export type FileKind = "markdown" | "image" | "html" | "pdf" | "code" | "text";

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg", // rendered via <img> — img-context SVG can't execute scripts (safe)
]);
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
// ext → highlighter language hint.
const CODE_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  hpp: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  css: "css",
  scss: "scss",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  swift: "swift",
  lua: "lua",
  r: "r",
};

/** Classify a file by name for the viewer. `lang` (code only) hints the highlighter. */
export function classifyFile(name: string): { kind: FileKind; lang?: string } {
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  if (MARKDOWN_EXT.has(ext)) return { kind: "markdown" };
  if (IMAGE_EXT.has(ext)) return { kind: "image" };
  if (ext === "html" || ext === "htm") return { kind: "html" };
  if (ext === "pdf") return { kind: "pdf" };
  if (ext && CODE_LANG[ext]) return { kind: "code", lang: CODE_LANG[ext] };
  if (base === "dockerfile") return { kind: "code", lang: "dockerfile" };
  if (base === "makefile") return { kind: "code", lang: "makefile" };
  return { kind: "text" };
}

/** Split a leading YAML frontmatter block (`---\n…\n---`) from a markdown body.
 *  `frontmatter` is null when there is no block. Anchored to the very start. */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: m[1] ?? "", body: content.slice(m[0].length) };
}

/** Light parse of a frontmatter block into [key, value] rows for a display table.
 *  Handles the common flat `key: value` case + folds an indented list/block into the
 *  value; a purely nested doc falls back to 0 rows (caller shows the raw block). Not a
 *  full YAML parser. */
export function parseFrontmatter(fm: string): Array<{ key: string; value: string }> {
  const lines = fm.split(/\r?\n/);
  const rows: Array<{ key: string; value: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i]?.match(/^([A-Za-z0-9_.-]+):\s?(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    let value = m[2] ?? "";
    const cont: string[] = [];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j] ?? "")) {
      cont.push((lines[j] ?? "").trim().replace(/^-\s*/, ""));
      j++;
    }
    if (cont.length) value = value ? `${value} ${cont.join(", ")}` : cont.join(", ");
    rows.push({ key: m[1] ?? "", value });
    i = j;
  }
  return rows;
}

/** List a directory under a workspace. `path` is RELATIVE ("" = root). Rejects with
 *  the engine's SAFE error message on a non-OK response (so the UI can surface it). */
export async function fetchDir(
  workspaceId: string,
  path = "",
  signal?: AbortSignal,
): Promise<DirListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/files${qs}`, {
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof (data as { error?: unknown })?.error === "string"
        ? (data as { error: string }).error
        : "could not list directory",
    );
  }
  return normalizeListing(data);
}

/** Read a file under a workspace. `path` is RELATIVE. Rejects with the engine's SAFE
 *  error message on a non-OK response. */
export async function fetchFile(
  workspaceId: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileContent> {
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`,
    { signal },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof (data as { error?: unknown })?.error === "string"
        ? (data as { error: string }).error
        : "could not read file",
    );
  }
  return normalizeFile(data);
}
