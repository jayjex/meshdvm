// NIP-90 protocol layer: parse kind 5050 job requests, build kind 6050 results
// and kind 7000 feedback. Pure functions, no relay or mint I/O. Unit-tested in test/.
//
// Kind choice: requests use 5050 (sprint order). Results use 6050 = 5050 + 1000
// because NIP-90 requires result kinds in the 6000-6999 range and feedback at 7000.
// Override via env MESH_RESULT_KIND if a client needs a different mapping.

export const KIND_REQUEST = 5050;
export const KIND_RESULT = Number(process.env.MESH_RESULT_KIND || KIND_REQUEST + 1000);
export const KIND_FEEDBACK = 7000;

const PARAM_KEYS = ["site", "sensor", "device", "since", "until", "anomaly", "limit", "offset", "stats"];

/** Parse a NIP-90 job request event.
 *  Params come from `param` tags; `content` JSON overrides tags when both exist.
 *  Returns { ok, requestId, requester, params, budgetMsat, resultRelays, token, error }. */
export function parseRequestEvent(ev) {
  if (!ev || typeof ev !== "object") return { ok: false, error: "event is null" };
  if (typeof ev.kind !== "number" || ev.kind < 5000 || ev.kind > 5999)
    return { ok: false, error: `kind ${ev.kind} is not a NIP-90 request (5000-5999)` };
  if (!ev.id || !ev.pubkey) return { ok: false, error: "event missing id or pubkey" };

  const params = {};
  const budgetMsat = paramValue(ev.tags, "bid") ? Number(paramValue(ev.tags, "bid")) : null;
  const resultRelays = (ev.tags || [])
    .filter((t) => t[0] === "relays" && typeof t[1] === "string")
    .flatMap((t) => t.slice(1).filter(Boolean));

  if (typeof ev.content === "string" && ev.content.trim().startsWith("{")) {
    try {
      const c = JSON.parse(ev.content);
      for (const k of PARAM_KEYS) if (c[k] !== undefined && c[k] !== null && c[k] !== "") params[k] = c[k];
    } catch {
      // content that is not JSON is ignored; param tags still apply
    }
  }
  for (const k of PARAM_KEYS) {
    const v = paramValue(ev.tags, k);
    if (v !== null && params[k] === undefined) params[k] = v;
  }

  return {
    ok: true,
    requestId: ev.id,
    requester: ev.pubkey,
    params,
    budgetMsat: Number.isFinite(budgetMsat) ? budgetMsat : null,
    resultRelays,
    token: extractCashuToken(ev),
  };
}

/** Cashu token can ride in the request content ({"cashu":"cashu..."}) or a `cashu` tag. */
export function extractCashuToken(ev) {
  if (typeof ev.content === "string" && ev.content.trim().startsWith("{")) {
    try {
      const c = JSON.parse(ev.content);
      if (typeof c.cashu === "string" && c.cashu.startsWith("cashu")) return c.cashu;
    } catch { /* ignore */ }
  }
  const t = paramValue(ev.tags, "cashu");
  return t && t.startsWith("cashu") ? t : null;
}

function paramValue(tags, key) {
  for (const t of tags || []) {
    if (t[0] === "param" && t[1] === key && t[2] !== undefined) return t[2];
    if (t[0] === key && t[1] !== undefined) return t[1]; // shorthand ["site","metro-core"]
  }
  return null;
}

/** Result event template (kind 6050). Caller signs with finalizeEvent. */
export function buildResultEvent(request, payload, { amountMsat, mintUrl, botPubkey }) {
  return {
    kind: KIND_RESULT,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["e", request.requestId],
      ["p", request.requester],
      ["request", JSON.stringify(request.raw || {})],
      ["amount", String(amountMsat), mintUrl],
    ],
    content: JSON.stringify(payload),
  };
}

/** Feedback event template (kind 7000). Status per NIP-90:
 *  payment_required | processing | error | payment_released. */
export function buildFeedbackEvent(request, status, { amountMsat, mintUrl, message } = {}) {
  const tags = [
    ["e", request.requestId],
    ["p", request.requester],
    ["status", status],
  ];
  if (amountMsat && mintUrl) tags.push(["amount", String(amountMsat), mintUrl]);
  return {
    kind: KIND_FEEDBACK,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: message || "",
  };
}
