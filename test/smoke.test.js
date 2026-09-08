// Smoke tests: no network. Fake mint + fake relay cover the I/O seams.
import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

import { KIND_REQUEST, KIND_RESULT, KIND_FEEDBACK, parseRequestEvent, buildResultEvent, buildFeedbackEvent, extractCashuToken } from "../src/nip90.js";
import { makeJobHandler, buildSampleResponse } from "../src/index.js";
import { buildDataPayload, validateParams } from "../src/provider.js";
import * as query from "../src/query.js";
import { CashuEscrow } from "../src/cashu.js";

const sk = generateSecretKey();
const pk = getPublicKey(sk);

function jobRequest({ params = { site: "metro-core", limit: "5" }, content = "", extraTags = [] } = {}) {
  const tags = [
    ...Object.entries(params).map(([k, v]) => ["param", k, String(v)]),
    ["bid", "2000"],
    ["relays", "wss://nos.lol"],
    ...extraTags,
  ];
  return finalizeEvent({ kind: KIND_REQUEST, created_at: Math.floor(Date.now() / 1000), tags, content }, sk);
}

// ---------------------------------------------------------------- parse
test("parse kind 5050 request with param tags", () => {
  const ev = jobRequest();
  const r = parseRequestEvent(ev);
  assert.equal(r.ok, true);
  assert.equal(r.requestId, ev.id);
  assert.equal(r.requester, pk);
  assert.equal(r.params.site, "metro-core");
  assert.equal(r.params.limit, "5");
  assert.equal(r.budgetMsat, 2000);
  assert.deepEqual(r.resultRelays, ["wss://nos.lol"]);
  assert.equal(r.token, null);
});

test("parse rejects non-90 kinds and malformed events", () => {
  assert.equal(parseRequestEvent({ kind: 1, id: "x", pubkey: "y" }).ok, false);
  assert.equal(parseRequestEvent({ kind: 6000 }).ok, false);
  assert.equal(parseRequestEvent(null).ok, false);
});

test("content JSON overrides tags; cashu token found in content or tag", () => {
  const ev = finalizeEvent(
    {
      kind: KIND_REQUEST,
      created_at: 1,
      tags: [["param", "site", "riverside-park"], ["param", "limit", "9"]],
      content: JSON.stringify({ site: "north-industrial", cashu: "cashuAtest" }),
    },
    sk
  );
  const r = parseRequestEvent(ev);
  assert.equal(r.params.site, "north-industrial"); // content wins
  assert.equal(r.params.limit, "9"); // tag fallback kept
  assert.equal(r.token, "cashuAtest");

  const ev2 = jobRequest({ extraTags: [["cashu", "cashuBtag"]] });
  assert.equal(extractCashuToken(ev2), "cashuBtag");
});

// ---------------------------------------------------------------- response build
test("result + feedback events carry NIP-90 tags", () => {
  const req = parseRequestEvent(jobRequest());
  const result = buildResultEvent(req, { hello: "data" }, { amountMsat: 2000, mintUrl: "https://testnut.cashu.space", botPubkey: pk });
  assert.equal(result.kind, KIND_RESULT);
  assert.equal(result.kind, 6050);
  assert.ok(result.tags.some((t) => t[0] === "e" && t[1] === req.requestId));
  assert.ok(result.tags.some((t) => t[0] === "p" && t[1] === req.requester));
  assert.ok(result.tags.some((t) => t[0] === "request"));
  assert.ok(result.tags.some((t) => t[0] === "amount" && t[1] === "2000"));
  assert.equal(JSON.parse(result.content).hello, "data");

  const fb = buildFeedbackEvent(req, "payment_required", { amountMsat: 2000, mintUrl: "https://testnut.cashu.space", message: "pay up" });
  assert.equal(fb.kind, KIND_FEEDBACK);
  assert.equal(fb.kind, 7000);
  assert.ok(fb.tags.some((t) => t[0] === "status" && t[1] === "payment_required"));
  assert.equal(fb.content, "pay up");
});

// ---------------------------------------------------------------- provider (data layer)
test("provider serves a filtered page pinned to the file hash", async () => {
  const payload = await buildDataPayload(query, { site: "metro-core", limit: 3 });
  assert.equal(payload.returned, 3);
  assert.ok(payload.page.every((r) => r.site === "metro-core"));
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
  assert.ok(payload.total_matched <= payload.total_rows_in_file);

  const bad = validateParams(query, { site: "atlantis" });
  assert.equal(bad.length, 1);
  assert.deepEqual(bad[0].allowed, query.SITES);
  assert.equal(validateParams(query, { site: "metro-core" }).length, 0);
});

test("sample endpoint response shape", async () => {
  const data = await query.loadData();
  const page = await query.queryReadings({}, 2, 0);
  const out = buildSampleResponse({ ...page, sha256: data.sha256 }, "2");
  assert.equal(out.dataset, "sensormesh-sample");
  assert.equal(out.returned, 2);
  assert.match(out.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.buy.nostr_kind, 5050);
});

// ---------------------------------------------------------------- cashu escrow with fake mint
function fakeMint() {
  const seen = [];
  return {
    seen,
    async createMintQuoteBolt11(req) {
      seen.push({ op: "createMintQuoteBolt11", req });
      return { quote: "q-123", request: "lnbc12testinvoice", state: "UNPAID" };
    },
    async checkMintQuoteBolt11(quote) {
      seen.push({ op: "checkMintQuoteBolt11", quote });
      return { quote, state: "PAID" };
    },
    async check(req) {
      seen.push({ op: "check", n: req.Ys.length });
      return { states: req.Ys.map((Y) => ({ Y, state: "UNSPENT", witness: null })) };
    },
  };
}
const fakeWallet = { async receive(token) { return [{ amount: 2, secret: "s1" }, { amount: 1, secret: "s2" }]; } };

test("escrow quote stub hits mint once with the right amount", async () => {
  const mint = fakeMint();
  const escrow = new CashuEscrow({ mint, mintUrl: "https://testnut.cashu.space" });
  const q = await escrow.getQuote(2);
  assert.equal(q.quoteId, "q-123");
  assert.match(q.invoice, /^lnbc/);
  assert.equal(mint.seen[0].req.amount, 2);
  const st = await escrow.checkQuote("q-123");
  assert.equal(st.state, "PAID");
});

test("escrow verifies an unspent token and rejects a spent one", async () => {
  // build a real cashuB token with the lib, then verify it end-to-end through the escrow seam
  const { getEncodedToken } = await import("@cashu/cashu-ts");
  const token = getEncodedToken({
    mint: "https://testnut.cashu.space",
    unit: "sat",
    proofs: [{ amount: 2, secret: "aa", C: "02aa", id: "0100aabbccddeeff00112233" }],
  });
  const mint = fakeMint();
  const escrow = new CashuEscrow({ mint, mintUrl: "https://testnut.cashu.space" });
  const ok = await escrow.verifyToken(token);
  assert.equal(ok.ok, true);
  assert.equal(ok.amountSats, 2);

  const spentMint = {
    async check(req) {
      return { states: req.Ys.map((Y) => ({ Y, state: "SPENT", witness: null })) };
    },
  };
  const spent = await new CashuEscrow({ mint: spentMint, mintUrl: "https://testnut.cashu.space" }).verifyToken(token);
  assert.equal(spent.ok, false);
  assert.match(spent.reason, /SPENT/);

  const otherMint = await new CashuEscrow({ mint: fakeMint(), mintUrl: "https://testnut.cashu.space" }).verifyToken(
    getEncodedToken({ mint: "https://other.mint", unit: "sat", proofs: [{ amount: 1, secret: "x", C: "02", id: "0100aabbccddeeff00112233" }] })
  );
  assert.equal(otherMint.ok, false);
  assert.match(otherMint.reason, /not https:\/\/testnut/);
});

test("escrow redeem totals proofs", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), wallet: fakeWallet, mintUrl: "https://testnut.cashu.space" });
  const r = await escrow.redeemToken("cashuAnything");
  assert.equal(r.ok, true);
  assert.equal(r.amountSats, 3);
});

test("escrow: cashu-ts v4 string proof amounts sum numerically, never concat", async () => {
  const stringWallet = { async receive() { return [{ amount: "4", secret: "s1", C: "02" }, { amount: "1", secret: "s2", C: "02" }]; } };
  const escrow = new CashuEscrow({ mint: fakeMint(), wallet: stringWallet, mintUrl: "https://testnut.cashu.space" });
  const r = await escrow.redeemToken("cashuAnything");
  assert.equal(r.amountSats, 5, "\"4\" + \"1\" must be 5, not \"41\"");
});

// ---------------------------------------------------------------- full job flow on a fake relay
function fakePublisher() {
  const published = [];
  return { published, publish: async (ev) => (published.push(ev), ev) };
}

test("job flow: no token -> payment_required; valid token -> 6050 result with data", async () => {
  const mint = fakeMint();
  const escrow = new CashuEscrow({ mint, wallet: fakeWallet, mintUrl: "https://testnut.cashu.space" });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });

  const noToken = jobRequest({});
  await handle(noToken, publish);
  const fb1 = published.find((e) => e.kind === KIND_FEEDBACK);
  assert.ok(fb1, "feedback published");
  assert.equal(fb1.tags.find((t) => t[0] === "status")[1], "payment_required");
  assert.ok(fb1.tags.some((t) => t[0] === "amount" && t[1] === "2000"));

  published.length = 0;
  const { getEncodedToken } = await import("@cashu/cashu-ts");
  const paidToken = getEncodedToken({
    mint: "https://testnut.cashu.space",
    unit: "sat",
    proofs: [{ amount: 2, secret: "aa", C: "02aa", id: "0100aabbccddeeff00112233" }],
  });
  const paid = jobRequest({ extraTags: [["cashu", paidToken]] });
  await handle(paid, publish);
  const fb2 = published.find((e) => e.kind === KIND_FEEDBACK && e.tags.some((t) => t[0] === "status" && t[1] === "processing"));
  assert.ok(fb2, "processing feedback published");
  const result = published.find((e) => e.kind === KIND_RESULT);
  assert.ok(result, "result published");
  const payload = JSON.parse(result.content);
  assert.equal(payload.job.dvm, "meshdvm");
  assert.ok(payload.page.length > 0);
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
  assert.equal(payload.payment.amount_sats, 2);
  assert.ok(result.tags.some((t) => t[0] === "e" && t[1] === paid.id));
});

test("job flow: bad params and low budget get rejected before payment", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: "https://testnut.cashu.space" });
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, privkey: sk, log: () => {} });

  const badSite = jobRequest({ params: { site: "atlantis" } });
  await handle(badSite, publish);
  const fb = published.find((e) => e.kind === KIND_FEEDBACK);
  assert.equal(fb.tags.find((t) => t[0] === "status")[1], "error");
  assert.match(fb.content, /invalid params/);

  published.length = 0;
  const lowBudget = finalizeEvent(
    { kind: KIND_REQUEST, created_at: 1, tags: [["param", "site", "metro-core"], ["bid", "5"]], content: "" },
    sk
  );
  await handle(lowBudget, publish);
  const fb2 = published.find((e) => e.kind === KIND_FEEDBACK);
  assert.equal(fb2.tags.find((t) => t[0] === "status")[1], "payment_required");
});
