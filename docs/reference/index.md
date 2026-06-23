# Reference

API dictionary — exact signatures, parameters, return types, and wire shapes.
No tutorial prose. Start with the [quickstart](../quickstart.md) or
[how-to guides](../how-to/) if you are new to the SDK.

**Source of truth:** `src/` — this reference mirrors it. When in doubt,
read the source.

---

## Pages

| Page | Covers |
|---|---|
| [types.md](./types.md) | All TypeScript wire types and option interfaces: client options, sandbox lifecycle, commands, egress, bandwidth, networks, disks, templates, catalog, HTTP envelopes, and polling primitives. |

---

## Cross-cutting notes

- All optional fields marked `?` are `omitempty` server-side — the key is
  absent in the JSON, not `null`. The SDK uses `exactOptionalPropertyTypes`.
- List endpoints return a doubly-nested paginated envelope
  `{ data: { data: [...], pagination: { total, limit, offset, count } } }`.
  The `fetchAllPages` helper handles paging transparently.
- The published OpenAPI spec is stale. Trust `src/types.ts` and live server
  behavior over the spec for any discrepancy.
