import { defineConfig } from "astro/config";

// The dev server is reached through the FC ingress URL
// (<ulid>-<port>.<region>.<domain>), whose Host header is not local. Vite's
// dev server rejects non-local hosts with "Blocked request" unless they are
// allow-listed. `allowedHosts: true` accepts the ingress host so the public
// preview URL renders. `--host 0.0.0.0` only controls binding, not this check.
export default defineConfig({
  server: { host: "0.0.0.0" },
  vite: { server: { allowedHosts: true } },
});
