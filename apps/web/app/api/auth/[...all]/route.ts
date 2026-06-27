// Better Auth Next.js route handler — mounts the entire auth API under
// /api/auth/* (sign-in, sign-out, get-session, passkey register/authenticate,
// etc.). `toNextJsHandler(auth)` returns { GET, POST } directly.
//
// Node runtime: the handler talks to the pglite-backed Drizzle store, which is
// a Node (WASM) module — not edge-compatible.
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(auth);
