# 58 - Git for environments

Branch, test and merge a whole software world, not only its code.

The repo holds everything needed to rebuild the world: app code, database
migrations, seed data and the test gate. Each agent works on its own branch,
and every branch is its own sandbox. `merge()` brings back only the branches
that pass the gate, and a last fresh branch proves that `main` rebuilds and
passes from scratch.

```
 main ──branch──► agent/tax       (own sandbox) ── gate pass ──► merge
      ──branch──► agent/tax-fast  (own sandbox) ── gate FAIL ──► discard
      ──branch──► agent/email     (own sandbox) ── gate pass ──► merge
      ──branch──► verify          (own sandbox) ── rebuild DB + gate
```

The world here is a tiny billing service with a SQLite database. Three agents
try three changes in parallel:

| branch | change | result |
|---|---|---|
| `agent/tax` | 18% tax, rate stored per customer (migration 002) | passes, merged |
| `agent/tax-fast` | same tax with float math | fails the gate (3537 ≠ 3538), discarded |
| `agent/email` | billing email column (migration 003) | passes, merged |

## Run

```sh
cp .env.example .env
# fill in CREATEOS_SANDBOX_API_KEY
bun 58-git-for-environments/index.ts
```

## Sample output

```
[  3.3s] main           committed base world b2ebf46 (gate passed)
[  5.6s] agent/email    store a billing email per customer → gate PASS
[  6.2s] agent/tax-fast add 18% tax with float math (rounding bug) → gate FAIL
[  6.2s] agent/tax-fast   AssertionError: 3537
[  6.8s] agent/tax      add 18% tax, rate stored per customer → gate PASS
[  9.4s] main           merge agent/tax → gate PASS
[ 11.7s] main           merge agent/email → gate PASS
[ 12.2s] main           main is now 0aea5a7
[ 15.1s] verify         fresh sandbox at 0aea5a7, rebuilt DB, gate PASS
```

## Rules this example follows

- **One sandbox per branch.** Agents never share files, ports or processes,
  and a failed idea is discarded with its sandbox.
- **Only the coordinator writes `main`.** Branches come back through
  `merge()`, which runs the gate on the merged result and undoes the merge
  when the gate fails.
- **The database is rebuilt from what is committed.** Migrations and seed data
  are in git, so every branch and every checkout gets the same state. Swap
  SQLite for Postgres without changing the workflow.

In a real system an LLM writes each agent's edits; here they are fixed so the
run is repeatable.
