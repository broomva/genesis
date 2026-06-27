// Browser-side Better Auth client for the Genesis PWA.
//
// Verified against better-auth@1.6.22 + @better-auth/passkey@1.6.22:
//   createAuthClient()           — from "better-auth/react"
//   passkeyClient()              — from "@better-auth/passkey/client"
//   authClient.signIn.passkey()  — sign in with an enrolled passkey
//   authClient.passkey.addPasskey({ name }) — enroll a passkey (needs a session)
//
// baseURL is left to default to the current origin (the app and the auth API
// are same-origin: /api/auth/*), so no env is needed in the browser bundle.
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [passkeyClient()],
});

export const { signIn, signOut, useSession } = authClient;
