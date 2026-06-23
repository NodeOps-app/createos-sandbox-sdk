# Sub-API Reference

`CreateosSandboxClient` exposes three namespace objects for catalog operations.
Each is an instance of its own class, reached through a property on the client.

```ts
const client = new CreateosSandboxClient({ apiKey: "…" });
client.templates  // TemplatesApi
client.networks   // NetworksApi
client.disks      // DisksApi
```

Every method also throws `CreateosSandboxServerError` on a 5xx response and
`CreateosSandboxConnectionError` on network failure; per-method tables list only
conditions specific to that call.

---

## `TemplatesApi` — `client.templates`

Custom rootfs (Dockerfile-built) operations.

### `list(options?)`

```ts
list(options?: RequestOptions): Promise<TemplateView[]>
```

Lists every template owned by the caller. Fetches all pages and returns them
as a single array.

| Throws | When |
|---|---|
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `iterate(options?)`

```ts
iterate(options?: RequestOptions): AsyncGenerator<TemplateView>
```

Streams every template one page at a time. Use instead of `list` when the
catalog is large and you don't need all rows in memory at once.

```ts
for await (const t of client.templates.iterate()) {
  console.log(t.id);
}
```

### `create(request, options?)`

```ts
create(request: TemplateCreateRequest, options?: RequestOptions): Promise<TemplateView>
```

Submits a Dockerfile to build into a sandbox rootfs.

| Throws | When |
|---|---|
| `CreateosSandboxValidationError` | Request body malformed or Dockerfile rejected. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Caller hit a quota. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `get(id, options?)`

```ts
get(id: string, options?: GetTemplateOptions): Promise<TemplateView>
```

Looks up a template by ID. Pass `include: "dockerfile"` to receive the original
build input alongside the template view.

| `GetTemplateOptions` field | Type | Description |
|---|---|---|
| `include` | `"dockerfile" \| undefined` | Include the Dockerfile in the response. |

| Throws | When |
|---|---|
| `CreateosSandboxNotFoundError` | No template with that ID. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Template belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `delete(id, options?)`

```ts
delete(id: string, options?: RequestOptions): Promise<OKResponse>
```

Deletes a template. Existing sandboxes built from it are unaffected.

| Throws | When |
|---|---|
| `CreateosSandboxNotFoundError` | Template ID does not exist. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Template belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `logs(id, options?)`

```ts
logs(id: string, options?: TemplateLogsOptions): Promise<string>
```

Fetches the build log so far as plain text.

| `TemplateLogsOptions` field | Type | Description |
|---|---|---|
| `attempt` | `number \| undefined` | Build attempt number (default: latest). |

| Throws | When |
|---|---|
| `CreateosSandboxNotFoundError` | No template (or attempt) with that ID. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Template belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `followLogs(id, options?)`

```ts
followLogs(id: string, options?: TemplateLogsOptions): AsyncGenerator<TemplateLogEvent>
```

Follows the build log as an NDJSON stream, yielding `TemplateLogEvent` objects
until the build finishes. Not retried.

```ts
for await (const event of client.templates.followLogs("tpl_01h…")) {
  if (event.line) process.stdout.write(event.line);
}
```

| Throws | When |
|---|---|
| `CreateosSandboxNotFoundError` | No template (or attempt) with that ID. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Template belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

---

## `NetworksApi` — `client.networks`

Overlay network operations. Networks are created here and attached to sandboxes
via `sandbox.attachNetwork()`.

### `list(options?)`

```ts
list(options?: RequestOptions): Promise<Network[]>
```

Lists every overlay network owned by the caller.

| Throws | When |
|---|---|
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `iterate(options?)`

```ts
iterate(options?: RequestOptions): AsyncGenerator<Network>
```

Streams every overlay network one page at a time.

### `create(request, options?)`

```ts
create(request: NetworkCreateRequest, options?: RequestOptions): Promise<Network>
```

Creates an overlay network.

| Throws | When |
|---|---|
| `CreateosSandboxValidationError` | Body malformed or CIDR conflicts. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Caller hit a quota. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `get(id, options?)`

```ts
get(id: string, options?: RequestOptions): Promise<Network>
```

Looks up an overlay network by ID.

| Throws | When |
|---|---|
| `CreateosSandboxNotFoundError` | No network with that ID. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Network belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `delete(id, options?)`

```ts
delete(id: string, options?: RequestOptions): Promise<OKResponse>
```

Deletes an overlay network. Member sandboxes are detached but not destroyed.

| Throws | When |
|---|---|
| `CreateosSandboxNotFoundError` | Network ID does not exist. |
| `CreateosSandboxValidationError` | Network still has active members. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Network belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

---

## `DisksApi` — `client.disks`

S3-backed disk catalog operations. Disks are registered here and mounted into
sandboxes at create time.

Note: `CreateosSandboxServerError` (503) is also thrown when the disks API is not
configured by the operator.

### `list(options?)`

```ts
list(options?: RequestOptions): Promise<DiskView[]>
```

Lists every registered S3 disk owned by the caller.

| Throws | When |
|---|---|
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `iterate(options?)`

```ts
iterate(options?: RequestOptions): AsyncGenerator<DiskView>
```

Streams every registered S3 disk one page at a time.

### `create(request, options?)`

```ts
create(request: DiskCreateRequest, options?: RequestOptions): Promise<DiskView>
```

Registers an S3 bucket as a mountable disk. The server HEADs the bucket before
accepting; a typo or bad credentials returns `CreateosSandboxValidationError`.

| Throws | When |
|---|---|
| `CreateosSandboxValidationError` | Bucket HEAD fails or credentials rejected. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Caller hit a quota. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `get(idOrName, options?)`

```ts
get(idOrName: string, options?: RequestOptions): Promise<DiskView>
```

Looks up a disk by ID (`disk_<ulid>`) or by user-scoped name.

| Throws | When |
|---|---|
| `CreateosSandboxNotFoundError` | No disk with that ID or name. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Disk belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `delete(idOrName, options?)`

```ts
delete(idOrName: string, options?: RequestOptions): Promise<DiskDeletedResponse>
```

Deletes a disk. Detach from all sandboxes first — the server returns 409 if
the disk is still attached to a non-destroyed sandbox.

| Throws | When |
|---|---|
| `CreateosSandboxNotFoundError` | Disk ID or name does not exist. |
| `CreateosSandboxValidationError` | Disk is still attached to a sandbox. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Disk belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |

### `rotateCredentials(idOrName, credentials, options?)`

```ts
rotateCredentials(
  idOrName: string,
  credentials: DiskCredentials,
  options?: RequestOptions,
): Promise<DiskView>
```

Replaces the stored S3 access/secret key pair for a disk. The disk's non-secret
config is untouched. Running sandboxes holding the disk pick up new credentials
on their next resume.

| `DiskCredentials` field | Type |
|---|---|
| `access_key` | `string` |
| `secret_key` | `string` |

| Throws | When |
|---|---|
| `CreateosSandboxValidationError` | `access_key` or `secret_key` is empty. |
| `CreateosSandboxNotFoundError` | Disk ID or name does not exist. |
| `CreateosSandboxAuthError` | API key missing or revoked. |
| `CreateosSandboxPermissionError` | Disk belongs to another tenant. |
| `CreateosSandboxTimeoutError` | Per-request timeout elapsed. |
