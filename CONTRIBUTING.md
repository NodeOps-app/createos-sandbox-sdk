# Contributing

Thanks for your interest in `fc-sandbox-sdk`. This document covers local
setup, the dev workflow, and the conventions the project enforces.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

The toolchain is [Bun](https://bun.sh)-first. Install Bun, then:

```sh
git clone <REPO_URL>
cd fc-sandbox-sdk
bun install
pre-commit install
```

`pre-commit install` wires the commit gate (see below). Run it once per clone.

## Dev commands

```sh
bun run build       # tsc -> dist/
bun run typecheck   # tsc --noEmit (the type gate)
bun run lint        # oxlint
bun run fmt         # oxfmt (writes); fmt:check to verify
bun run lint:fix    # oxlint --fix
bun test            # bun:test, coverage-gated by bunfig.toml
```

`tsc` is the type gate; `oxlint` and `oxfmt` lint and format code only. `oxfmt`
skips Markdown — README and docs are hand-wrapped prose, so format them by hand.

## Commit gate

Commits are gated by `.pre-commit-config.yaml`: `oxlint`, `oxfmt`, `gitleaks`,
`tsc --noEmit`, and `bun test` with the coverage floor. Install the hooks once
with `pre-commit install`; they then run on every commit. Do not bypass them.

## Conventions

- **Zero runtime dependencies — hard rule.** Do not add anything to
  `dependencies`. `devDependencies` is build and lint tooling only.
- **Bun-first.** Use `bun` to run scripts, tests, and tooling — not `node`,
  `npm`, or `npx`. (The release commands below are the one exception, since
  publishing goes through the npm registry.)
- **Source files stay under ~1100 lines.** Split before you exceed it.
- **Conventional Commits.** `<type>(<scope>): <subject>`, where `type` is one
  of `feat | fix | docs | style | refactor | test | chore | perf`. Subject is
  imperative and 50 characters or fewer ("add", not "added"; no trailing
  period).
- **`exactOptionalPropertyTypes` is on.** Spread option objects
  (`{ ...options }`) rather than constructing literals with possibly-`undefined`
  scalar values.

## Tests

Tests use `bun:test` (`describe` / `test` / `expect`) and import the SDK
**source** directly from `src/` — there is no build step before tests. `fetch`
is mocked via the `fetch` client option; there is no live server. One file per
module, with shared fixtures in `tests/helpers.ts`. Coverage runs on every
`bun test` and is floor-gated by `bunfig.toml`; raise the floor as the suite
grows, never lower it to make a run pass.

## Adding an endpoint

The control-plane wire types in `types.ts` mirror the Go server; verify every
field against the Go handlers rather than the stale `openapi.yaml`. The full
step-by-step ("Adding an endpoint") lives in `CLAUDE.md` — read it before adding
a method, then add a matching test under `tests/`.

## Releasing / publishing

Maintainers only. The package is **not yet published** to npm.

```sh
npm whoami
npm version patch
npm run publish:dry
npm run publish:npm
git push --follow-tags
```

`prepublishOnly` runs the test and typecheck gates before a real publish. If
publish fails with `E401`, the local npm token is invalid — run
`npm login --registry=https://registry.npmjs.org/` and retry.
