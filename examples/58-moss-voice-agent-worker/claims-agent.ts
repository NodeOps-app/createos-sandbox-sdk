/**
 * Runs INSIDE the sandbox. One short-lived process per step, because every
 * process holding a Moss index bills Moss session-minutes: load, work, close,
 * exit. The host orchestrator (index.ts) sequences the steps.
 *
 *   bun claims-agent.ts setup            ensure the policy KB exists (no index load)
 *   bun claims-agent.ts call <claimId>   prewarm, run a claim call, push the notes
 *   bun claims-agent.ts warm             restart: reload the KB from the disk cache
 *   bun claims-agent.ts review <claimId> load the pushed notes in another sandbox, then delete them
 *
 * The last line of every step is a JSON summary the host parses.
 */
import { MossClient } from "@moss-js/moss";

const KB = "claims-policy-kb";
// On the sandbox disk: survives process restarts, so a restart skips the index
// download and keeps the same Moss device id (Moss bills monthly active devices).
const CACHE = "/var/cache/moss";
const T0 = performance.now();
const ms = (t = T0) => Math.round(performance.now() - t);
const say = (s: string) => console.log(`      ${s}`);
const done = (summary: Record<string, unknown>) =>
  console.log(JSON.stringify({ ...summary, processMs: ms() }));

const moss = () =>
  new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!, { cachePath: CACHE });

const POLICY = [
  "Collision coverage pays to repair your vehicle after an accident with another car or object, minus the deductible.",
  "Comprehensive coverage pays for theft, vandalism, hail, flood, fire and animal strikes, minus the deductible.",
  "The standard deductible is $500 for collision and $250 for comprehensive claims.",
  "A police report is required for theft, hit-and-run and any accident with injuries.",
  "Claims must be reported within 30 days of the incident.",
  "Rental car reimbursement covers up to $40 per day for a maximum of 30 days while your car is repaired.",
  "Windshield chips can be repaired with no deductible; full windshield replacement uses the comprehensive deductible.",
  "Roadside assistance covers towing up to 50 miles, jump starts, lockouts and flat tire changes.",
  "If another driver is at fault, we pursue subrogation and refund your deductible once recovered.",
  "Photos of all damage, the other driver's insurance details and the location should be collected at the scene.",
  "An adjuster inspection is scheduled within 3 business days for damage estimated above $2,000.",
  "Total loss is declared when repair cost exceeds 75% of the vehicle's actual cash value.",
  "Medical payments coverage pays up to $5,000 per person for injuries regardless of fault.",
  "Uninsured motorist coverage applies when the at-fault driver has no insurance or cannot be identified.",
  "Aftermarket parts are used for repairs on vehicles older than 5 years unless you have OEM parts coverage.",
].map((text, i) => ({ id: `policy-${i}`, text }));

// A realistic first-notice-of-loss call. Each turn: retrieve before the LLM
// would answer ("ambient retrieval"), and note what the caller said.
const CALLER = [
  "Hi, someone rear-ended me at a stop light this morning.",
  "The bumper is crushed and the trunk won't close, it looks expensive.",
  "The other driver gave me their insurance card, do I still pay a deductible?",
  "I need a car for work, will you cover a rental?",
  "Nobody was hurt, but do I need a police report?",
  "How soon can someone look at the damage?",
];

const mode = process.argv[2];
const claimId = process.argv[3] ?? "";

if (mode === "setup") {
  const client = moss();
  const exists = await client.getIndex(KB).then(
    () => true,
    () => false,
  );
  if (!exists) await client.createIndex(KB, POLICY);
  say(
    exists
      ? `policy KB "${KB}" already exists (reused)`
      : `created policy KB "${KB}" (${POLICY.length} docs)`,
  );
  done({ created: !exists });
} else if (mode === "call") {
  const client = moss();
  // Prewarm, as a LiveKit/Pipecat worker does at startup: model + index into memory.
  const t = performance.now();
  await client.loadIndex(KB, { cachePath: CACHE });
  const prewarmMs = ms(t);
  say(`prewarm: policy KB loaded in ${prewarmMs} ms (model + index, cold)`);

  // Notes stay in a local session: embedded inside this VM, never sent to a
  // third-party embedding API.
  const notes = await client.session(`claim-${claimId}`);
  const turns: number[] = [];
  for (const [i, utterance] of CALLER.entries()) {
    const q = performance.now();
    const r = await client.query(KB, utterance, { topK: 1 });
    const turnMs = +(performance.now() - q).toFixed(2);
    turns.push(turnMs);
    say(`turn ${i + 1}  ${turnMs.toFixed(1).padStart(5)} ms  caller: "${utterance}"`);
    say(`                 policy: ${r.docs[0]?.text.slice(0, 90)}…`);
    await notes.addDocs([{ id: `turn-${i + 1}`, text: utterance, metadata: { claim: claimId } }]);
  }
  // submit_report: push the call notes so another agent can pick them up.
  const t2 = performance.now();
  const { jobId } = await notes.pushIndex();
  const docCount = notes.docCount;
  // The push is an async build job. Unload first (no index held while we
  // wait), then poll until the notes are readable by another agent.
  await client.close();
  const jobs = moss();
  for (
    let job = await jobs.getJobStatus(jobId);
    job.status !== "completed";
    job = await jobs.getJobStatus(jobId)
  ) {
    if (job.status === "failed") throw new Error(`push job failed: ${job.error}`);
    await Bun.sleep(500);
  }
  const pushMs = ms(t2);
  say(`submit_report: pushed ${docCount} notes as index "claim-${claimId}", ready in ${pushMs} ms`);
  done({ prewarmMs, turns, pushMs });
} else if (mode === "warm") {
  const client = moss();
  const t = performance.now();
  await client.loadIndex(KB, { cachePath: CACHE });
  const reloadMs = ms(t);
  const q = performance.now();
  await client.query(KB, "is a rental covered", { topK: 1 });
  say(`restart: KB reloaded from ${CACHE} in ${reloadMs} ms, first query ${ms(q)} ms`);
  await client.close();
  done({ reloadMs });
} else if (mode === "review") {
  const client = moss();
  try {
    // Workaround: in @moss-js/moss 1.14–1.15 a pushed session index is stored
    // with model "custom", so text queries against it fail. Fetch the notes and
    // re-embed them in a local session instead (a few docs, milliseconds).
    const t = performance.now();
    const pushed = await client.getDocs(`claim-${claimId}`);
    const notes = await client.session(`review-${claimId}`);
    await notes.addDocs(
      pushed.map(({ id, text, metadata }) => ({ id, text, ...(metadata ? { metadata } : {}) })),
    );
    const loadMs = ms(t);
    say(`loaded claim notes "claim-${claimId}" in ${loadMs} ms`);
    for (const question of ["which parts of the car were damaged", "was anyone injured"]) {
      const r = await notes.query(question, { topK: 1, alpha: 1 }); // semantic only: short notes, few shared keywords
      say(`QA: "${question}" → "${r.docs[0]?.text}"`);
    }
    await client.close();
    done({ loadMs });
  } finally {
    // Notes are per claim: remove them once reviewed, even if review failed.
    await moss().deleteIndex(`claim-${claimId}`);
    console.error(`deleted index "claim-${claimId}"`);
  }
} else {
  console.error("usage: bun claims-agent.ts setup | call <claimId> | warm | review <claimId>");
  process.exit(2);
}
process.exit(0);
