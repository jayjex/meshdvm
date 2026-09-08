// Vendored from money-mission/sensormesh/mcp/lib/query.js (upstream of record).
// Keep in sync; local tweaks allowed below the upstream banner if meshdvm needs them.
// Data model: the sample CSV ships in this repo, loaded once, pinned to SHA-256.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_PATH =
  process.env.SENSORMESH_DATA_PATH || join(HERE, "..", "data", "sensormesh-sample.csv");

export const MAX_ROWS_PER_CALL = 100;
export const DEFAULT_ROWS_PER_CALL = 20;

export const SITES = ["metro-core", "riverside-park", "north-industrial"];
export const SENSOR_TYPES = ["air_quality", "temperature", "noise"];

let loaded = null; // { sha256, rows, header }

export async function loadData() {
  if (loaded) return loaded;
  const text = await readFile(DATA_PATH, "utf8");
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    const r = {};
    header.forEach((c, i) => (r[c] = cells[i]));
    r.value = Number(r.value);
    return r;
  });
  loaded = { sha256: createHash("sha256").update(text).digest("hex"), rows, header };
  return loaded;
}

function matches(r, f) {
  if (f.device && r.device_id !== f.device) return false;
  if (f.site && r.site !== f.site) return false;
  if (f.sensor && r.sensor_type !== f.sensor) return false;
  if (f.anomaly && r.anomaly !== f.anomaly) return false;
  if (f.since && r.timestamp < f.since) return false;
  if (f.until && r.timestamp > f.until) return false;
  return true;
}

export const esc = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Devices, sites, sensor types, time coverage, row counts. */
export async function listSensors() {
  const { rows, sha256 } = await loadData();
  const devices = {};
  for (const r of rows) {
    devices[r.device_id] ??= { site: r.site, sensors: new Set(), rows: 0 };
    devices[r.device_id].sensors.add(r.sensor_type);
    devices[r.device_id].rows++;
  }
  const times = rows.map((r) => r.timestamp).sort();
  return {
    data_file: DATA_PATH,
    sha256,
    rows: rows.length,
    time_range: [times[0], times[times.length - 1]],
    sensor_types: [...new Set(rows.map((r) => r.sensor_type))],
    devices: Object.fromEntries(
      Object.entries(devices).map(([id, d]) => [
        id,
        { site: d.site, sensor_types: [...d.sensors], readings: d.rows },
      ])
    ),
  };
}

/**
 * Filter + paginate readings.
 * `f`: { device, site, sensor, anomaly, since, until }, `limit` <= MAX_ROWS_PER_CALL.
 */
export async function queryReadings(f = {}, limit = DEFAULT_ROWS_PER_CALL, offset = 0) {
  const { rows, sha256, header } = await loadData();
  const filtered = rows.filter((r) => matches(r, f));
  const capped = Math.min(limit, MAX_ROWS_PER_CALL);
  const page = filtered.slice(offset, offset + capped);
  const nextOffset = offset + capped < filtered.length ? offset + capped : null;
  return {
    data_file: DATA_PATH,
    sha256,
    total_rows_in_file: rows.length,
    total_matched: filtered.length,
    offset,
    returned: page.length,
    next_offset: nextOffset,
    header,
    page,
  };
}

/** Render a queryReadings page as CSV text. */
export function pageToCsv(page, header) {
  return (
    header.map(esc).join(",") +
    "\n" +
    page.map((r) => header.map((c) => esc(r[c])).join(",")).join("\n")
  );
}

/** Per-sensor-type min/mean/max + anomaly flag counts, scoped by sensor/device. */
export async function getStats(scope = {}) {
  const { rows } = await loadData();
  const subset = rows.filter(
    (r) =>
      (!scope.sensor || r.sensor_type === scope.sensor) &&
      (!scope.device || r.device_id === scope.device)
  );
  const groups = {};
  for (const r of subset) {
    const g = (groups[r.sensor_type] ??= { n: 0, min: Infinity, max: -Infinity, sum: 0, flags: {} });
    g.n++;
    g.min = Math.min(g.min, r.value);
    g.max = Math.max(g.max, r.value);
    g.sum += r.value;
    if (r.anomaly) g.flags[r.anomaly] = (g.flags[r.anomaly] || 0) + 1;
  }
  return {
    scope: { sensor: scope.sensor, device: scope.device },
    stats: Object.fromEntries(
      Object.entries(groups).map(([t, g]) => [
        t,
        { readings: g.n, min: g.min, mean: Math.round((g.sum / g.n) * 100) / 100, max: g.max, anomaly_flags: g.flags },
      ])
    ),
  };
}
