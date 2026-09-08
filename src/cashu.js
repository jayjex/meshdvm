// Cashu escrow for week-1: quote, token verify, token redeem against one testnet
// mint (testnut.cashu.space by default). Everything takes an injectable mint
// object so unit tests never touch the network. The redemption balance lives in
// the bot's seed (env MESH_NSEC for nostr, MESH_CASHU_SEED for proofs); week-2
// adds persistence + change refunds.
import { Mint, Wallet, getTokenMetadata, hashToCurve } from "@cashu/cashu-ts";

export const DEFAULT_MINT_URL = process.env.MESH_MINT_URL || "https://testnut.cashu.space";

export class CashuEscrow {
  /** mint: object with createMintQuoteBolt11/check/getInfo (cashu-ts Mint is compatible).
   *  wallet: object with receive(token) (cashu-ts Wallet) — optional until first redeem. */
  constructor({ mint, wallet, mintUrl = DEFAULT_MINT_URL }) {
    this.mint = mint;
    this.wallet = wallet;
    this.mintUrl = mintUrl;
    this._walletReady = null;
    this.balance = []; // spendable proofs owned by the bot (cashu-ts Wallet does not track them for us)
  }

  /** Wire up the real testnet mint from cashu-ts. */
  static async create(mintUrl = DEFAULT_MINT_URL) {
    const mint = new Mint(mintUrl);
    const escrow = new CashuEscrow({ mint, mintUrl });
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
   *  against the mint (NUT-07 checkstate). Returns
   *  { ok, amountSats, proofs, reason } — ok:false with reason on any failure. */
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
    return { ok: true, amountSats: rawAmount != null ? Number(rawAmount) : proofs.reduce((a, p) => a + Number(p.amount || 0), 0), proofs };
  }

  /** Redeem (swap) a verified token into the bot's wallet proofs. */
  async redeemToken(token) {
    try {
      const wallet = await this.ensureWallet();
      const proofs = await wallet.receive(token);
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
