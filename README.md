# fc-sdk

TypeScript SDK for the `fc-spawn` control plane API.

```ts
import { FcClient } from "@compute/fc-sdk";

const fc = new FcClient({
  apiKey: process.env.FC_API_KEY,
  baseUrl: "https://fc-spawn.bhautik.in",
});

const sandbox = await fc.createSandbox({
  shape: "s-1vcpu-256mb",
  rootfs: "devbox:1",
});

const result = await fc.execSandbox(sandbox.id, {
  cmd: "node",
  args: ["--version"],
});

console.log(result.result.stdout);
```

## Streaming exec

```ts
for await (const event of fc.execSandboxStream(sandbox.id, {
  cmd: "bash",
  args: ["-lc", "for i in 1 2 3; do echo $i; sleep 1; done"],
})) {
  if (event.stdout) process.stdout.write(event.stdout);
  if (event.stderr) process.stderr.write(event.stderr);
  if (event.exit_code !== undefined) console.log("exit", event.exit_code);
}
```

## Files

```ts
await fc.uploadFile(
  sandbox.id,
  "/tmp/hello.txt",
  new TextEncoder().encode("hello"),
);

const bytes = await fc.downloadFile(sandbox.id, "/tmp/hello.txt");
console.log(new TextDecoder().decode(bytes));
```

## API surface

The client covers the OpenAPI gist endpoints:

- health and readiness: `healthz`, `readyz`
- catalog: `whoami`, `listShapes`, `listRootfs`, `listHosts`
- sandboxes: create, list, get, patch, destroy, pause, resume, fork, lookup by IP
- exec: buffered and NDJSON streaming
- files: upload and download
- egress, bandwidth, and disk resize
- templates and template log streaming
- networks and sandbox network attachment

## Errors

Non-2xx API responses throw `FcApiError`. The original `Response`, status code,
and parsed JSend `fail` or `error` envelope are available on the error.

## Publishing

The safest release flow is:

```sh
npm version patch
npm run pack:dry
npm run publish:dry
npm run publish:npm
git push --follow-tags
```

`prepublishOnly` runs the test and typecheck gates automatically before a real
`npm publish`.
