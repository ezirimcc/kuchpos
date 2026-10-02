import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

/** Browser-side helper for signing in and out. Permissions are never decided here. */
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
