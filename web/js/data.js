// Memuat dan memvalidasi GeoJSON hasil pipeline GIS.
// Modul ini tidak membuat data sendiri: kalau file hilang/rusak, layer itu
// dikosongkan dan pesan errornya diteruskan ke UI.

import { DATA_FILES, LAND_STATUSES, DEFAULT_STATUS_KEY } from './config.js';
import { lonLatToWorld } from './viewport.js';

export class DataLoadError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'DataLoadError';
    this.kind = kind;
  }
}

const STATUS_BY_VALUE = new Map(LAND_STATUSES.map((s) => [s.value, s]));
const STATUS_BY_KEY = new Map(LAND_STATUSES.map((s) => [s.key, s]));

export function statusByKey(key) {
  return STATUS_BY_KEY.get(key) ?? STATUS_BY_KEY.get(DEFAULT_STATUS_KEY);
}

async function fetchJson(url) {
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    throw new DataLoadError(
      'file-protocol',
      'Halaman dibuka langsung dari file. Jalankan server lokal dari root repo (python3 -m http.server 8000) lalu buka http://localhost:8000/web/.'
    );
  }
  let response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch {
    throw new DataLoadError('network', 'File tidak bisa diambil. Pastikan server lokal berjalan dari root repo.');
  }
  if (!response.ok) {
    throw new DataLoadError(
      'http',
      response.status === 404 ? 'File belum tersedia (404).' : `Server membalas HTTP ${response.status}.`
    );
  }
  const text = await response.text();
  if (!text.trim()) throw new DataLoadError('empty', 'File kosong.');
  try {
    return JSON.parse(text);
  } catch {
    throw new DataLoadError('parse', 'Isi file bukan JSON yang valid.');
  }
}

function requireFeatureCollection(json) {
  if (!json || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
    throw new DataLoadError('schema', 'Format bukan GeoJSON FeatureCollection.');
  }
  return json;
}

function isLonLat(pair) {
  return (
    Array.isArray(pair) &&
    pair.length >= 2 &&
    Number.isFinite(pair[0]) &&
    Number.isFinite(pair[1]) &&
    Math.abs(pair[0]) <= 180 &&
    Math.abs(pair[1]) <= 90
  );
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function emptyBounds() {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

function extendBounds(b, x, y) {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}

export function boundsValid(b) {
  return b && Number.isFinite(b[0]) && Number.isFinite(b[2]);
}

export function mergeBounds(...list) {
  const out = emptyBounds();
  for (const b of list) {
    if (!boundsValid(b)) continue;
    extendBounds(out, b[0], b[1]);
    extendBounds(out, b[2], b[3]);
  }
  return out;
}

function pointCoords(feature) {
  const g = feature?.geometry;
  if (!g || g.type !== 'Point' || !isLonLat(g.coordinates)) return null;
  return g.coordinates;
}

function parseUniversities(json) {
  const items = [];
  let skipped = 0;
  for (const feature of json.features) {
    const c = pointCoords(feature);
    const p = feature?.properties ?? {};
    const id = str(p.id);
    if (!c || !id) {
      skipped++;
      continue;
    }
    const w = lonLatToWorld(c[0], c[1]);
    items.push({
      id,
      institution: str(p.institution) || null,
      universityName: str(p.university_name),
      campusName: str(p.campus_name) || id,
      source: str(p.source),
      verifiedAt: str(p.verified_at),
      lon: c[0],
      lat: c[1],
      wx: w.x,
      wy: w.y,
    });
  }
  return { items, skipped, metadata: json.metadata ?? null };
}

function projectRing(ring, bounds) {
  if (!Array.isArray(ring)) return null;
  const out = [];
  for (const pair of ring) {
    if (!isLonLat(pair)) return null;
    const w = lonLatToWorld(pair[0], pair[1]);
    out.push(w.x, w.y);
    extendBounds(bounds, w.x, w.y);
  }
  return out.length >= 6 ? Float64Array.from(out) : null;
}

function parseBuffers(json) {
  const items = [];
  let skipped = 0;
  for (const feature of json.features) {
    const g = feature?.geometry;
    const p = feature?.properties ?? {};
    const polygons =
      g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null;
    if (!Array.isArray(polygons)) {
      skipped++;
      continue;
    }
    const bounds = emptyBounds();
    const rings = [];
    let bad = false;
    for (const polygon of polygons) {
      if (!Array.isArray(polygon)) {
        bad = true;
        break;
      }
      for (const ring of polygon) {
        const projected = projectRing(ring, bounds);
        if (!projected) {
          bad = true;
          break;
        }
        rings.push(projected);
      }
      if (bad) break;
    }
    if (bad || rings.length === 0) {
      skipped++;
      continue;
    }
    items.push({
      universityId: str(p.university_id) || null,
      institution: str(p.institution) || null,
      campusName: str(p.campus_name),
      radiusM: num(p.radius_m),
      rings,
      bounds,
    });
  }
  return { items, skipped, metadata: json.metadata ?? null };
}

export function classifyDataKind(raw) {
  const v = str(raw).toLowerCase();
  if (!v) return 'unknown';
  if (/(demo|synthetic|simulasi|dummy|sample)/.test(v)) return 'demo';
  if (/(verified|terverifikasi|survey|survei|field)/.test(v)) return 'verified';
  return 'unknown';
}

function parseCandidates(json) {
  const items = [];
  let skipped = 0;
  let unknownStatus = 0;
  for (const feature of json.features) {
    const c = pointCoords(feature);
    const p = feature?.properties ?? {};
    const id = str(p.id);
    if (!c || !id) {
      skipped++;
      continue;
    }
    let status = STATUS_BY_VALUE.get(str(p.status));
    if (!status) {
      unknownStatus++;
      status = statusByKey(DEFAULT_STATUS_KEY);
    }
    const w = lonLatToWorld(c[0], c[1]);
    items.push({
      id,
      // Salinan properti asli — inilah isi landData yang dikirim ke planner.
      properties: { ...p },
      lon: c[0],
      lat: c[1],
      wx: w.x,
      wy: w.y,
      name: str(p.name) || id,
      address: str(p.address),
      status,
      distanceM: num(p.distance_meters),
      nearestUniversityId: str(p.nearest_university_id) || null,
      nearestUniversityName: str(p.nearest_university_name),
      isInBuffer: typeof p.is_in_buffer === 'boolean' ? p.is_in_buffer : null,
      isEligible: typeof p.is_eligible === 'boolean' ? p.is_eligible : null,
      dataKind: classifyDataKind(p.data_kind),
      areaSqm: num(p.area_sqm),
      rentalPriceYr: num(p.rental_price_yr),
      institution: null, // diisi lewat join di linkInstitutions()
    });
  }
  return { items, skipped, unknownStatus, metadata: json.metadata ?? null };
}

export const PARSERS = {
  universities: parseUniversities,
  buffers: parseBuffers,
  candidates: parseCandidates,
};

/**
 * Muat ketiga file secara paralel. Tidak pernah melempar error: tiap layer
 * mengembalikan { ok, items, error, skipped }.
 */
export async function loadAllData(files = DATA_FILES) {
  const keys = Object.keys(PARSERS);
  const settled = await Promise.allSettled(
    keys.map(async (key) => PARSERS[key](requireFeatureCollection(await fetchJson(files[key]))))
  );
  const result = {};
  keys.forEach((key, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      result[key] = { ok: true, error: null, ...s.value };
    } else {
      const err = s.reason;
      result[key] = {
        ok: false,
        items: [],
        skipped: 0,
        metadata: null,
        error: err instanceof DataLoadError ? err.message : 'Gagal memproses file.',
        path: files[key],
      };
      if (!(err instanceof DataLoadError)) console.error(`[peta] ${key}:`, err);
    }
  });
  linkInstitutions(result);
  return result;
}

/** Hubungkan kandidat ke institusi lewat nearest_university_id (join, bukan tebakan). */
export function linkInstitutions(result) {
  const byId = new Map();
  const register = (id, inst) => {
    if (!id || !inst) return;
    byId.set(id, inst);
    byId.set(id.toLowerCase(), inst);
    byId.set(id.toUpperCase(), inst);
  };
  for (const b of result.buffers.items) if (b.universityId && b.institution) register(b.universityId, b.institution);
  for (const u of result.universities.items) if (u.institution) register(u.id, u.institution);
  for (const b of result.buffers.items) {
    if (!b.institution && b.universityId) {
      b.institution = byId.get(b.universityId) ?? byId.get(b.universityId.toLowerCase()) ?? null;
    }
  }
  for (const c of result.candidates.items) {
    c.institution =
      (c.nearestUniversityId && (byId.get(c.nearestUniversityId) || byId.get(c.nearestUniversityId.toLowerCase()))) ||
      (c.properties?.institution ? str(c.properties.institution) : null);
  }
}

/** Objek yang dikirim ke modul perencanaan kafe: properti GeoJSON + koordinat [lon, lat] + institusi. */
export function buildLandData(c) {
  return {
    ...c.properties,
    institution: c.institution || c.properties?.institution || null,
    coordinates: [c.lon, c.lat],
  };
}

/**
 * Notifikasi modul perencana eksternal.
 * Menjalankan kontrak window.handleLandMarkerClick(landData) dengan fallback ke window.handleLandClick(landData).
 * Menjamin isolasi: peta tidak pernah crash bila handler belum dimuat, melempar error, atau reject promise.
 * @returns {'called' | 'missing' | 'error'}
 */
export function notifyPlanner(c, win = typeof window !== 'undefined' ? window : globalThis) {
  const handler =
    typeof win?.handleLandMarkerClick === 'function'
      ? win.handleLandMarkerClick
      : typeof win?.handleLandClick === 'function'
        ? win.handleLandClick
        : null;
  if (!handler) return 'missing';
  try {
    const result = handler(buildLandData(c));
    if (result && typeof result.then === 'function') {
      result.then(undefined, (err) => console.error('[peta] handleLandMarkerClick (async):', err));
    }
    return 'called';
  } catch (err) {
    console.error('[peta] handleLandMarkerClick:', err);
    return 'error';
  }
}
