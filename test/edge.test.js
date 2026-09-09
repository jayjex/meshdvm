// Sprint-5 edge coverage: concurrent job handling, oversized params, malformed
// event content, budget 0/negative. No network — fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getEncodedToken } from "@cashu/cashu-ts";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

import { KIND_REQUEST, KIND_RESULT, KIND_FEEDBACK, parseRequestEvent } from "../src/nip90.js";
import { makeJobHandler, buildSampleResponse } from "../src/index.js";
import { validateParams, MAX_PARAM_LEN } from "../src/provider.js";
import * as query from "../src/query.js";
import { CashuEscrow } from "../src/cashu.js";
import { Ledger } from "../src/ledger.js";

const sk = generateSecretKey();
const MINT = "https://testnut.cashu.space";
const ID = "0100aabbccddeeff00112233";

const proof = (amount, name) => {
  const secret = Buffer.from(String(name), "utf8").toString("hex"); // secrets must be hex-safe for v4 token encoding
  return { amount, secret, C: "02" + secret, id: ID };
};
const proofs = (specs) => specs.map(([amount, secret]) => proof(amount, secret));
const token = (proofList) => getEncodedToken({ mint: MINT, unit: "sat", proofs: proofList });

function fakeMint() {
  return {
    async createMintQuoteBolt11() { return { quote: "q-1", request: "lnbc1test", state: "UNPAID" }; },
    async checkMintQuoteBolt11() { return { state: "PAID" }; },
    async check(req) { return { states: req.Ys.map((Y) => ({ Y, state: "UNSPENT", witness: null })) }; },
  };
}

/** Wallet stub. receive(token) returns fresh proofs per token (registry by
 *  secret), send splits greedily off the pool it is given. */
function fakeWallet() {
  const registry = new Map();
  return {
    mint: { mintUrl: MINT },
    receiveReturns(token, proofList) { registry.set(token, proofList); },
    async receive(t) {
      const out = registry.get(t);
      if (!out) throw new Error("wallet stub: unknown token");
      return out.map((p) => ({ ...p }));
    },
    async send(n, pool) {
      const sorted = [...(pool || [])].sort((a, b) => Number(b.amount) - Number(a.amount));
      const send = [];
      let total = 0;
      for (const p of sorted) {
        send.push(p);
        total += Number(p.amount);
        if (total >= n) break;
      }
      if (total < n) throw new Error(`cannot split ${n} from ${total}`);
      return { send, keep: (pool || []).filter((p) => !send.includes(p)) };
    },
  };
}

function fakePublisher() {
  const published = [];
  return { published, publish: async (ev) => (published.push(ev), ev) };
}

/** Paid job with a cashu tag; params map to param tags. */
function job({ params = { site: "metro-core", limit: "5" }, bid = "2000", cashu = null, content = "" } = {}) {
  const tags = [
    ...Object.entries(params).map(([k, v]) => ["param", k, String(v)]),
    ...(bid !== null ? [["bid", bid]] : []),
    ...(cashu ? [["cashu", cashu]] : []),
  ];
  return finalizeEvent({ kind: KIND_REQUEST, created_at: Math.floor(Date.now() / 1000), tags, content }, sk);
}

const status = (ev) => ev.tags.find((t) => t[0] === "status")?.[1];
const feedbacks = (published) => published.filter((e) => e.kind === KIND_FEEDBACK);
const results = (published) => published.filter((e) => e.kind === KIND_RESULT);

/** Paid-job escrow: every token in `paid` redeems to its own fresh proofs. */
function paidEscrow(paidMap) {
  const wallet = fakeWallet();
  for (const [tok, proofList] of Object.entries(paidMap)) wallet.receiveReturns(tok, proofList);
  return new CashuEscrow({ mint: fakeMint(), wallet, mintUrl: MINT });
}

// ---------------------------------------------------------------- (a) concurrent jobs
test("concurrency: two paid jobs submitted in parallel both complete with results and ledger rows", async () => {
  const t1 = token(proofs([[2, "c-1"]]));
  const t2 = token(proofs([[2, "c-2"]]));
  const escrow = paidEscrow({ [t1]: proofs([[2, "r-c1"]]), [t2]: proofs([[2, "r-c2"]]) });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  await Promise.all([handle(job({ cashu: t1 }), publish), handle(job({ cashu: t2 }), publish)]);

  assert.equal(results(published).length, 2, "both jobs produced a result");
  const s = ledger.stats();
  assert.equal(s.paid_jobs, 2);
  assert.equal(s.earned_sats, 4);
  assert.equal(s.seen_events, 2);
  ledger.close();
});

test("concurrency: parallel overpaid jobs never double-spend the balance (disjoint change proofs)", async () => {
  const t1 = token(proofs([[5, "c-3"]]));
  const t2 = token(proofs([[5, "c-4"]]));
  const escrow = paidEscrow({ [t1]: proofs([[3, "r-c3a"], [2, "r-c3b"]]), [t2]: proofs([[3, "r-c4a"], [2, "r-c4b"]]) });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  await Promise.all([handle(job({ cashu: t1 }), publish), handle(job({ cashu: t2 }), publish)]);

  const changeTokens = results(published).map((r) => JSON.parse(r.content).payment.change_token);
  assert.equal(changeTokens.filter(Boolean).length, 2, "both refunds shipped");
  const { getTokenMetadata } = await import("@cashu/cashu-ts");
  const metas = changeTokens.map((t) => getTokenMetadata(t));
  const secrets = metas.flatMap((m) => m.incompleteProofs.map((p) => String(p.secret)));
  assert.equal(new Set(secrets).size, secrets.length, "no proof appears in two change tokens");
  const s = ledger.stats();
  assert.equal(s.paid_jobs, 2, "both payments recorded exactly once");
  assert.equal(s.earned_sats, 10, "5 sat per job, never 5+5 duplicated proofs");
  assert.equal(s.refunded_sats, metas.reduce((a, m) => a + Number(m.amount?.value ?? m.amount), 0));
  assert.equal(escrow.balance.length, 2, "keep side of both refunds is the whole in-memory balance");
  ledger.close();
});

test("concurrency: the same event delivered twice in parallel is processed exactly once", async () => {
  const escrow = paidEscrow({});
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });
  const ev = job({});

  await Promise.all([handle(ev, publish), handle(ev, publish)]);

  assert.equal(feedbacks(published).length, 1, "one payment_required, never two");
  assert.equal(ledger.stats().seen_events, 1);
  ledger.close();
});

test("concurrency: mixed paid + unpaid + bad-params jobs in parallel each get their own outcome", async () => {
  const t1 = token(proofs([[2, "c-5"]]));
  const escrow = paidEscrow({ [t1]: proofs([[2, "r-c5"]]) });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  await Promise.all([
    handle(job({ cashu: t1 }), publish),
    handle(job({ params: { site: "metro-core" }, cashu: null }), publish),
    handle(job({ params: { site: "atlantis" } }), publish),
  ]);

  const statuses = feedbacks(published).map(status);
  assert.equal(statuses.filter((s) => s === "payment_required").length, 1);
  assert.equal(statuses.filter((s) => s === "error").length, 1);
  assert.equal(results(published).length, 1);
  const s = ledger.stats();
  assert.equal(s.paid_jobs, 1);
  assert.equal(s.jobs, 3, "every job has a ledger row");
  ledger.close();
});

test("concurrency: a job whose publish throws does not wedge the jobs queued behind it", async () => {
  const t1 = token(proofs([[2, "c-6"]]));
  const t2 = token(proofs([[2, "c-7"]]));
  const escrow = paidEscrow({ [t1]: proofs([[2, "r-c6"]]), [t2]: proofs([[2, "r-c7"]]) });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });
  const first = job({ cashu: t1 });
  const second = job({ cashu: t2 });
  let thrown = false;
  const brokenPublish = async (ev) => {
    // fail job 1's result publish specifically (its "e" tag names the request id)
    if (!thrown && ev.kind === KIND_RESULT && ev.tags.some((t) => t[0] === "e" && t[1] === first.id)) {
      thrown = true;
      throw new Error("relay socket died");
    }
    return publish(ev);
  };

  await Promise.allSettled([handle(first, brokenPublish), handle(second, brokenPublish)]);

  assert.equal(results(published).length, 1, "the second job still ships its result");
  assert.equal(results(published).filter((r) => r.tags.find((t) => t[0] === "e" && t[1] === second.id)).length, 1, "specifically job 2's result");
  // job 1's money was already redeemed before its result publish failed — that
  // is the publish seam failing, not the books; the ledger stays consistent
  assert.equal(ledger.stats().paid_jobs, 2);
  ledger.close();
});

test("concurrency: jobs run one at a time in arrival order (redeem calls never interleave)", async () => {
  const t1 = token(proofs([[2, "c-8"]]));
  const t2 = token(proofs([[2, "c-9"]]));
  const escrow = paidEscrow({ [t1]: proofs([[2, "r-c8"]]), [t2]: proofs([[2, "r-c9"]]) });
  const order = [];
  const wallet = escrow.wallet;
  const origReceive = wallet.receive.bind(wallet);
  wallet.receive = async (t) => {
    order.push(`receive:${String(t).slice(0, 12)}`);
    await new Promise((r) => setTimeout(r, 5)); // widen the interleaving window
    return origReceive(t);
  };
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  const p1 = handle(job({ cashu: t1 }), publish);
  await new Promise((r) => setTimeout(r, 1)); // let job 1 reach the queue first
  const p2 = handle(job({ cashu: t2 }), publish);
  await Promise.all([p1, p2]);

  assert.deepEqual(order, [`receive:${t1.slice(0, 12)}`, `receive:${t2.slice(0, 12)}`], "strict sequential receive order");
  ledger.close();
});

// ---------------------------------------------------------------- (b) oversized params
test("oversized: a 60KB site param is rejected with a bounded error that never echoes the value", async () => {
  const big = "A".repeat(60000);
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  await handle(job({ params: { site: big } }), publish);

  const fb = feedbacks(published)[0];
  assert.equal(status(fb), "error");
  assert.match(fb.content, /value too long/);
  assert.ok(fb.content.length < 1000, `feedback stays small (${fb.content.length} chars)`);
  assert.ok(!fb.content.includes(big), "the giant value is never echoed back");
  assert.equal(results(published).length, 0);
  ledger.close();
});

test("oversized: giant sensor/device/since params all reject with the length named", () => {
  const big = "x".repeat(5000);
  for (const key of ["sensor", "device", "since", "until", "anomaly", "stats"]) {
    const problems = validateParams(query, { [key]: big });
    assert.equal(problems.length, 1, `${key}: one problem`);
    assert.match(problems[0].error, new RegExp(`${big.length} chars, max ${MAX_PARAM_LEN}`));
    assert.ok(!JSON.stringify(problems).includes(big), `${key}: value not echoed`);
  }
});

test("oversized: limit far above the cap is clamped to MAX_ROWS_PER_CALL, not an error", async () => {
  const escrow = paidEscrow({ [token(proofs([[2, "c-10"]]))]: proofs([[2, "r-c10"]]) });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  await handle(job({ params: { site: "metro-core", limit: "99999999999999999999" }, cashu: token(proofs([[2, "c-10"]])) }), publish);
  const payload = JSON.parse(results(published)[0].content);
  assert.ok(payload.returned <= query.MAX_ROWS_PER_CALL);
  assert.ok(payload.returned > 0);
});

test("oversized: negative limit falls back to the default page size", async () => {
  const { buildDataPayload } = await import("../src/provider.js");
  const payload = await buildDataPayload(query, { limit: "-5" });
  assert.equal(payload.returned, query.DEFAULT_ROWS_PER_CALL);
  const inf = await buildDataPayload(query, { limit: "1e999" }); // Infinity
  assert.equal(inf.returned, query.DEFAULT_ROWS_PER_CALL);
});

test("oversized: negative and garbage offsets clamp to 0", async () => {
  const { buildDataPayload } = await import("../src/provider.js");
  for (const off of ["-100", "abc", "-1e999"]) {
    const payload = await buildDataPayload(query, { offset: off });
    assert.equal(payload.offset, 0, `offset ${off} clamps to 0`);
    assert.ok(payload.returned > 0);
  }
});

test("oversized: sample endpoint caps absurd limits instead of crashing", async () => {
  const data = await query.loadData();
  const page = await query.queryReadings({}, 99999999999999999999, 0);
  const out = buildSampleResponse({ ...page, sha256: data.sha256 }, "99999999999999999999");
  assert.ok(out.returned <= query.MAX_ROWS_PER_CALL);
  const neg = await query.queryReadings({}, -5, -3);
  const out2 = buildSampleResponse({ ...neg, sha256: data.sha256 }, "-5");
  assert.ok(out2.returned >= 0);
});

test("oversized: a 1MB garbage content string gets the bounded JSON error, not a crash", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });
  const content = "{" + "A".repeat(1000000);

  await handle(job({ params: {}, content }), publish);

  const fb = feedbacks(published)[0];
  assert.equal(status(fb), "error");
  assert.match(fb.content, /failed to parse/);
  assert.ok(fb.content.length < 500);
  assert.equal(ledger.stats().seen_events, 1);
  ledger.close();
});

// ---------------------------------------------------------------- (c) malformed content
test("malformed: content that looks like JSON but fails to parse gets an explicit error feedback", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  await handle(job({ params: { site: "metro-core" }, content: '{"site": "metro-core"' }), publish);

  const fb = feedbacks(published)[0];
  assert.equal(status(fb), "error");
  assert.match(fb.content, /malformed event content/);
  assert.match(fb.content, /failed to parse/);
  assert.equal(results(published).length, 0, "no result for a broken request");
  const s = ledger.stats();
  assert.equal(s.seen_events, 1);
  ledger.close();
});

test("malformed: parseRequestEvent flags the content error but still extracts tags and token", () => {
  const ev = finalizeEvent(
    { kind: KIND_REQUEST, created_at: 1, tags: [["param", "site", "metro-core"], ["cashu", "cashuAtag"]], content: "{broken" },
    sk
  );
  const r = parseRequestEvent(ev);
  assert.equal(r.ok, true);
  assert.equal(r.contentJsonError, "content looks like JSON but failed to parse");
  assert.equal(r.token, "cashuAtag");
  assert.equal(r.budgetMsat, null);
});

test("malformed: plain-text content (no braces) keeps working through param tags", async () => {
  const escrow = paidEscrow({ [token(proofs([[2, "c-11"]]))]: proofs([[2, "r-c11"]]) });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  await handle(job({ params: { site: "metro-core", limit: "3" }, cashu: token(proofs([[2, "c-11"]])), content: "paying for sensor data, thanks" }), publish);
  const result = results(published)[0];
  assert.ok(result, "plain-text content is not an error");
  assert.equal(JSON.parse(result.content).returned, 3);
});

test("malformed: valid JSON content with unknown keys only picks the known params", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  const content = JSON.stringify({ evil: "x".repeat(5000), site: "riverside-park" });
  await handle(job({ params: {}, content, cashu: null }), publish);
  const fb = feedbacks(published)[0];
  assert.equal(status(fb), "payment_required");
  assert.ok(!fb.content.includes("x".repeat(100)), "unknown key content never leaks into feedback");
});

test("malformed: non-string cashu value (number/object) is treated as no token, not a crash", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  await handle(job({ params: {}, content: '{"cashu": 123}' }), publish);
  assert.equal(status(feedbacks(published)[0]), "payment_required");
});

test("malformed: JSON param values of the wrong type (object/array) reject with a readable error", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  await handle(job({ params: {}, content: JSON.stringify({ site: { nested: true } }) }), publish);
  const fb = feedbacks(published)[0];
  assert.equal(status(fb), "error");
  assert.match(fb.content, /invalid params/);
  await handle(job({ params: {}, content: JSON.stringify({ sensor: ["air_quality"] }), cashu: null }), publish);
  assert.equal(status(feedbacks(published)[1]), "error");
});

test("malformed: a non-numeric bid tag is treated as no bid, not NaN poisoning", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  await handle(job({ params: { site: "metro-core" }, bid: "give me data", cashu: null }), publish);
  assert.equal(status(feedbacks(published)[0]), "payment_required", "no crash, clean payment path");
});

// ---------------------------------------------------------------- (d) budget 0 / negative
test("budget: bid 0 without a token gets payment_required naming the budget", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });
  await handle(job({ params: { site: "metro-core" }, bid: "0" }), publish);
  const fb = feedbacks(published)[0];
  assert.equal(status(fb), "payment_required");
  assert.match(fb.content, /budget 0 msat too low/);
  ledger.close();
});

test("budget: negative bid gets payment_required", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  for (const bid of ["-2000", "-1"]) {
    published.length = 0;
    await handle(job({ params: { site: "metro-core" }, bid }), publish);
    assert.equal(status(feedbacks(published)[0]), "payment_required");
    assert.match(feedbacks(published)[0].content, /too low/);
  }
});

test("budget: below-price bid still gets payment_required (existing behavior kept)", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  await handle(job({ params: { site: "metro-core" }, bid: "5" }), publish);
  assert.equal(status(feedbacks(published)[0]), "payment_required");
});

test("budget: bid 0 WITH a sufficient token still pays — the token is the payment", async () => {
  const t = token(proofs([[2, "c-12"]]));
  const escrow = paidEscrow({ [t]: proofs([[2, "r-c12"]]) });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  await handle(job({ params: { site: "metro-core", limit: "2" }, bid: "0", cashu: t }), publish);

  const result = results(published)[0];
  assert.ok(result, "the token covers the price, bid is irrelevant");
  assert.equal(JSON.parse(result.content).payment.amount_sats, 2);
  assert.equal(ledger.stats().paid_jobs, 1);
  ledger.close();
});

test("budget: negative bid with a sufficient token also pays", async () => {
  const t = token(proofs([[2, "c-13"]]));
  const escrow = paidEscrow({ [t]: proofs([[2, "r-c13"]]) });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });
  await handle(job({ params: { site: "metro-core" }, bid: "-999", cashu: t }), publish);
  assert.ok(results(published)[0], "paid via token despite the nonsense bid");
});

test("budget: an underpaid token with bid 0 gets payment_required from the amount check", async () => {
  const t = token(proofs([[1, "c-14"]]));
  const escrow = paidEscrow({ [t]: proofs([[1, "r-c14"]]) });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });
  await handle(job({ params: { site: "metro-core" }, bid: "0", cashu: t }), publish);
  const fb = feedbacks(published).find((e) => status(e) === "payment_required");
  assert.ok(fb, "rejected");
  assert.match(fb.content, /token worth 1 sat, need 2 sat/);
  ledger.close();
});
