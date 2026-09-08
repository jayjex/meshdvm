# Architecture

One Node process, three layers. Data flows Nostr → escrow → query engine → Nostr, with the sample endpoint branching off the query engine directly.

```
                 kind 5050 (job request)
 relay pool ──▶  nip90.parseRequestEvent      params / bid / cashu token
                 │
                 ▼
                 index.makeJobHandler
                 │  validateParams (provider)     bad params → kind 7000 "error"
                 │  budget < price                → kind 7000 "payment_required"
                 │  no token                      → kind 7000 "payment_required" (+ quote)
                 ▼
                 cashu.CashuEscrow
                 │  verifyToken: decode, mint match, NUT-07 checkstate
                 │  redeemToken:  wallet.receive (swap into bot keyset)
                 ▼
                 query.queryReadings / getStats   (vendored SensorMesh engine)
                 │  filters, pagination, sha256 pin
                 ▼
                 kind 6050 result (data JSON) + kind 7000 "processing" along the way

 http :8795 ──▶  /v1/sensormesh/sample   free first page + dataset hash
                 /health                 relays, mint, price, uptime
```

## Modules

- `src/nip90.js` — protocol only, pure functions: parse kind 5050 requests (`param` tags, JSON content override, `bid` budget, `relays` hint, embedded token), build kind 6050 results and kind 7000 feedback. Unit-tested with no I/O.
- `src/cashu.js` — escrow seam. `CashuEscrow` wraps a cashu-ts `Mint` + `Wallet`; both are injectable, so tests run against fakes. Quote (NUT-04), token verify (NUT-07 checkstate, mint allow-list, spent rejection), redeem (swap into the bot's proofs). Price is flat per call.
- `src/ledger.js` — SQLite job ledger on better-sqlite3: jobs, payments, refunds, and every processed event id. One file (`data/meshdvm.sqlite3`, override with `MESH_DB`), WAL mode, synchronous queries. Its stats feed `/health` and the boot log.
- `src/refund.js` — overpayment change. `calcChange` clamps at zero; `buildRefundToken` splits proofs off the bot's wallet with cashu-ts `Wallet.send` and encodes them as a fresh token. Overpayments below 2 sat (the keyset fee floor) are reported as a tip instead of sent.
- `src/provider.js` — maps NIP-90 params onto the query engine, validates filter values against known sites/sensors, prices the call.
- `src/query.js` — the SensorMesh query engine vendored from `money-mission/sensormesh/mcp/lib/query.js`. Loads the CSV once, pins it to a SHA-256, answers filters/pagination/stats from memory. Kept verbatim apart from the data path default.
- `src/index.js` — wiring: SimplePool subscription + publish, job handler state machine, HTTP sample server, env config.

## Kind mapping

Requests 5050, results 6050, feedback 7000. NIP-90 defines requests in 5000-5999, results as request kind + 1000 (6000-6999), feedback at 7000. A 5050 result kind would not round-trip through other NIP-90 clients, so the +1000 rule wins.

## Money path

testnut.cashu.space is a public testnet mint (FakeWallet: invoices auto-confirm), so the full mint → token → verify → swap loop runs without real sats. The bot treats the mint as the only trusted third party: proofs are checked for spend state at the mint and swapped on accept, meaning a replayed token fails checkstate.

Overpaid tokens are not eaten. The handler computes `total - price`, and when the change clears the 2 sat fee floor it splits that amount off the bot's own balance (`Wallet.send`) and attaches the resulting token to the result payload as `payment.change_token`. NUT-03 change outputs were the alternative; they need melt/swap plumbing the testnut FakeWallet does not exercise, so the token-in-result path wins. A failed split still ships the result and records the refund row as `failed`.

## Hardening (week 2)

Three failure modes from week 1 are closed:

- **Double redemption on replay.** `src/index.js` marks every incoming event id in `seen_events` before parsing. A relay that replays an event (or two relays delivering the same job) hits the marker once; the duplicate copy returns without feedback, redeem, or result.
- **State loss on restart.** `Ledger` (better-sqlite3) writes job rows at `received`, updates status through the flow (`paid`, `error_*`, `payment_required_*`), and stores the token hash plus proof count per payment. Reopening the same file at boot restores the books; the boot log prints the restored totals.
- **Lost change.** Refund attempts are recorded in `refunds` with a state (`sent` / `kept` / `failed`) at the moment they happen, so the ledger always answers whether change for a given job went out.

Token proofs themselves still live in the bot's seed balance; rehydrating proof state from the ledger after a crash between redeem and persist is the remaining gap (sprint 3).

## Data

`data/sensormesh-sample.csv`, 1,296 readings from 3 sites (metro-core, riverside-park, north-industrial), 3 sensor types (air_quality, temperature, noise), timestamps 2026-09-08. The hash in every result and in the sample endpoint refers to this file.
