import { describe, expect, mock, test } from "bun:test";

/** The BFF must forward the query string to the engine.
 *
 * It proxied a LITERAL "/threads", so `?limit=`/`?offset=` were dropped — which
 * made the engine's 200-row page bound UNREACHABLE through the only route the
 * browser can use, not merely unimplemented by the current client. With 226
 * threads on the deployed box that silently hid 26 of them.
 *
 * The proxy is mocked so this asserts the PATH this route builds, which is the
 * thing that was wrong; the proxy's own behaviour is not under test here. */
const seen: string[] = [];
mock.module("@/lib/genesis-proxy", () => ({
  proxyGenesisGetJson: async (path: string) => {
    seen.push(path);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  },
}));
mock.module("@/lib/api-auth", () => ({
  authorizePrincipal: async () => ({ ok: true, asAgent: false }),
}));

const { GET } = await import("./route");

describe("GET /api/threads", () => {
  test("forwards limit and offset to the engine", async () => {
    seen.length = 0;
    await GET(new Request("http://web/api/threads?limit=200&offset=200"));
    expect(seen).toEqual(["/threads?limit=200&offset=200"]);
  });

  test("sends no query string when the caller sent none", async () => {
    seen.length = 0;
    await GET(new Request("http://web/api/threads"));
    expect(seen).toEqual(["/threads"]);
  });
});
