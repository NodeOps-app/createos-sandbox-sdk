# 48 · Agent governance mesh (Microsoft Agent Governance Toolkit)

Enforce the [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)
(AGT) across a fleet of networked sandboxes. A central **gov** sandbox is the
policy decision point; two **governed agents** sit on a private overlay,
egress-locked to just the LLM proxy. Every tool call an agent makes crosses the
overlay to the policy engine **before it runs** — allowed actions execute,
forbidden ones are denied deterministically, erode the agent's trust score, and
trip an SRE kill-switch.

```
                         public ingress (HTTPS)
                                  │  live governance dashboard
                                  ▼
        ┌──────────────────────────────────────────┐
        │  gov sandbox   (custom template)          │
        │  · AGT PolicyEngine  (allow / deny)       │
        │  · ContextPoisoningDetector (injection)   │
        │  · PromptDefenseEvaluator (OWASP grade)   │
        │  · McpSecurityScanner (tool scan)         │
        │  · hash-chained audit  ──▶  S3 disk (/mnt/audit)
        └───────▲───────────────────────▲───────────┘
      POST /check│ (private overlay)     │POST /check
        ┌────────┴────────┐     ┌────────┴────────┐
        │ agent alpha     │     │ agent beta      │   egress-locked to
        │ (benign)        │     │ (compromised)   │   the LLM proxy only
        │ → all Allowed   │     │ → all Denied →💀 │
        └─────────────────┘     └─────────────────┘
```

The governance is the **real toolkit** (`@microsoft/agent-governance-sdk`, baked
into the custom template). The small HTTP service that turns it into a network
decision point (`policy-service.mjs`) is example glue — AGT itself does not ship
a policy server.

## What it shows

**Governance (AGT)**

| Capability | In this example |
| --- | --- |
| Policy engine, fail-closed | `PolicyEngine` allow-list rule + a deny backend (command patterns, secret paths, cloud-metadata SSRF, destructive SQL) |
| Prompt-injection / context poisoning | `ContextPoisoningDetector` flags an injected "retrieved document" as `critical` |
| OWASP LLM Top-10 compliance | `PromptDefenseEvaluator` grades the guard prompt (12 vectors) and gates the run at min grade **B** |
| Tool poisoning scan | `McpSecurityScanner` scans the declared tool catalog |
| Zero-trust identity + trust scoring | per-agent trust score & tier (`Verified` → `Untrusted`); "which agent did this" |
| Tamper-evident audit | hash-chained JSONL, verified off-box after download |
| SRE kill-switch | an agent below the trust floor is paused, then destroyed |

**Sandbox platform**

Custom template (bakes the toolkit) · private overlay network (multi-sandbox,
reach-by-IP) · egress allowlist (`getEgress`) · public ingress (dashboard) ·
run/stream commands · file upload/download · S3-backed disk (audit store,
`detachDisk` to flush) · pause · fork (clone the trusted baseline) · destroy.

## Lifecycle — fresh every run, nothing left behind

The example **provisions** a custom template, an overlay network, and an S3 disk;
**runs** the mesh; then **tears down every created resource** in dependency-safe
order (sandboxes → disk → network → template) inside a `finally`, with retries.
A run that fails midway still reaps what it created, so nothing leaks against
your quotas.

## Run

```sh
cp 48-agent-governance-mesh/.env.example .env   # fill in the values
bun 48-agent-governance-mesh/index.ts
```

Watch for: the OWASP compliance grade + gate, `alpha` staying `Verified` with 0
denials, `beta` getting every forbidden action denied until the kill-switch
fires, the intact audit hash chain, and the printed dashboard URL (open it while
the run is live). Downloaded evidence lands in `output/`.

## Notes

- **Setup**: needs an S3-compatible bucket (e.g. `play.min.io`) and an
  Anthropic-compatible LLM proxy (a non-Anthropic model is fine). The live LLM
  turn is best-effort; the deterministic governance matrix runs regardless.
- **Shape**: `s-4vcpu-4gb` — headroom for Node plus the baked toolkit.
- The audit log persists to the S3 disk, so it outlives the sandbox; the example
  also verifies the object landed durably in the bucket after detaching the disk.
