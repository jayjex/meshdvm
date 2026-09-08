// Cashu escrow for week-1: quote, token verify, token redeem against one testnet
// mint (testnut.cashu.space by default). Everything takes an injectable mint
// object so unit tests never touch the network. The redemption balance lives in
// the bot's seed (env MESH_NSEC for nostr, MESH_CASHU_SEED for proofs); week-2
// adds persistence + change refunds.
import { Mint, Wallet, getTokenMetadata, hashToCurve, getP2PKExpectedWitnessPubkeys } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const DEFAULT_MINT_URL = process.env.MESH_MINT_URL || "https://testnut.cashu.space";

export class CashuEscrow {
  /** mint: object with createMintQuoteBolt11/check/getInfo (cashu-ts Mint is compatible).
   *  wallet: object with receive(token) (cashu-ts Wallet) — optional until first redeem.
   *  p2pkPrivKey: hex private key for NUT-11 P2PK — lets the bot redeem tokens
   *  locked to its pubkey and is the key buyers should lock payments to. Optional. */
  constructor({ mint, wallet, mintUrl = DEFAULT_MINT_URL, p2pkPrivKey = null }) {
    this.mint = mint;
    this.wallet = wallet;
    this.mintUrl = mintUrl;
    this.p2pkPrivKey = p2pkPrivKey;
    this.p2pkPubKey = p2pkPrivKey ? bytesToHex(schnorr.getPublicKey(hexToBytes(p2pkPrivKey))) : null;
    this._walletReady = null;
    this.balance = []; // spendable proofs owned by the bot (cashu-ts Wallet does not track them for us)
  }

  /** Wire up the real testnet mint from cashu-ts. */
  static async create(mintUrl = DEFAULT_MINT_URL, { p2pkPrivKey = null } = {}) {
    const mint = new Mint(mintUrl);
    const escrow = new CashuEscrow({ mint, mintUrl, ...(p2pkPrivKey ? { p2pkPrivKey } : {}) });
    try {
      await mint.getInfo(); // fail fast if the mint is down
    } catch (e) {
      throw new Error(`mint ${mintUrl} unreachable: ${e.message}`);
    }
    return escrow;
  }

  async ensureWallet() {
    if (this.wallet) return this.wallet;
    if (!this._walletReady) {
      const w = new Wallet(this.mint);
      await w.loadMint();
      this._walletReady = w;
      this.wallet = w; // keep the public field in sync — refund path reads escrow.wallet
    }
    return this._walletReady;
  }

  /** Mint quote for the price of one job. On testnut's fake wallet the invoice
   *  auto-pays; callers then mint with wallet.mintProofs using the quote. */
  async getQuote(amountSats) {
    const quote = await this.mint.createMintQuoteBolt11({ amount: amountSats, unit: "sat" });
    return { quoteId: quote.quote, invoice: quote.request, amountSats, mintUrl: this.mintUrl };
  }

  async checkQuote(quoteId) {
    return this.mint.checkMintQuoteBolt11(quoteId); // { state, ... }
  }

  /** Decode + sum a token without network, then confirm proofs are unspent
   *  against the mint (NUT-07 checkstate). P2PK-locked proofs (NUT-11) must
   *  target this bot's p2pkPubKey, or they would redeem-fail later at the mint
   *  with no useful error. Returns
   *  { ok, amountSats, proofs, locked, reason } — ok:false with reason on any
   *  failure. locked=true when at least one proof is P2PK-locked to us. */
  async verifyToken(token) {
    let meta; // { mint, amount, unit, incompleteProofs }
    try {
      meta = getTokenMetadata(token); // handles v3 (cashuA) + v4 (cashuB), no keysets needed
    } catch (e) {
      return { ok: false, reason: `token not decodable: ${e.message}` };
    }
    const proofs = meta.incompleteProofs || [];
    if (!proofs.length) return { ok: false, reason: "token has no proofs" };

    if (meta.mint && this.mintUrl && !sameMint(meta.mint, this.mintUrl))
      return { ok: false, reason: `token mint ${meta.mint} is not ${this.mintUrl}` };

    // NUT-11: a locked proof is only spendable by the lock key. We can only
    // redeem proofs locked to OUR p2pk pubkey; anything else is rejected here
    // so the buyer gets a clear message instead of a failed swap.
    let locked = false;
    for (const p of proofs) {
      let expected;
      try {
        expected = getP2PKExpectedWitnessPubkeys(String(p.secret)); // throws when the secret is not P2PK
      } catch {
        continue; // plain (unlocked) secret — fine
      }
      locked = true;
      if (!this.p2pkPubKey) return { ok: false, reason: "token is P2PK-locked but this DVM has no p2pk key configured" };
      if (!expected.some((pk) => strip02(pk) === strip02(this.p2pkPubKey)))
        return { ok: false, reason: `token is P2PK-locked to ${expected[0]?.slice(0, 16)}…, this DVM can only redeem locks to ${this.p2pkPubKey.slice(0, 16)}…` };
    }

    // NUT-07: checkstate takes Y = hashToCurve(secret), hex-encoded
    const enc = new TextEncoder();
    const Ys = proofs.map((p) => hashToCurve(enc.encode(String(p.secret))).toHex());
    let states;
    try {
      states = await this.mint.check({ Ys });
    } catch (e) {
      return { ok: false, reason: `mint checkstate failed: ${e.message}` };
    }
    for (const s of states.states || []) {
      if (s.state && s.state !== "UNSPENT") return { ok: false, reason: `proof ${s.Y || s.secret} is ${s.state}` };
    }
    const rawAmount = meta.amount?.value ?? meta.amount; // v4 Amount wraps a bigint
    // proof.amount is a STRING in cashu-ts v4 — Number() or it concats ("4"+"1"="41")
    return { ok: true, amountSats: rawAmount != null ? Number(rawAmount) : proofs.reduce((a, p) => a + Number(p.amount || 0), 0), proofs, locked };
  }

  /** Redeem (swap) a verified token into the bot's wallet proofs. When the
   *  bot has a p2pk key, NUT-11-locked proofs get the witness signatures that
   *  unlock them during the swap. */
  async redeemToken(token) {
    try {
      const wallet = await this.ensureWallet();
      const config = this.p2pkPrivKey ? { privkey: this.p2pkPrivKey } : undefined;
      const proofs = await wallet.receive(token, config);
      this.balance.push(...proofs);
      return { ok: true, amountSats: proofs.reduce((a, p) => a + Number(p.amount || 0), 0), proofs };
    } catch (e) {
      return { ok: false, reason: `redeem failed: ${e.message}` };
    }
  }

  /** Rebuild the spendable balance after a restart. The ledger only stores
   *  candidate proofs (redeemed inputs + refund keep sides); which of those
   *  are actually unspent is decided by the mint. A proof swapped away in an
   *  earlier refund is SPENT at the mint and drops out here. If the mint is
   *  unreachable the balance stays empty — refunds then fail cleanly with
   *  "send failed" instead of replaying proofs of unknown state. */
  async restoreBalance(proofs) {
    const candidates = (proofs || []).filter((p) => p && p.secret && p.C);
    if (!candidates.length) {
      this.balance = [];
      return { ok: true, restored: 0, dropped: 0, sats: 0 };
    }
    const enc = new TextEncoder();
    const Ys = candidates.map((p) => hashToCurve(enc.encode(String(p.secret))).toHex());
    let states;
    try {
      states = await this.mint.check({ Ys });
    } catch (e) {
      this.balance = [];
      return { ok: false, restored: 0, dropped: candidates.length, sats: 0, reason: `mint checkstate failed: ${e.message}` };
    }
    const spent = new Set((states.states || []).filter((s) => s.state && s.state !== "UNSPENT").map((s) => s.Y));
    const Yof = (p) => hashToCurve(enc.encode(String(p.secret))).toHex();
    this.balance = candidates.filter((p) => !spent.has(Yof(p)));
    return {
      ok: true,
      restored: this.balance.length,
      dropped: candidates.length - this.balance.length,
      sats: this.balance.reduce((a, p) => a + Number(p.amount || 0), 0),
    };
  }
}

function sameMint(a, b) {
  return String(a).replace(/\/+$/, "") === String(b).replace(/\/+$/, "");
}

// P2PK lock pubkeys may carry an ECC point prefix (02/03); compare the x-only form.
function strip02(pk) {
  return pk && pk.length === 66 && (pk.startsWith("02") || pk.startsWith("03")) ? pk.slice(2) : pk;
}
