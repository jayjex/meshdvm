# meshdvm

A Nostr Data Vending Machine (NIP-90) that sells [SensorMesh](https://github.com/jayjex) IoT sensor data and takes Cashu ecash. No accounts on either side: the buyer is an npub, the payment is a token string pasted into a Nostr event.

Built for the Bitshala BOSS Battle hackathon, Freedom Stack track (Nostr + ecash). Sprint 1 = week-1 core: the request/response loop works end to end on public relays with testnet ecash.

## How it works

1. A buyer publishes a NIP-90 job request (kind `5050`) with query params in `param` tags or JSON content: `site`, `sensor`, `device`, `since`, `until`, `anomaly`, `limit`, `offset`, `stats`. A `bid` tag carries the budget in msat.
2. The bot replies with kind `7000` job feedback. First status is `payment_required`, with the price and mint in the `amount` tag.
3. The buyer mints a Cashu token at the configured mint (default `https://testnut.cashu.space`, testnet) and resends the request with the token in content `{"cashu":"cashu..."}` or a `cashu` tag.
4. The bot verifies the proofs against the mint (NUT-07 checkstate, rejects spent tokens and foreign mints), swaps them into its own keyset, then publishes the result (kind `6050`) with the data as JSON content and a `request` tag echoing the job.
5. Every result pins the dataset SHA-256, so buyers can verify the bytes they got against the published file.

Overpayment comes back to the buyer as a fresh Cashu token: the result payload carries `payment.change_token` (overpayments below 2 sat stay as a tip — keyset fees make smaller tokens unredeemable). Job history, payments, refunds, and processed event ids persist in a local SQLite ledger, so a restart neither re-redeems a replayed token nor loses the books.

## Quick start

```sh
npm install
npm test          # 22 tests (smoke + hardening), no network
npm start         # bot on nos.lol / relay.primal.net / offchain.pub + HTTP :8795
```

Config via env (or a `.env` file, loaded with `--env-file-if-exists`):

| Var | Default | What |
| --- | --- | --- |
| `MESH_NSEC` | ephemeral key | Nostr key of the DVM. Save it if you want the same npub across restarts. |
| `MESH_MINT_URL` | `https://testnut.cashu.space` | Cashu mint to accept tokens from |
| `MESH_RELAYS` | `wss://nos.lol,wss://relay.primal.net,wss://offchain.pub` | Comma-separated relay list |
| `MESH_PRICE_SATS` | `2` | Price per query call in sats (mint swap fee is 1 sat, so 2 is the smallest redeemable payment) |
| `MESH_HTTP_PORT` | `8795` | Port for the sample endpoint |
| `MESH_DB` | `data/meshdvm.sqlite3` | SQLite ledger file (jobs, payments, refunds, seen event ids) |

## Free sample

`GET /v1/sensormesh/sample?limit=20` returns the first page of rows plus the dataset hash. `GET /health` shows relay list, mint, and price.

## Status

Working: request parsing, feedback, token verify + redeem, overpayment change refunds, SQLite ledger (restart-safe, event dedup), filtered queries with sha256 pinning, free sample endpoint, 3-relay subscription.

The DVM npub for week 1: `npub1sqc84t7fgh86557yv4djnhvg7037zlvnnxfluhydgmu89qa756gqg3m3w0` (key lives in a local `.env`, never committed).

Try it yourself while the bot is running:

```sh
node examples/client.js           # mint 2 sat testnet, buy one query, print the result
node examples/client.js --no-pay  # unpaid request, expect payment_required feedback
```

Set `MESH_DVM_PUBKEY` in your env to the DVM hex pubkey so the client ignores result events from other DVMs on the same relays (several free DVMs answer any kind 5050 they see).

Not yet (sprint 3+): P2PK-locked tokens, multi-mint, wallet balance rehydration after restart.

## License

MIT
