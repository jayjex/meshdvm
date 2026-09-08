// Demo client: buy one SensorMesh query over NIP-90 with Cashu.
// Mints a token at the testnet mint, publishes the kind 5050 job, waits for
// feedback (7000) and the result (6050), prints the payload.
// Usage: node examples/client.js [--no-pay] [--p2pk <dvm-hex-pubkey>]
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { Mint, Wallet, getEncodedToken } from "@cashu/cashu-ts";

const RELAYS = (process.env.MESH_RELAYS || "wss://nos.lol,wss://relay.primal.net,wss://offchain.pub,wss://nostr.wine,wss://relay.snort.social")
  .split(",")
  .map((s) => s.trim());
const MINT_URL = process.env.MESH_MINT_URL || "https://testnut.cashu.space";
const PRICE_SATS = Number(process.env.CLIENT_MINT_SATS || 2); // must cover the mint's 1-sat swap fee; mint more to see the change refund
const KIND_REQUEST = 5050;
const TIMEOUT_MS = Number(process.env.CLIENT_TIMEOUT_MS || 45000);
const PAY = !process.argv.includes("--no-pay");

const sk = generateSecretKey();
const pk = getPublicKey(sk);
console.log(`[client] ${nip19.npubEncode(pk)}`);

// --p2pk: lock the payment to the DVM's hex pubkey (NUT-11) so only the DVM
// keypair can redeem it — an interceptor who grabs the event gets nothing.
const P2PK_ARG = process.argv.indexOf("--p2pk");
const P2PK_PUBKEY = P2PK_ARG !== -1 ? process.argv[P2PK_ARG + 1] : null;
const BOT_PUBKEY = process.env.MESH_DVM_PUBKEY || P2PK_PUBKEY;

let token = null;
if (PAY) {
  const mint = new Mint(MINT_URL);
  console.log(`[client] minting ${PRICE_SATS} sat at ${MINT_URL}...`);
  const wallet = new Wallet(mint);
  await wallet.loadMint();
  const quote = await wallet.mint.createMintQuoteBolt11({ amount: PRICE_SATS, unit: "sat" });
  // testnut's fake wallet settles invoices itself, but not instantly: poll until PAID
  let state = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 700));
    state = await wallet.mint.checkMintQuoteBolt11(quote.quote);
    if (String(state.state) === "PAID" || state.state === 2) break;
  }
  if (String(state?.state) !== "PAID" && state?.state !== 2) throw new Error(`mint quote never settled (state ${state?.state})`);
  const outputType = P2PK_PUBKEY
    ? { type: "p2pk", options: { pubkey: P2PK_PUBKEY } } // NUT-11: proofs only spendable by the DVM keypair
    : undefined;
  const proofs = await wallet.mintProofsBolt11(PRICE_SATS, quote, undefined, outputType);
  token = getEncodedToken({ mint: MINT_URL, unit: "sat", proofs });
  console.log(`[client] token ready (${token.length} chars)`);
} else {
  console.log("[client] --no-pay: sending unpaid request, expecting payment_required feedback");
}

const pool = new SimplePool();
const params = { site: "metro-core", sensor: "air_quality", limit: "5" };
const tags = [
  ...Object.entries(params).map(([k, v]) => ["param", k, v]),
  ["bid", String(PRICE_SATS * 1000)],
  ["relays", ...RELAYS],
];
if (token) tags.push(["cashu", token]);

const request = finalizeEvent(
  { kind: KIND_REQUEST, created_at: Math.floor(Date.now() / 1000), tags, content: "" },
  sk
);
console.log(`[client] publishing job ${request.id} (kind ${KIND_REQUEST}) to ${RELAYS.length} relays...`);
await Promise.allSettled(pool.publish(RELAYS, request));

const REQUEST_ID = request.id;
const seen = new Set();
const sub = pool.subscribeMany(
  RELAYS,
  { kinds: [7000, 6050], "#p": [pk], since: Math.floor(Date.now() / 1000) - 10 },
  {
    onevent: (ev) => {
      const key = `${ev.kind}:${ev.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      const refsOurJob = (ev.tags || []).some((t) => t[0] === "e" && t[1] === REQUEST_ID);
      if (!refsOurJob) return; // relay fuzz: other DVMs answer kind 5050 jobs they see
      if (ev.kind === 6050 && BOT_PUBKEY && ev.pubkey !== BOT_PUBKEY) return; // result must come from the DVM we paid
      if (ev.kind === 7000) {
        const status = ev.tags.find((t) => t[0] === "status")?.[1];
        console.log(`[feedback] ${status}: ${ev.content.slice(0, 160)}`);
      } else {
        console.log(`[result] kind ${ev.kind} id ${ev.id}`);
        const payload = JSON.parse(ev.content);
        console.log(JSON.stringify(payload, null, 2).slice(0, 2200));
        if (payload.payment) console.log(`[payment] ${JSON.stringify(payload.payment, null, 2)}`);
        console.log("[client] done");
        pool.close(RELAYS);
        process.exit(0);
      }
    },
  }
);

setTimeout(() => {
  console.error("[client] timeout waiting for result");
  pool.close(RELAYS);
  process.exit(1);
}, TIMEOUT_MS);
