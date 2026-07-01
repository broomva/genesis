import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import type { Workspace, WorkspaceRepository } from "@genesis/core";

// FS adapter for the workspace registry (BRO-1629, Phase 2.5 · slice 1b). The
// source of truth is one JSON manifest per workspace under a genesis-managed
// directory — durable on disk (survives restart, the core complaint) and readable
// by the agent's own tools. If the directory is inside a git repo, each mutation
// is committed (git as the transaction log: history, audit, rollback, sync); if
// not, the plain files are still durable. Manifests live in a genesis metadata
// dir, NOT inside the user's repos, so a workspace's own tree stays clean.
//
// (JSON, not TOML as the spec sketched, to stay zero-dependency — the manifest is
//  still a plaintext file the agent reads natively; a TOML carrier can follow.)

const MANIFEST_RE = /\.json$/;

export class FsWorkspaceRepository implements WorkspaceRepository {
  constructor(
    private readonly dir: string,
    /** Commit each mutation when `dir` is a git repo (best-effort). */
    private readonly git = true,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** `<dir>/<id>.json`, with the id validated as a single safe path component
   *  (defense-in-depth — the id is already wire-charset-guarded, but a manifest
   *  filename must never escape the dir). */
  private fileFor(id: string): string {
    const base = resolve(this.dir);
    const file = resolve(this.dir, `${id}.json`);
    if (
      id.includes("/") ||
      id.includes("\\") ||
      id.includes("..") ||
      !file.startsWith(base + sep)
    ) {
      throw new Error(`unsafe workspace id for a manifest filename: ${JSON.stringify(id)}`);
    }
    return file;
  }

  /** Keep only the known Workspace fields (drop anything unexpected in a manifest). */
  private coerce(raw: Record<string, unknown>): Workspace | undefined {
    if (
      typeof raw.id !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.rootPath !== "string"
    )
      return undefined;
    return {
      id: raw.id,
      name: raw.name,
      rootPath: raw.rootPath,
      ...(typeof raw.isGitRepo === "boolean" ? { isGitRepo: raw.isGitRepo } : {}),
      ...(typeof raw.noWorktree === "boolean" ? { noWorktree: raw.noWorktree } : {}),
    };
  }

  async list(): Promise<Workspace[]> {
    if (!existsSync(this.dir)) return [];
    const out: Workspace[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!MANIFEST_RE.test(f)) continue;
      try {
        const ws = this.coerce(JSON.parse(readFileSync(resolve(this.dir, f), "utf8")));
        if (ws) out.push(ws);
        else console.warn(`[genesis] workspace manifest ${f} missing required fields; skipping.`);
      } catch (e) {
        console.warn(
          `[genesis] unreadable workspace manifest ${f}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // Stable order (id) so list()/listWorkspaces() are deterministic across boots.
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async get(id: string): Promise<Workspace | undefined> {
    const file = this.fileFor(id);
    if (!existsSync(file)) return undefined;
    try {
      return this.coerce(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return undefined;
    }
  }

  async register(ws: Workspace): Promise<Workspace> {
    const file = this.fileFor(ws.id);
    const rec = this.coerce({ ...ws }) ?? ws;
    // Write to a temp file + rename → the manifest is never observed half-written.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
    renameSync(tmp, file);
    this.commit(`register workspace ${ws.id}`);
    return rec;
  }

  async remove(id: string): Promise<void> {
    const file = this.fileFor(id);
    if (existsSync(file)) {
      rmSync(file);
      this.commit(`remove workspace ${id}`);
    }
  }

  /** Best-effort commit — a no-op if `dir` isn't a git repo or there's nothing to
   *  commit. The files are durable regardless; git adds history/audit/sync. */
  private commit(message: string): void {
    if (!this.git) return;
    try {
      execFileSync("git", ["-C", this.dir, "add", "-A"], { stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-C",
          this.dir,
          "-c",
          "user.email=genesis@local",
          "-c",
          "user.name=genesis",
          "commit",
          "-q",
          "-m",
          message,
        ],
        { stdio: "ignore" },
      );
    } catch {
      // not a git repo, or nothing staged — durable on disk anyway.
    }
  }
}
