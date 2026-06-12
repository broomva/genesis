// FileStateAdapter — a restart-durable Chat SDK StateAdapter (BRO-1492).
//
// `createMemoryState()` keeps subscriptions in process memory, so every restart
// of the bot turns ongoing DMs into black holes: the message is consumed from
// Telegram but the thread is no longer "subscribed", so neither onNewMention
// (not a fresh mention) nor onSubscribedMessage (not subscribed) fires and the
// update is silently dropped.
//
// This adapter persists the SUBSCRIPTION SET to a JSON file (the only state
// that must survive a restart — agent conversation context lives in Genesis
// PGlite, keyed by threadId, independent of the bot). Everything ephemeral —
// locks, queues, kv cache — delegates to an internal MemoryStateAdapter, which
// is correct: a lock or queue entry held by a dead process MUST NOT survive it.
//
// Redis stays the multi-replica production option (`RedisStateAdapter`); this
// file adapter fits the single-instance owned-compute / local tier.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Lock, QueueEntry, StateAdapter } from "chat";

interface Persisted {
  subscriptions: string[];
}

export class FileStateAdapter implements StateAdapter {
  private readonly subscriptions = new Set<string>();
  private readonly ephemeral = createMemoryState();

  constructor(private readonly filePath: string) {}

  async connect(): Promise<void> {
    await this.ephemeral.connect();
    this.load();
  }

  async disconnect(): Promise<void> {
    await this.ephemeral.disconnect();
  }

  // --- subscriptions: persisted ------------------------------------------

  async subscribe(threadId: string): Promise<void> {
    if (this.subscriptions.has(threadId)) return;
    this.subscriptions.add(threadId);
    this.persist();
  }

  async unsubscribe(threadId: string): Promise<void> {
    if (this.subscriptions.delete(threadId)) this.persist();
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.subscriptions.has(threadId);
  }

  /** Pre-seed a subscription synchronously before connect() (recovery). */
  seed(threadId: string): void {
    this.subscriptions.add(threadId);
    this.persist();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<Persisted>;
      for (const t of raw.subscriptions ?? []) this.subscriptions.add(t);
    } catch {
      // missing / unreadable / corrupt file → start empty (and overwrite on next change)
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const payload: Persisted = { subscriptions: [...this.subscriptions] };
      // Atomic write (P20 review): write to a temp file then rename, so a crash
      // mid-write can never leave a truncated file that load() would treat as
      // corrupt and DISCARD — which would silently wipe every group
      // subscription (the exact black-hole class this fix exists to kill).
      // rename(2) is atomic on POSIX; a reader sees either the old or new file.
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, this.filePath);
    } catch (e) {
      // Persisting must never crash the bot — a dropped write just means this
      // thread re-subscribes on its next inbound after a restart.
      console.error("[genesis-bot] FileStateAdapter persist failed", e);
    }
  }

  // --- ephemeral: delegate to the in-memory adapter ----------------------

  acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return this.ephemeral.acquireLock(threadId, ttlMs);
  }
  forceReleaseLock(threadId: string): Promise<void> {
    return this.ephemeral.forceReleaseLock(threadId);
  }
  releaseLock(lock: Lock): Promise<void> {
    return this.ephemeral.releaseLock(lock);
  }
  extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    return this.ephemeral.extendLock(lock, ttlMs);
  }
  get<T = unknown>(key: string): Promise<T | null> {
    return this.ephemeral.get<T>(key);
  }
  set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    return this.ephemeral.set<T>(key, value, ttlMs);
  }
  setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.ephemeral.setIfNotExists(key, value, ttlMs);
  }
  delete(key: string): Promise<void> {
    return this.ephemeral.delete(key);
  }
  appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    return this.ephemeral.appendToList(key, value, options);
  }
  getList<T = unknown>(key: string): Promise<T[]> {
    return this.ephemeral.getList<T>(key);
  }
  enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    return this.ephemeral.enqueue(threadId, entry, maxSize);
  }
  dequeue(threadId: string): Promise<QueueEntry | null> {
    return this.ephemeral.dequeue(threadId);
  }
  queueDepth(threadId: string): Promise<number> {
    return this.ephemeral.queueDepth(threadId);
  }
}

/** State file path for a bot state dir. */
export function botStateFile(dir: string): string {
  return `${dir.replace(/\/$/, "")}/telegram-subscriptions.json`;
}

export function createFileState(filePath: string): FileStateAdapter {
  return new FileStateAdapter(filePath);
}
