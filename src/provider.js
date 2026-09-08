// Pricing + data access for the SensorMesh dataset sold over NIP-90.
// Week-1 pricing: flat rate per successful query call (per page of rows).
// Default 2 sat: the testnet keyset charges 1 sat swap fee per proof, so a
// 2-sat single-proof token is the smallest redeemable payment.
export const PRICE_SATS = Number(process.env.MESH_PRICE_SATS || 2);
export const PRICE_MSAT = PRICE_SATS * 1000;

/** Run the SensorMesh query with NIP-90 params and shape the result payload.
 *  Mirrors the MCP tool contract from sensormesh/mcp (same filters, same fields). */
export async function buildDataPayload(query, params = {}) {
  const { site, sensor, device, since, until, anomaly, limit, offset, stats } = params;

  const filters = {};
  if (site) filters.site = site;
  if (sensor) filters.sensor = sensor;
  if (device) filters.device = device;
  if (since) filters.since = since;
  if (until) filters.until = until;
  if (anomaly) filters.anomaly = anomaly;

  const n = Number(limit);
  const lim = Number.isFinite(n) && n > 0 ? Math.min(n, query.MAX_ROWS_PER_CALL) : query.DEFAULT_ROWS_PER_CALL;
  const off = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;

  const page = await query.queryReadings(filters, lim, off);

  const payload = {
    job: { dvm: "meshdvm", dataset: "sensormesh-sample" },
    data_file: "sensormesh-sample.csv", // basename only: keep server paths out of results
    sha256: page.sha256,
    total_rows_in_file: page.total_rows_in_file,
    total_matched: page.total_matched,
    offset: page.offset,
    returned: page.returned,
    next_offset: page.next_offset,
    page: page.page,
  };

  if (stats) payload.stats = await query.getStats(filters.sensor ? { sensor: filters.sensor } : {});
  return payload;
}

/** Validate filter values against the dataset. Unknown values reject the job
 *  with a machine-readable hint instead of an empty result. */
export function validateParams(query, params = {}) {
  const problems = [];
  if (params.site && !query.SITES.includes(params.site))
    problems.push({ param: "site", value: params.site, allowed: query.SITES });
  if (params.sensor && !query.SENSOR_TYPES.includes(params.sensor))
    problems.push({ param: "sensor", value: params.sensor, allowed: query.SENSOR_TYPES });
  return problems;
}
