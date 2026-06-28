// One-time owner bootstrap — the security crux of the single-user gate.
//
// Open signup is disabled (`emailAndPassword.enabled = false` in lib/auth.ts),
// so there is NO public path to create a user. This route is the ONLY way the
// first (owner) user comes into existence, and it is gated by TWO independent
// conditions that BOTH must hold:
//
//   1. AUTH_BOOTSTRAP_TOKEN — the request must present the exact secret token
//      (constant-time compared). A tailnet device that can reach this URL but
//      does NOT hold the token is rejected with 401. This is what stops "any
//      device on the tailnet can register".
//   2. Zero existing users — once an owner exists, the route refuses with 409.
//      Single-user system: the door closes permanently after the first owner.
//
// On success it creates the owner user AND a session, and sets the signed
// Better Auth session cookie on the response. The browser is then authenticated
// and can immediately enroll its first passkey via the normal authed
// passkey-add flow (`authClient.passkey.addPasskey()`), which itself requires a
// session (the passkey plugin's `registration.requireSession` defaults to true).
//
// Why this is safe:
//   • No token  → 401 (cannot create the owner).
//   • Owner exists → 409 (cannot create a second user; bootstrap is spent).
//   • Passkey enrollment requires a session → only the just-bootstrapped owner
//     (or a later passkey-signed-in owner) can add a passkey. There is no path
//     for an unauthenticated, tokenless caller to enroll a credential.
import { auth, ensureAuthDb } from "@/lib/auth";
import { timingSafeEqual } from "@/lib/timing-safe-equal";
import { makeSignature } from "better-auth/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BootstrapBody = {
  token?: unknown;
  email?: unknown;
  name?: unknown;
};

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.AUTH_BOOTSTRAP_TOKEN;
  // If the server has no bootstrap token configured, bootstrap is hard-disabled
  // (fail closed) rather than allowing tokenless creation.
  if (!expected) {
    console.error("[bootstrap] AUTH_BOOTSTRAP_TOKEN is not set — bootstrap disabled");
    return Response.json({ error: "bootstrap disabled" }, { status: 503 });
  }

  let body: BootstrapBody;
  try {
    body = (await req.json()) as BootstrapBody;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  // Gate 1: the bootstrap token. Constant-time compare; reject on any mismatch.
  const provided = typeof body.token === "string" ? body.token : "";
  if (!provided || !timingSafeEqual(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Ensure the auth tables exist before counting users (triggers lazy pglite
  // init + the CREATE TABLE migration, then waits for it).
  await ensureAuthDb();
  const ctx = await auth.$context;

  // Gate 2: zero existing users. Once an owner exists the system is sealed.
  const userCount = await ctx.internalAdapter.countTotalUsers();
  if (userCount > 0) {
    return Response.json({ error: "owner already exists" }, { status: 409 });
  }

  // Owner email is PINNED server-side (not taken from the request) so the
  // user.email UNIQUE constraint is a real TOCTOU guard: concurrent bootstraps
  // necessarily collide on the same email, and the loser gets 409 (see below).
  // Single-user system — the address is cosmetic; AUTH_OWNER_EMAIL overrides.
  const email = process.env.AUTH_OWNER_EMAIL?.trim() || "owner@genesis.local";
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Owner";

  // Create the single owner user. emailVerified is set true: there is no email
  // flow in this single-user system.
  let user: Awaited<ReturnType<typeof ctx.internalAdapter.createUser>>;
  try {
    user = await ctx.internalAdapter.createUser({
      email,
      name,
      emailVerified: true,
    });
  } catch {
    // The user.email UNIQUE constraint closes the countTotalUsers→createUser
    // TOCTOU: two concurrent token-holding bootstraps both read count 0, but the
    // second insert collides on the (now-pinned, identical) owner email and
    // throws here → 409 instead of a second owner row.
    return Response.json({ error: "owner already exists" }, { status: 409 });
  }

  // Mint a session so the just-created owner is immediately authenticated and
  // can enroll a passkey without any further credential. Signature (verified
  // against @better-auth/core@1.6.22):
  //   createSession(userId, dontRememberMe?, override?, overrideAll?)
  // We pass only userId → a full-lifetime "remember me" session.
  const session = await ctx.internalAdapter.createSession(user.id);

  // Sign the session token exactly the way Better Auth does internally
  // (`makeSignature` is Better Auth's own exported crypto helper), then set the
  // session cookie using Better Auth's own cookie attributes.
  const cookie = ctx.authCookies.sessionToken;
  const signature = await makeSignature(session.token, ctx.secret);
  const value = encodeURIComponent(`${session.token}.${signature}`);
  const attrs = cookie.attributes;

  const parts = [
    `${cookie.name}=${value}`,
    `Path=${attrs.path ?? "/"}`,
    `Max-Age=${attrs.maxAge ?? 60 * 60 * 24 * 7}`,
    `SameSite=${attrs.sameSite ? String(attrs.sameSite).replace(/^\w/, (c) => c.toUpperCase()) : "Lax"}`,
  ];
  if (attrs.httpOnly) parts.push("HttpOnly");
  if (attrs.secure) parts.push("Secure");
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`);
  const setCookie = parts.join("; ");

  const res = Response.json({ ok: true, userId: user.id, email: user.email }, { status: 200 });
  res.headers.append("set-cookie", setCookie);
  return res;
}
