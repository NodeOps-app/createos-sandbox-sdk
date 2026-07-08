// Governance decision point for the agent mesh. Runs inside the "gov" sandbox.
// Wraps the real Microsoft Agent Governance Toolkit (@microsoft/agent-governance-sdk,
// baked into the custom template at /opt/agt) into a tiny HTTP service:
//
//   POST /check  — agents on the private overlay ask "may I run this tool call?"
//                  -> PolicyEngine (allow/deny + backends) + ContextPoisoningDetector
//   GET  /state  — live governance state (served over public ingress to the dashboard)
//   GET  /       — the governance dashboard (static HTML, polls /state)
//   GET  /health — readiness probe
//
// Every decision is appended to a hash-chained, tamper-evident audit log on the
// S3-backed disk mounted at /mnt/audit, so the record survives the sandbox.
//
// This service is example glue; the governance *decisions* are the toolkit's.
import { createServer } from "node:http";
import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  PolicyEngine,
  ContextPoisoningDetector,
  PromptDefenseEvaluator,
  McpSecurityScanner,
} from "@microsoft/agent-governance-sdk";

const PORT = Number(process.env.PORT ?? "7070");
const POLICY_PATH = process.env.GUARD_POLICY ?? "/root/guard-policy.json";
const DASHBOARD_PATH = process.env.DASHBOARD ?? "/root/dashboard.html";
const AUDIT_PATH = process.env.AUDIT_PATH ?? "/mnt/audit/audit-log.jsonl";
const EVIDENCE_PATH = process.env.EVIDENCE_PATH ?? "/mnt/audit/compliance-evidence.json";

const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));

// ── compile the governance spec into matchers ───────────────────────────────
const blocked = policy.blockedToolCalls.map((r) => ({
  id: r.id,
  tools: new Set(r.tools),
  reason: r.reason,
  patterns: r.patterns.map((p) => new RegExp(p, "i")),
}));
const pathDenies = (policy.resourceDenies?.pathPatterns ?? []).map((p) => new RegExp(p, "i"));
const urlDenies = (policy.resourceDenies?.urlPatterns ?? []).map((p) => new RegExp(p, "i"));

// ── AGT: PolicyEngine with an allow-list rule + a deny backend ───────────────
// evaluateWithBackends() uses legacy flat rules (default-deny), so we seed an
// allow rule for known tools and let the backend deny-override on a match.
const engine = new PolicyEngine([policy.allowRule], "deny-overrides");
engine.registerBackend({
  name: "agt-guard",
  evaluateAction(action, ctx) {
    const tool = String(ctx.toolName ?? "");
    const text = String(ctx.commandText ?? "");
    for (const rule of blocked) {
      if (!rule.tools.has(tool)) continue;
      if (rule.patterns.some((re) => re.test(text)))
        return { backend: "agt-guard", decision: "deny", reason: rule.reason };
    }
    if (pathDenies.some((re) => re.test(text)))
      return { backend: "agt-guard", decision: "deny", reason: policy.resourceDenies.reason };
    if (urlDenies.some((re) => re.test(text)))
      return { backend: "agt-guard", decision: "deny", reason: policy.resourceDenies.reason };
    return "allow";
  },
});

// ── AGT: context-poisoning / prompt-injection detector ──────────────────────
const detector = new ContextPoisoningDetector();

// ── AGT: startup compliance evidence (OWASP LLM Top-10 prompt-defense grade) ─
const promptDefense = new PromptDefenseEvaluator().evaluate(policy.guardPrompt);
const mcpScan = new McpSecurityScanner().scanAll(policy.tools);
const evidence = {
  generatedAt: new Date().toISOString(),
  promptDefense: {
    grade: promptDefense.grade,
    score: promptDefense.score,
    coverage: promptDefense.coverage,
    minGrade: policy.minPromptDefenseGrade,
    passes: !promptDefense.isBlocking(policy.minPromptDefenseGrade),
    owaspVectors: (promptDefense.findings ?? []).map((f) => ({
      id: f.vectorId,
      owasp: f.owasp,
      defended: f.defended,
    })),
  },
  mcpToolScan: mcpScan.map((r) => ({ tool: r.tool_name, safe: r.safe, riskScore: r.risk_score })),
};
writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));

// ── tamper-evident, hash-chained audit log on the S3 disk ───────────────────
let seq = 0;
let prevHash = "genesis";
function audit(rec) {
  // Hash the full record (minus the hash field itself) and chain it to the
  // previous hash, so the log can be verified line-by-line off-box.
  const body = { seq: seq++, ts: new Date().toISOString(), prevHash, ...rec };
  body.hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  prevHash = body.hash;
  appendFileSync(AUDIT_PATH, JSON.stringify(body) + "\n");
  return body;
}

// ── zero-trust identity + trust scoring ─────────────────────────────────────
const agents = new Map(); // id -> { trust, allows, denies, poison }
const tierOf = (t) =>
  t >= 90
    ? "Verified"
    : t >= 70
      ? "Trusted"
      : t >= policy.killThreshold
        ? "Provisional"
        : "Untrusted";
function agentState(id) {
  if (!agents.has(id))
    agents.set(id, { trust: policy.trustStart, allows: 0, denies: 0, poison: 0 });
  return agents.get(id);
}

const decisions = []; // recent, for the dashboard
const poisoningEvents = [];

async function check({
  agentId = "unknown",
  sessionId = "s",
  tool = "",
  command = "",
  args = {},
  input = "",
}) {
  const a = agentState(agentId);
  const commandText = [command, typeof args === "string" ? args : JSON.stringify(args ?? {}), input]
    .filter(Boolean)
    .join(" ");

  // 1) poisoning / prompt-injection scan of the request payload
  const entry = {
    agentId,
    sessionId,
    role: "tool",
    content: commandText,
    entryId: `${agentId}-${seq}`,
    timestamp: new Date().toISOString(),
  };
  detector.addEntry(entry);
  const findings = detector.scanEntry(entry);
  const worst = findings.toSorted((x, y) => sev(y.severity) - sev(x.severity))[0];

  let decision = "allow";
  let reason = "within policy";
  let deniedBy = [];
  let poison = null;

  if (worst && (worst.severity === "critical" || worst.severity === "high")) {
    decision = "deny";
    reason = `context poisoning: ${worst.patternName}`;
    deniedBy = ["agt-context-poisoning"];
    poison = { patternName: worst.patternName, severity: worst.severity, evidence: worst.evidence };
    a.poison++;
    a.trust -=
      worst.severity === "critical"
        ? policy.penalties.poisoningCritical
        : policy.penalties.poisoningHigh;
    poisoningEvents.push({ ts: entry.timestamp, agentId, ...poison });
  } else {
    // 2) policy engine (allow-list rule + deny backend)
    const result = await engine.evaluateWithBackends(`tool.${tool}`, {
      toolName: tool,
      commandText,
      args,
    });
    decision = result.effectiveDecision === "allow" ? "allow" : "deny";
    deniedBy = result.deniedBy ?? [];
    if (decision === "deny") {
      const denyBackend = (result.backendResults ?? []).find((b) => b.decision === "deny");
      reason = denyBackend?.reason ?? "denied by policy";
      a.trust -= policy.penalties.deny;
    }
  }

  if (decision === "allow") a.allows++;
  else a.denies++;
  a.trust = Math.max(0, Math.min(100, a.trust));
  const kill = a.trust < policy.killThreshold;

  const rec = audit({
    agentId,
    tool,
    command: command.slice(0, 200),
    decision,
    reason,
    deniedBy,
    poison,
    trust: a.trust,
  });
  const view = {
    ts: rec.ts,
    agentId,
    tool,
    decision,
    reason,
    trust: a.trust,
    tier: tierOf(a.trust),
  };
  decisions.unshift(view);
  if (decisions.length > 50) decisions.pop();

  return {
    decision,
    reason,
    deniedBy,
    poison,
    trust: a.trust,
    tier: tierOf(a.trust),
    kill,
    auditSeq: rec.seq,
    auditHash: rec.hash,
  };
}

const sev = (s) => ({ low: 1, medium: 2, high: 3, critical: 4 })[s] ?? 0;

function state() {
  return {
    startedAt: evidence.generatedAt,
    evidence,
    agents: [...agents.entries()].map(([id, a]) => ({
      id,
      trust: a.trust,
      tier: tierOf(a.trust),
      allows: a.allows,
      denies: a.denies,
      poison: a.poison,
      killed: a.trust < policy.killThreshold,
    })),
    decisions,
    poisoningEvents,
    audit: { count: seq, headHash: prevHash, path: AUDIT_PATH },
  };
}

// ── HTTP surface ────────────────────────────────────────────────────────────
const dashboard = existsSync(DASHBOARD_PATH)
  ? readFileSync(DASHBOARD_PATH)
  : Buffer.from("dashboard missing");
const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
};

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/dashboard"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(dashboard);
    }
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && req.url === "/state") return json(res, 200, state());
    if (req.method === "GET" && req.url === "/evidence") return json(res, 200, evidence);
    if (req.method === "POST" && req.url === "/check") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      return json(res, 200, await check(body));
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 500, { error: String(err?.message ?? err) });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`policy-service listening on 0.0.0.0:${PORT}`);
  console.log(
    `compliance: prompt-defense grade ${evidence.promptDefense.grade} (${evidence.promptDefense.coverage}), passes=${evidence.promptDefense.passes}`,
  );
});
