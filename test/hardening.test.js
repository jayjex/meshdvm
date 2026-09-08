// Week-2 hardening tests: refund of overpayments, sqlite ledger persistence,
// restart-safe state reload, event dedup. No network — fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

import { KIND_REQUEST, KIND_RESULT, KIND_FEEDBACK, parseRequestEvent } from "../src/nip90.js";
import { makeJobHandler } from "../src/index.js";
import { CashuEscrow } from "../src/cashu.js";
import { Ledger } from "../src/ledger.js";
import { calcChange, buildRefundToken, MIN_CHANGE_SATS } from "../src/refund.js";
import { PRICE_SATS } from "../src/provider.js";

const sk = generateSecretKey();
const MINT = "https://testnut.cashu.space";

function jobRequest({ params = { site: "metro-core", limit: "5" }, extraTags = [] } = {}) {
  const tags = [
    ...Object.entries(params).map(([k, v]) => ["param", k, String(v)]),
    ["bid", "2000"],
    ...extraTags,
  ];
  return finalizeEvent({ kind: KIND_REQUEST, created_at: Math.floor(Date.now() / 1000), tags, content: "" }, sk);
}

function makeToken(proofs) {
  return import("@cashu/cashu-ts").then(({ getEncodedToken }) =>
    getEncodedToken({ mint: MINT, unit: "sat", proofs })
  );
}

function fakeMint() {
  return {
    async createMintQuoteBolt11(req) { return { quote: "q-1", request: "lnbc1test", state: "UNPAID" }; },
    async checkMintQuoteBolt11(quote) { return { quote, state: "PAID" }; },
    async check(req) { return { states: req.Ys.map((Y) => ({ Y, state: "UNSPENT", witness: null })) }; },
  };
}

/** Wallet stub: receive hands back fixed proofs, send splits `n` off them. */
function fakeWallet(receiveProofs) {
  return {
    mint: { mintUrl: MINT },
    async receive() { return receiveProofs; },
    async send(n) {
      const send = receiveProofs.filter((p) => p.amount <= n).slice(0, 1).map((p) => ({ ...p }));
      if (!send.length || send[0].amount !== n) throw new Error(`cannot split ${n} from ${JSON.stringify(receiveProofs)}`);
      return { keep: receiveProofs.filter((p) => p !== send[0]), send };
    },
  };
}

// ---------------------------------------------------------------- refund calc
test("calcChange: overpay, exact pay, underpay all clamp at zero", () => {
  assert.equal(calcChange(5, PRICE_SATS), 3);
  assert.equal(calcChange(PRICE_SATS, PRICE_SATS), 0);
  assert.equal(calcChange(1, PRICE_SATS), 0);
});

test("buildRefundToken: refuses to split below the fee threshold", async () => {
  const r = await buildRefundToken(fakeWallet([{ amount: 1, secret: "0a", C: "020a", id: "01" }]), MIN_CHANGE_SATS - 1);
  assert.equal(r.ok, false);
  assert.match(r.reason, /below change threshold/);

  const zero = await buildRefundToken(fakeWallet([{ amount: 2, secret: "0a", C: "020a", id: "01" }]), 0);
  assert.equal(zero.ok, false);
});

test("buildRefundToken: splits proofs into a decodable change token", async () => {
  const { getTokenMetadata } = await import("@cashu/cashu-ts");
  const wallet = fakeWallet([{ amount: 3, secret: "0a0b", C: "0204", id: "0100aabbccddeeff00112233" }]);
  const r = await buildRefundToken(wallet, 3);
  assert.equal(r.ok, true);
  assert.equal(r.amountSats, 3);
  const meta = getTokenMetadata(r.token);
  assert.equal(meta.amount.value, 3n);
  assert.ok(r.token.startsWith("cashu"));
});

test("buildRefundToken: wallet send failure comes back as a reason, not a throw", async () => {
  const wallet = fakeWallet([{ amount: 5, secret: "0a0b", C: "0204", id: "01" }]);
  const r = await buildRefundToken(wallet, 4); // 5-sat proof cannot split into 4
  assert.equal(r.ok, false);
  assert.match(r.reason, /send failed/);
});

// ---------------------------------------------------------------- ledger
test("ledger: seen-event dedup marks once, jobs/payments/refunds recorded, stats add up", () => {
  const db = new Ledger(":memory:");
  assert.equal(db.markSeen("ev-1"), true);
  assert.equal(db.markSeen("ev-1"), false);
  assert.equal(db.isSeen("ev-1"), true);
  assert.equal(db.isSeen("ev-2"), false);

  db.recordJob({ requestId: "req-1", requester: "pk", params: { site: "metro-core" }, budgetMsat: 2000, status: "received" });
  db.recordPayment({ requestId: "req-1", token: "cashuAbc", amountSats: 5, overpaymentSats: 3, proofs: [] });
  db.recordRefund({ requestId: "req-1", amountSats: 3, token: "cashuChange", state: "sent" });
  db.updateJobStatus("req-1", "paid", "result-1");

  const s = db.stats();
  assert.equal(s.jobs, 1);
  assert.equal(s.paid_jobs, 1);
  assert.equal(s.earned_sats, 5);
  assert.equal(s.refunded_sats, 3);
  assert.equal(s.seen_events, 1);
  db.close();
});

test("ledger: state survives a restart (same file, fresh instance)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meshdvm-test-"));
  const dbPath = path.join(dir, "ledger.sqlite3");

  const first = new Ledger(dbPath);
  first.markSeen("ev-42");
  first.recordJob({ requestId: "req-42", requester: "pk", params: {}, budgetMsat: 2000, status: "received" });
  first.recordPayment({ requestId: "req-42", token: "cashuX", amountSats: 4, overpaymentSats: 2, proofs: [] });
  first.close();

  const second = new Ledger(dbPath);
  assert.equal(second.isSeen("ev-42"), true, "event ids survive restart");
  const s = second.stats();
  assert.equal(s.jobs, 1);
  assert.equal(s.paid_jobs, 1);
  assert.equal(s.earned_sats, 4);
  second.close();
});

// ---------------------------------------------------------------- job flow with ledger
function fakePublisher() {
  const published = [];
  return { published, publish: async (ev) => (published.push(ev), ev) };
}

test("job flow: exact payment -> result, no refund token, ledger rows written", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), wallet: fakeWallet([{ amount: 2, secret: "0a04", C: "02", id: "0100aabbccddeeff00112233" }]), mintUrl: MINT });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  const ev = jobRequest({ extraTags: [["cashu", await makeToken([{ amount: 2, secret: "aa", C: "02aa", id: "0100aabbccddeeff00112233" }])]] });
  await handle(ev, publish);

  const result = published.find((e) => e.kind === KIND_RESULT);
  assert.ok(result, "result published");
  const payment = JSON.parse(result.content).payment;
  assert.equal(payment.overpayment_sats, 0);
  assert.equal(payment.change_token, null);
  assert.equal(ledger.stats().refunded_sats, 0);
  ledger.close();
});

test("job flow: overpayment -> change_token in result, refund row state sent", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), wallet: fakeWallet([{ amount: 3, secret: "0a04", C: "02", id: "0100aabbccddeeff00112233" }, { amount: 2, secret: "0a05", C: "02", id: "0100aabbccddeeff00112233" }]), mintUrl: MINT });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  const ev = jobRequest({ extraTags: [["cashu", await makeToken([{ amount: 3, secret: "0a01", C: "0201", id: "0100aabbccddeeff00112233" }, { amount: 2, secret: "0a02", C: "0202", id: "0100aabbccddeeff00112233" }])]] });
  await handle(ev, publish);

  const result = published.find((e) => e.kind === KIND_RESULT);
  const payment = JSON.parse(result.content).payment;
  assert.equal(payment.overpayment_sats, 3);
  assert.ok(payment.change_token, "change token attached");
  assert.ok(payment.change_token.startsWith("cashu"));
  const s = ledger.stats();
  assert.equal(s.earned_sats, 5);
  assert.equal(s.refunded_sats, 3);
  ledger.close();
});

test("job flow: 1 sat overpayment stays a tip, no token sent", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), wallet: fakeWallet([{ amount: 3, secret: "0a04", C: "02", id: "0100aabbccddeeff00112233" }]), mintUrl: MINT });
  const ledger = new Ledger(":memory:");
  const { published, publish } = fakePublisher();
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  const ev = jobRequest({ extraTags: [["cashu", await makeToken([{ amount: 3, secret: "0a03", C: "0203", id: "0100aabbccddeeff00112233" }])]] });
  await handle(ev, publish);

  const payment = JSON.parse(published.find((e) => e.kind === KIND_RESULT).content).payment;
  assert.equal(payment.overpayment_sats, 1);
  assert.equal(payment.change_token, null);
  assert.match(payment.change, /tip/);
  ledger.close();
});

test("job flow: replayed event id is skipped after restart (dedup)", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), wallet: fakeWallet([{ amount: 2, secret: "0a04", C: "02", id: "0100aabbccddeeff00112233" }]), mintUrl: MINT });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meshdvm-test-"));
  const ledgerA = new Ledger(path.join(dir, "dedup.sqlite3"));
  const { published: pubA, publish } = fakePublisher();
  const handleA = makeJobHandler({ escrow, ledger: ledgerA, privkey: sk, log: () => {} });

  const ev = jobRequest({}); // no token: cheapest way to observe the handler ran
  await handleA(ev, publish);
  assert.equal(pubA.filter((e) => e.kind === KIND_FEEDBACK).length, 1);
  ledgerA.close();

  // restart: fresh handler + fresh ledger instance on the same file, same event
  const ledgerB = new Ledger(path.join(dir, "dedup.sqlite3"));
  const { published: pubB } = fakePublisher();
  const handleB = makeJobHandler({ escrow, ledger: ledgerB, privkey: sk, log: () => {} });
  await handleB(ev, pubB.publish);
  assert.equal(pubB.length, 0, "replayed event produced no output after restart");
  ledgerB.close();
});
