# 39 — Bandwidth recharge

Grow a sandbox's egress quota after it exists. The quota is assigned
server-side at create (default 10 GiB) — `create` no longer accepts a
`bandwidth_quota_bytes` field (removed in SDK 0.6.0) — so `rechargeBandwidth`
is the supported path to raise it.

## Run

```sh
cp .env.example .env  # fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

bun auto-loads `.env` from the example dir. `CREATEOS_SANDBOX_BASE_URL` defaults to the
production control plane and only needs to be set to override.

## What it does

1. Creates a sandbox (`s-1vcpu-1gb`, rootfs `devbox:1`); it starts on the
   default bandwidth quota.
2. Reads the quota and usage counters with `getBandwidth()`.
3. Tops the quota up by 5 GiB with `rechargeBandwidth()` and confirms the
   returned `quota_bytes` grew by exactly that amount.
4. Destroys the sandbox.

## createos-sandbox primitives exercised

| primitive          | SDK call                      |
| ------------------ | ----------------------------- |
| Sandbox lifecycle  | `Sandbox.create()`            |
| Read quota / usage | `sandbox.getBandwidth()`      |
| Grow quota         | `sandbox.rechargeBandwidth()` |
| Tear down          | `sandbox.destroy()`           |
