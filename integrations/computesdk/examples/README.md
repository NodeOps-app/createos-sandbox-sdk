# `@computesdk/createos-sandbox` examples

Runnable, single-file examples for the createos-sandbox ComputeSDK provider. Each
creates a real sandbox against a live control plane and destroys it in a
`finally` block.

| # | File | Shows |
| --- | --- | --- |
| 01 | [`01-exec-and-files.ts`](./01-exec-and-files.ts) | Create, `runCommand` (cwd/env), filesystem read/write/list/remove, destroy. |
| 02 | [`02-snapshot-and-fork.ts`](./02-snapshot-and-fork.ts) | Pause-as-snapshot, then fork the paused bundle into a fresh sandbox. |
| 03 | [`03-stream-command.ts`](./03-stream-command.ts) | Stream stdout/stderr frames live with `streamCommand`. |
| 04 | [`04-portable-provider.ts`](./04-portable-provider.ts) | Provider-agnostic code: createos-sandbox wired in only at the composition root. |
| 05 | [`05-preview-url.ts`](./05-preview-url.ts) | Expose a guest port on a public ingress URL. |
| 06 | [`06-native-handle.ts`](./06-native-handle.ts) | `getInstance()` escape hatch: pause/resume, bandwidth, disks. |

## Running

The provider reads credentials from the environment. From this directory:

```sh
CREATEOS_SANDBOX_API_KEY=usr_... CREATEOS_SANDBOX_BASE_URL=https://createos-sandbox.example.com \
  npx tsx 01-exec-and-files.ts
```

Examples import the built package (`@computesdk/createos-sandbox`), so build it
first from the package root: `bun run build` (which itself needs the parent
SDK's `dist/` — run `bun run build` at the repo root once before that).

## Typecheck

```sh
tsc -p examples/tsconfig.json   # from the package root
```

> Examples are **not** part of the package's published `dist/` and are not
> wired into its build or test gates — they are reference code.
