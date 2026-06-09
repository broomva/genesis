import { describe, expect, test } from "bun:test";
import { createVercelSandboxHost } from "./sandbox-factory";

// Live Vercel Sandbox integration — runs ONLY when Vercel auth is present.
// Skipped in CI (no creds), so the unit suite stays free + green.
const noCreds = !process.env.VERCEL_OIDC_TOKEN && !process.env.VERCEL_TOKEN;

describe("VercelSandboxHost — live integration (env-gated)", () => {
  test.skipIf(noCreds)(
    "creates a real microVM, runs a command, streams stdout, and stops",
    async () => {
      const handle = await createVercelSandboxHost({
        runtime: "node24",
        networkPolicy: "allow-all",
        timeoutMs: 2 * 60 * 1000,
      });
      try {
        const r = await handle.host.exec(["echo", "GENESIS_LIVE_OK"]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("GENESIS_LIVE_OK");

        const lines: string[] = [];
        const stream = handle.host.spawnStream(["printf", "a\\nb\\nc\\n"]);
        for await (const l of stream.stdout) lines.push(l);
        expect(await stream.exitCode).toBe(0);
        expect(lines).toEqual(["a", "b", "c"]);
      } finally {
        await handle.stop();
      }
    },
    120_000,
  );
});
