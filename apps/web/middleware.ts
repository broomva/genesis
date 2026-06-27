// Optimistic auth gate at the edge.
//
// This is an OPTIMISTIC check only: it looks for the presence of Better Auth's
// session cookie (`getSessionCookie`, verified export of "better-auth/cookies")
// and redirects to /login when it is absent. It does NOT validate the session
// against the DB — that would need the pglite store, which is not edge-safe.
// The REAL enforcement is the `auth.api.getSession` 401 at the top of
// app/api/chat/route.ts. A forged/expired cookie passes middleware but is
// rejected there.
//
// The matcher (below) already excludes /login, /api/auth/*, and static assets,
// so middleware only runs on protected app routes.
import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  // Run on PAGE routes only. Exclusions:
  //   • `api`        — ALL API routes self-enforce. /api/chat returns its own
  //                    401 (a redirect would corrupt a fetch/SSE response and
  //                    the task gate expects 401, not 307); /api/auth/* must
  //                    stay reachable to sign in / bootstrap. Redirecting APIs
  //                    is wrong — APIs answer with status codes, not redirects.
  //   • `login`      — the sign-in page itself (else an unauthenticated user is
  //                    redirected away from the page that lets them sign in).
  //   • Next internals + static/PWA assets (manifest, service worker, icons).
  // The result: an unauthenticated browser hitting `/` is redirected to /login;
  // an unauthenticated POST to /api/chat gets a clean 401 from the route.
  matcher: [
    "/((?!api|login|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icon.svg|icon-192.png|icon-512.png).*)",
  ],
};
