// Sprint-3 tests: spendable-balance rehydration after a restart. The ledger
// holds candidate proofs (redeemed + refund keep sides); the mint decides via
// NUT-07 checkstate which are still unspent. No network — fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashToCurve, getEncodedToken } from "@cashu/cashu-ts";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

import { makeJobHandler } from "../src/index.js";
import { CashuEscrow } from "../src/cashu.js";
import { Ledger } from "../src/ledger.js";

const sk = generateSecretKey();
const MINT = "https://testnut.cashu.space";
const enc = new TextEncoder();
const Yof = (secret) => hashToCurve(enc.encode(String(secret))).toHex();

/** Mint fake with a spent set: proofs whose Y (by secret) is in the set come
 *  back SPENT from checkstate, everything else UNSPENT. */
function spentAwareMint(spentSecrets = new Set()) {
  return {
    async check(req) {
      return {
        states: req.Ys.map((Y) => ({ Y, state: [...spentSecrets].some((s) => Yof(s) === Y) ? "SPENT" : "UNSPENT", witness: null })),
      };
    },
  };
}

const proofs = (specs) => specs.map(([amount, secret]) => ({ amount, secret, C: `02${secret}`, id: "0100aabbccddeeff00112233" }));

// ---------------------------------------------------------------- restoreBalance
test("restoreBalance: keeps unspent proofs, drops ones spent at the mint", async () => {
  const escrow = new CashuEscrow({ mint: spentAwareMint(new Set(["s-spent"])), mintUrl: MINT });
  const r = await escrow.restoreBalance(proofs([[2, "s-spent"], [3, "s-live"], [4, "s-also-live"]]));
  assert.equal(r.ok, true);
  assert.equal(r.restored, 2);
  assert.equal(r.dropped, 1);
  assert.equal(r.sats, 7);
  assert.equal(escrow.balance.length, 2);
  assert.deepEqual(escrow.balance.map((p) => p.secret), ["s-live", "s-also-live"]);
});

test("restoreBalance: empty candidate list restores nothing and never calls the mint", async () => {
  const mint = { check: () => { throw new Error("mint must not be asked for zero proofs"); } };
  const escrow = new CashuEscrow({ mint, mintUrl: MINT });
  const r = await escrow.restoreBalance([]);
  assert.equal(r.ok, true);
  assert.equal(r.restored, 0);
  assert.deepEqual(escrow.balance, []);
  await escrow.restoreBalance(null);
  assert.deepEqual(escrow.balance, []);
});

test("restoreBalance: mint unreachable at boot -> empty balance, not stale proofs", async () => {
  const escrow = new CashuEscrow({ mint: { async check() { throw new Error("connection refused"); } }, mintUrl: MINT });
  const r = await escrow.restoreBalance(proofs([[5, "s-x"]]));
  assert.equal(r.ok, false);
  assert.match(r.reason, /checkstate failed/);
  assert.deepEqual(escrow.balance, [], "an unknown-state proof must not enter the spendable balance");
});

// ---------------------------------------------------------------- ledger keep sides
test("ledger: keep-side proofs survive a restart and spendableProofs dedups by secret", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meshdvm-rehyd-"));
  const dbPath = path.join(dir, "ledger.sqlite3");

  const first = new Ledger(dbPath);
  first.markSeen("ev-9");
  first.recordJob({ requestId: "req-9", requester: "pk", params: {}, budgetMsat: 5000, status: "received" });
  first.recordPayment({ requestId: "req-9", token: "cashuT", amountSats: 5, overpaymentSats: 3, proofs: proofs([[3, "s-spent-by-swap"], [2, "s-keep"]]) });
  first.recordRefund({ requestId: "req-9", amountSats: 3, token: "cashuChange", state: "sent", keepProofs: proofs([[2, "s-keep-new"]]) });
  first.close();

  const second = new Ledger(dbPath);
  const candidates = second.spendableProofs();
  assert.equal(candidates.length, 3, "payment proofs + refund keep side, deduplicated by secret");
  assert.deepEqual(candidates.map((p) => p.secret).sort(), ["s-keep", "s-keep-new", "s-spent-by-swap"].sort());
  second.close();
});

test("ledger: corrupt and empty proof rows never crash spendableProofs", () => {
  const db = new Ledger(":memory:");
  db.recordPayment({ requestId: "r1", token: "t", amountSats: 1, overpaymentSats: 0, proofs: null });
  assert.deepEqual(db.spendableProofs(), []);

  const broken = new Ledger(":memory:");
  broken.db
    .prepare("INSERT OR REPLACE INTO payments (request_id, token_hash, amount_sats, overpayment_sats, proofs_json, redeemed_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("r2", "h1", 1, 0, "{not json", 1);
  assert.deepEqual(broken.spendableProofs(), []);
  db.close();
  broken.close();
});

// ---------------------------------------------------------------- end to end across a restart
function fakeWallet() {
  return {
    mint: { mintUrl: MINT },
    async receive() { return proofs([[3, "bb01"], [2, "bb02"]]); },
    async send(n, proofsList) {
      const pool = proofsList;
      const pick = pool.find((p) => Number(p.amount) === n);
      if (!pick) throw new Error(`cannot split ${n}`);
      return { send: [{ ...pick }], keep: pool.filter((p) => p !== pick) };
    },
  };
}

function fakeMint() {
  return {
    async createMintQuoteBolt11() { return { quote: "q-1", request: "lnbc1test", state: "UNPAID" }; },
    async checkMintQuoteBolt11() { return { state: "PAID" }; },
    async check(req) { return { states: req.Ys.map((Y) => ({ Y, state: "UNSPENT", witness: null })) }; },
  };
}

test("rehydration end to end: restart restores the keep-side balance, spent swap inputs drop out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meshdvm-rehyd-"));
  const dbPath = path.join(dir, "e2e.sqlite3");

  // session 1: buyer pays 5 sat, 3 sat goes back as change. The wallet swap
  // consumes the 3-sat redeemed proof, so it is SPENT at the mint afterwards;
  // the 2-sat keep side is the only live proof.
  const spentAtMint = new Set(["bb01"]);
  const escrow1 = new CashuEscrow({
    mint: { ...fakeMint(), async check(req) { return { states: req.Ys.map((Y) => ({ Y, state: spentAtMint.has(Y) ? "SPENT" : "UNSPENT", witness: null })) }; } },
    wallet: fakeWallet(),
    mintUrl: MINT,
  });
  const ledger1 = new Ledger(dbPath);
  const handle1 = makeJobHandler({ escrow: escrow1, ledger: ledger1, privkey: sk, log: () => {} });
  const paidToken = getEncodedToken({ mint: MINT, unit: "sat", proofs: proofs([[3, "aa01"], [2, "aa02"]]) });
  const ev = finalizeEvent(
    { kind: 5050, created_at: 1, tags: [["param", "site", "metro-core"], ["param", "limit", "2"], ["bid", "5000"], ["cashu", paidToken]], content: "" },
    sk
  );
  await handle1(ev, async () => {});
  assert.deepEqual(escrow1.balance.map((p) => p.secret), ["bb02"], "after the refund the in-memory balance is the keep side");
  ledger1.close();

  // session 2: fresh escrow + ledger over the same file, same restore path the
  // bot takes on its first job after a restart
  const ledger2 = new Ledger(dbPath);
  assert.equal(ledger2.isSeen(ev.id), true);
  const escrow2 = new CashuEscrow({ mint: spentAwareMint(spentAtMint), mintUrl: MINT });
  const restored = await escrow2.restoreBalance(ledger2.spendableProofs());
  assert.equal(restored.ok, true);
  assert.equal(restored.restored, 1, "the spent 3-sat swap input is filtered by the mint, the 2-sat keep side stays");
  assert.equal(restored.sats, 2);
  assert.deepEqual(escrow2.balance.map((p) => p.secret), ["bb02"]);
  ledger2.close();
});

test("handler rehydrates once on the first fresh job; duplicates never touch the balance", async () => {
  const ledger = new Ledger(":memory:");
  const escrow = new CashuEscrow({ mint: { async check() { throw new Error("not reachable"); } }, mintUrl: MINT });
  let restores = 0;
  escrow.restoreBalance = async () => {
    restores += 1;
    return { ok: true, restored: 0, dropped: 0, sats: 0 };
  };
  const jobRequest = (params) =>
    finalizeEvent(
      { kind: 5050, created_at: 1, tags: [...Object.entries(params).map(([k, v]) => ["param", k, String(v)]), ["bid", "2000"]], content: "" },
      sk
    );
  const { published, publish } = { published: [], publish: async (ev) => (published.push(ev), ev) };
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });

  await handle(jobRequest({ site: "metro-core" }), publish);
  assert.equal(restores, 1, "first fresh job triggers the rehydration");
  assert.equal(published.filter((e) => e.kind === 7000).length, 1);

  await handle(jobRequest({ site: "riverside-park" }), publish);
  assert.equal(restores, 1, "second job in the same process skips it");
  assert.equal(published.filter((e) => e.kind === 7000).length, 2);

  const ev = jobRequest({ site: "north-industrial" });
  await handle(ev, publish);
  await handle({ ...ev }, publish); // relay replay of the same event id
  assert.equal(restores, 1);
  assert.equal(published.filter((e) => e.kind === 7000).length, 3, "replay must not produce feedback");
  ledger.close();
});
