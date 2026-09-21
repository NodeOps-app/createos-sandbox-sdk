# 57 - Sandbox access token

Run a command with the owner API key, then create one sandbox token for a
worker, use it through a separate handle, rotate it, and disable it. The
owner handle retains the account API key.

The first delegated command uses `withAccessToken()`. After rotation,
`worker.ts` creates its own client using only the sandbox id and replacement
token. It has no owner credential or owner handle.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

The token is returned only when created or rotated. The example keeps it in
memory and does not print it. A real application should transfer it through
its secret channel. The delegated handle can operate only its bound sandbox;
token management requires the owner handle. Disabling a token succeeds even
when none exists. Revocation can take time to reach other regions.
