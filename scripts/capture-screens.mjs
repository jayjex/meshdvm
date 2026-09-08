// Capture demo screenshots for docs/img/ from REAL captured output:
//   1. bot-relay.png     — bot log + client log of one live E2E job (testnet)
//   2. health-json.png   — /health JSON as served
//   3. refund-token.png  — payment.change_token block from the result payload
// Inputs are the log files written by the actual bot and examples/client.js
// runs; this script only styles and renders them. No content is invented here.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("/home/uwuki/node_modules/.pnpm/playwright@1.62.1/node_modules/"); // playwright lives in the pnpm store
const { chromium } = require("playwright");

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const LOGS = path.join(ROOT, "tmp-logs");
const OUT = path.join(ROOT, "docs", "img");
fs.mkdirSync(OUT, { recursive: true });

const botLog = fs.readFileSync(path.join(LOGS, "bot-sprint3-run2.log"), "utf8").trim();
const clientLog = fs.readFileSync(path.join(LOGS, "client-sprint3-restart.log"), "utf8").trim();
const health = JSON.stringify(JSON.parse(fs.readFileSync(path.join(LOGS, "health.json"), "utf8")), null, 2);

// client log: keep everything up to the result header, hide the (twice-printed)
// payment block — it gets its own screenshot
const clientHead = clientLog.split(/\[payment\]/)[0].replace(/("page": \[)[\s\S]*?(\n  \],\n  "payment")/, "$1\n    … 5 rows …$2");

// payment block as printed by the client ([payment] { ... })
const paymentBlock = clientLog.split("[payment] ")[1];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function page(title, subtitle, bodyHtml) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #16181d; font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; padding: 28px; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; background: #1d2026; border: 1px solid #2c313a; border-bottom: none; border-radius: 10px 10px 0 0; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .r { background: #ff5f57; } .y { background: #febc2e; } .g { background: #28c840; }
  .bar .title { margin-left: 8px; color: #9aa4b2; font-size: 14px; }
  pre { background: #101216; border: 1px solid #2c313a; border-radius: 0 0 10px 10px; padding: 18px 20px; color: #d7dde6; font-size: 14px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
  .tag { color: #7ee787; } .warn { color: #f0b72f; } .dim { color: #6e7781; }
  h1 { color: #e6edf3; font-size: 15px; font-weight: 500; margin: 0 0 14px 2px; font-family: sans-serif; }
  h1 span { color: #8b949e; font-family: monospace; font-size: 13px; }
</style></head><body>
<h1>${esc(title)} <span>${esc(subtitle)}</span></h1>
${bodyHtml}
</body></html>`;
}

const colorize = (text) =>
  esc(text)
    .replace(/\[(meshdvm|nostr|http)\]/g, '<span class="dim">[$1]</span>')
    .replace(/\[wallet\]/g, '<span class="warn">[wallet]</span>')
    .replace(/\[job\]/g, '<span class="tag">[job]</span>')
    .replace(/\[client\]/g, '<span class="dim">[client]</span>')
    .replace(/\[feedback\]/g, '<span class="warn">[feedback]</span>')
    .replace(/\[result\]/g, '<span class="tag">[result]</span>')
    .replace(/\[payment\]/g, '<span class="tag">[payment]</span>');

const shots = [
  {
    name: "bot-relay.png",
    title: "Live job over public relays (testnut testnet)",
    subtitle: "left: buyer client · right: meshdvm bot log",
    body: `<div style="display:flex;gap:16px">
      <div style="flex:1"><div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">node examples/client.js</span></div><pre>${colorize(clientHead)}</pre></div>
      <div style="flex:1"><div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">npm start (bot)</span></div><pre>${colorize(botLog)}</pre></div>
    </div>`,
  },
  {
    name: "health-json.png",
    title: "GET /health on :8795",
    subtitle: "relay list, mint, price, ledger totals restored from sqlite",
    body: `<div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">curl -s localhost:8795/health</span></div><pre>${esc(health)}</pre>`,
  },
  {
    name: "refund-token.png",
    title: "Overpayment comes back as a fresh cashu token",
    subtitle: "payment block of the kind 6050 result payload",
    body: `<div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="title">kind 6050 result content (client view)</span></div><pre>${colorize("[payment] " + paymentBlock)}</pre>`,
  },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1720, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
for (const s of shots) {
  await p.setContent(page(s.title, s.subtitle, s.body));
  await p.setViewportSize({ width: 1720, height: 900 });
  const el = p.locator("body");
  await el.screenshot({ path: path.join(OUT, s.name) });
  console.log(`wrote docs/img/${s.name}`);
}
await browser.close();
