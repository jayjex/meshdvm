// Refund of overpaid jobs. The overpayment goes back as a fresh cashu token
// split off the bot's own balance (cashu-ts Wallet.send). NUT-03 change outputs
// were the alternative; they need mint swap plumbing the testnut FakeWallet
// does not exercise end to end, so the simpler token-in-result/feedback path
// wins for week 2.
//
// Two knobs keep this safe on testnut:
//   MIN_CHANGE_SATS — keyset fee is 1 sat per proof (week-1 gotcha), so a 1 sat
//   change token costs more to redeem than it is worth. Below the threshold the
//   overpayment is reported as a tip instead of sent.
//   send() failure — if the bot balance cannot cover the split, the result
//   still ships; the refund state is recorded as "failed" in the ledger.
import { getEncodedToken } from "@cashu/cashu-ts";

export const MIN_CHANGE_SATS = 2;

/** Change owed for a payment: total sats in, flat price. Returns 0 when exact. */
export function calcChange(totalSats, priceSats) {
  return Math.max(0, totalSats - priceSats);
}

/** Build a change token from the bot's wallet balance.
 *  wallet: object with send(amount, proofs?, opts?) -> { keep, send } (cashu-ts Wallet shape).
 *  walletProofs: the proofs to split from (cashu-ts v4 requires them explicitly).
 *  Returns { ok, amountSats, token } or { ok: false, reason }. */
export async function buildRefundToken(wallet, amountSats, walletProofs = null) {
  if (!Number.isInteger(amountSats) || amountSats < MIN_CHANGE_SATS)
    return { ok: false, reason: `overpayment ${amountSats} sat below change threshold ${MIN_CHANGE_SATS} sat` };
  let send, keep;
  try {
    // cashu-ts v4 Wallet.send(amount, proofs?, opts?): omitting the proofs makes
    // the swap leave the keep-side proofs unsigned ("Token Already Spent" for the
    // next spend), and omitting includeFees leaves them under-funded for the
    // 1 sat/proof keyset fee. Both flags are mandatory on testnut.
    ({ send, keep } = await wallet.send(amountSats, walletProofs ?? undefined, { includeFees: true }));
  } catch (e) {
    return { ok: false, reason: `wallet send failed: ${e.message}` };
  }
  if (!send || !send.length) return { ok: false, reason: "wallet send returned no proofs" };
  const total = send.reduce((a, p) => a + (p.amount || 0), 0);
  if (total < amountSats) return { ok: false, reason: `wallet send short: ${total} < ${amountSats}` };
  const token = getEncodedToken({ mint: wallet.mint?.mintUrl, unit: "sat", proofs: send });
  return { ok: true, amountSats: total, token, keep: keep };
}
