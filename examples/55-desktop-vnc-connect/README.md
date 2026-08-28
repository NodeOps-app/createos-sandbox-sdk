# 55 - Desktop noVNC Connect

Create a graphical `desktop:1` sandbox, use the computer API to inspect and
drive the desktop, capture PNG screenshots, and mint a live noVNC URL.

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_API_KEY
bun index.ts
```

`bun` auto-loads `.env` from the current directory.

## What it does

1. Creates a `desktop:1` sandbox with `ingress_enabled: true`.
2. Reads the primary screen geometry and screen list.
3. Captures a full-screen PNG and a small region PNG.
4. Moves the cursor and verifies the new cursor position.
5. Writes and reads clipboard text.
6. Opens `https://example.com` in the desktop browser.
7. Creates a noVNC connection URL for `screen-0`.
8. Destroys the sandbox in a `finally` block.

## createos-sandbox primitives exercised

| Primitive               | SDK call                                  |
| ----------------------- | ----------------------------------------- |
| Create desktop sandbox  | `Sandbox.create(...)`                     |
| Read screen geometry    | `sandbox.computer.screen(...)`            |
| List/get screens        | `sandbox.computer.screens.list/get(...)`  |
| Capture screenshots     | `sandbox.computer.screenshot(...)`        |
| Move cursor             | `sandbox.computer.mouse.move(...)`        |
| Read cursor             | `sandbox.computer.cursor(...)`            |
| Clipboard round trip    | `sandbox.computer.setClipboard/clipboard` |
| Open desktop target     | `sandbox.computer.open(...)`              |
| Mint noVNC connection   | `sandbox.computer.screens.connect(...)`   |
| Tear the sandbox down   | `sandbox.destroy()`                       |
