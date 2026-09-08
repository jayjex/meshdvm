// Sprint-4 tests: NUT-11 P2PK escrow lock. Payments locked to the DVM pubkey
// are redeemable only by the DVM keypair; tokens locked elsewhere (or locks on
// a bot with no key) are rejected before any swap. No network — fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { getEncodedToken, createP2PKsecret } from "@cashu/cashu-ts";

import { makeJobHandler } from "../src/index.js";
import { CashuEscrow } from "../src/cashu.js";
import { Ledger } from "../src/ledger.js";

const sk = generateSecretKey();
const MINT = "https://testnut.cashu.space";
const botPriv = bytesToHex(generateSecretKey());
const botPub = bytesToHex(schnorr.getPublicKey(new Uint8Array(Buffer.from(botPriv, "hex"))));
const otherPub = bytesToHex(schnorr.getPublicKey(generateSecretKey()));

const proof = ([amount, secret], i = 0) => ({
  amount,
  secret,
  C: "02" + (11 + i).toString(16).padStart(2, "0").repeat(31), // v4 tokens hex-encode C
  id: "01aabbccddeeff00112233",
});
const proofs = (specs) => specs.map(proof);

function fakeMint() {
  return {
    async check(req) { return { states: req.Ys.map((Y) => ({ Y, state: "UNSPENT", witness: null })) }; },
  };
}

function fakeWallet(receiveProofs) {
  const calls = { receive: [] };
  return {
    mint: { mintUrl: MINT },
    calls,
    async receive(token, config) {
      calls.receive.push({ token, config });
      return receiveProofs;
    },
  };
}

/** Encode a token whose proofs carry P2PK secrets (createP2PKsecret builds the
 *  NUT-10 secret string the real wallets produce). */
function lockedToken(lockPubkey, specs) {
  return getEncodedToken({
    mint: MINT,
    unit: "sat",
    proofs: specs.map(([amount], i) => ({ amount, secret: createP2PKsecret(lockPubkey), C: "02" + (21 + i).toString(16).padStart(2, "0").repeat(31), id: "01aabbcc" })),
  });
}

test("p2pk pubkey derived from the private key (32-byte x-only hex)", () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT, p2pkPrivKey: botPriv });
  assert.equal(escrow.p2pkPubKey, botPub);
  assert.equal(escrow.p2pkPubKey.length, 64);
});

test("verifyToken: unlocked tokens stay ok and report locked=false", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT, p2pkPrivKey: botPriv });
  const token = getEncodedToken({ mint: MINT, unit: "sat", proofs: proofs([[2, "p-plain"]]) });
  const v = await escrow.verifyToken(token);
  assert.equal(v.ok, true);
  assert.equal(v.locked, false);
  assert.equal(v.amountSats, 2);
});

test("verifyToken: token locked to the DVM pubkey is accepted, locked=true", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT, p2pkPrivKey: botPriv });
  const v = await escrow.verifyToken(lockedToken(botPub, [[2, "p-lock-us"], [1, "p-lock-us2"]]));
  assert.equal(v.ok, true);
  assert.equal(v.locked, true);
  assert.equal(v.amountSats, 3);
});

test("verifyToken: token locked to a stranger's pubkey is rejected with the lock key named", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT, p2pkPrivKey: botPriv });
  const v = await escrow.verifyToken(lockedToken(otherPub, [[5, "p-lock-other"]]));
  assert.equal(v.ok, false);
  assert.match(v.reason, /P2PK-locked to/);
  assert.match(v.reason, new RegExp(otherPub.slice(0, 8)));
});

test("verifyToken: locked token on a DVM with no p2pk key fails clean, not corrupted later", async () => {
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT });
  const v = await escrow.verifyToken(lockedToken(botPub, [[2, "p-lock-nokey"]]));
  assert.equal(v.ok, false);
  assert.match(v.reason, /no p2pk key configured/);
});

test("redeemToken: the escrow passes its privkey into the wallet receive so the witness unlocks the swap", async () => {
  const back = proofs([[2, "r-01"], [1, "r-02"]]);
  const calls = [];
  const wallet = { mint: { mintUrl: MINT } };
  wallet.receive = async (token, config) => (calls.push({ token, config }), back);
  const escrow = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT, wallet, p2pkPrivKey: botPriv });
  const r = await escrow.redeemToken("cashuBlocked");
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].config, { privkey: botPriv });

  const unlocked = new CashuEscrow({ mint: fakeMint(), mintUrl: MINT, wallet });
  await unlocked.redeemToken("cashuBnolock");
  assert.deepEqual(calls[1].config, undefined, "unlocked redeem path stays config-free");
});

// ---------------------------------------------------------------- handler end to end
function paidJob(token) {
  return finalizeEvent(
    {
      kind: 5050,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["param", "site", "metro-core"], ["param", "limit", "2"], ["bid", "5000"], ["cashu", token]],
      content: "",
    },
    sk
  );
}

test("handler: wrong-lock token produces a payment-rejected error and never reaches the query", async () => {
  const ledger = new Ledger(":memory:");
  let redeemed = false;
  const escrow = new CashuEscrow({
    mint: fakeMint(),
    mintUrl: MINT,
    wallet: { mint: { mintUrl: MINT }, async receive() { redeemed = true; return []; }, async send() { throw new Error("not reached"); } },
    p2pkPrivKey: botPriv,
  });
  const feedbacks = [];
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });
  await handle(paidJob(lockedToken(otherPub, [[3, "p-wrong"]])), async (ev) => (feedbacks.push(ev), ev));
  assert.equal(redeemed, false, "a token locked to someone else must never be swapped");
  const err = feedbacks.find((e) => e.kind === 7000 && e.tags.some((t) => t[0] === "status" && t[1] === "error"));
  assert.ok(err, "an error feedback went out");
  assert.match(err.content, /P2PK-locked/);
  ledger.close();
});

test("handler: correctly locked token redeems and the result payment block flags p2pk", async () => {
  const ledger = new Ledger(":memory:");
  const escrow = new CashuEscrow({
    mint: fakeMint(),
    mintUrl: MINT,
    wallet: {
      mint: { mintUrl: MINT },
      async receive() { return proofs([[3, "w-01"]]); },
      async send(n, pool) { const pick = pool[0]; return { send: [pick], keep: pool.slice(1) }; },
    },
    p2pkPrivKey: botPriv,
  });
  const published = [];
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });
  await handle(paidJob(lockedToken(botPub, [[3, "p-right"], [2, "p-right2"]])), async (ev) => (published.push(ev), ev));
  const result = published.find((e) => e.kind === 6050);
  assert.ok(result, "result published");
  const payload = JSON.parse(result.content);
  assert.equal(payload.payment.p2pk_locked, true);
  assert.equal(payload.payment.p2pk_pubkey, botPub);
  ledger.close();
});

test("handler: unlocked token still pays (back-compat) and the payment block says unlocked", async () => {
  const ledger = new Ledger(":memory:");
  const escrow = new CashuEscrow({
    mint: fakeMint(),
    mintUrl: MINT,
    wallet: {
      mint: { mintUrl: MINT },
      async receive() { return proofs([[2, "u-01"]]); },
      async send(n, pool) { const pick = pool[0]; return { send: [pick], keep: pool.slice(1) }; },
    },
    p2pkPrivKey: botPriv,
  });
  const published = [];
  const handle = makeJobHandler({ escrow, ledger, privkey: sk, log: () => {} });
  await handle(paidJob(getEncodedToken({ mint: MINT, unit: "sat", proofs: proofs([[2, "u-pay"]]) })), async (ev) => (published.push(ev), ev));
  const payload = JSON.parse(published.find((e) => e.kind === 6050).content);
  assert.equal(payload.payment.p2pk_locked, false);
  ledger.close();
});

