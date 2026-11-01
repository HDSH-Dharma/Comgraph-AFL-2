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

function parseUniversities(json) {
  const items = [];
  let skipped = 0;
  for (const feature of json.features) {
    const g = feature?.geometry;
    const p = feature?.properties ?? {};
    const id = str(p.id);
    if (!g || !id) {
      skipped++;
      continue;
    }

    let c = pointCoords(feature);
    let rings = null;
    let bounds = null;

    let polyGeom = (g.type === 'Polygon' || g.type === 'MultiPolygon')
      ? g
      : (p.campus_polygon?.type === 'Polygon' || p.campus_polygon?.type === 'MultiPolygon')
        ? p.campus_polygon
        : null;

    if (polyGeom) {
      const polygons = polyGeom.type === 'Polygon' ? [polyGeom.coordinates] : polyGeom.coordinates;
      bounds = emptyBounds();
      rings = [];
      let bad = false;
      let countVertices = 0;
      let sumLon = 0;
      let sumLat = 0;

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
          for (let i = 0; i < ring.length; i++) {
            const pt = ring[i];
            if (isLonLat(pt)) {
              sumLon += pt[0];
              sumLat += pt[1];
              countVertices++;
            }
          }
        }
        if (bad) break;
      }
      if (!bad && rings.length > 0) {
        if (!c && countVertices > 0) {
          c = [sumLon / countVertices, sumLat / countVertices];
        }
      } else {
        rings = null;
        bounds = null;
      }
    }

    if (!c) {
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
      rings,
      bounds,
    });
  }
  return { items, skipped, metadata: json.metadata ?? null };
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
  if (/(survey|survei|field|lapangan|verified|terverifikasi)/.test(v)) return 'verified';
  if (/(listing|marketplace|properti)/.test(v)) return 'listing';
  if (/osm/.test(v)) return 'osm';
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
    const kind = classifyDataKind(p.data_kind);
    const hasOsmProvenance = Boolean(p.osm_id || p.osm_way_ref || String(p.source || '').includes('OpenStreetMap'));
    const isSurvey = (kind === 'verified' || /(survey|survei)/.test(String(p.data_kind || ''))) &&
      (Boolean(p.survey_method || p.evidence_url || p.observed_at) || String(p.data_kind || '').includes('survei') || String(p.data_kind || '').includes('survey'));
    const isFactual = (p.is_factual === true && hasOsmProvenance) || isSurvey;
    const provenanceLabel = isSurvey
      ? `Survei Lapangan Empiris (${p.survey_method || 'Terverifikasi'})`
      : (hasOsmProvenance && p.is_factual)
        ? 'Faktual OpenStreetMap (ODbL 1.0)'
        : 'Simulasi Akademik (Tanpa Provenans Faktual)';

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
      dataKind: kind,
      isFactual,
      isSurvey,
      surveyMethod: str(p.survey_method) || null,
      evidenceUrl: str(p.evidence_url) || null,
      observedAt: str(p.observed_at) || null,
      surveyedBy: str(p.surveyed_by) || null,
      priceSourceUrl: str(p.price_source_url) || null,
      provenanceLabel,
      areaSqm: num(p.area_sqm),
      rentalPriceYr: num(p.rental_price_yr),
      institution: null, // diisi lewat join di linkInstitutions()
    });
  }
  return { items, skipped, unknownStatus, metadata: json.metadata ?? null };
}

export const GENERIC_CATEGORY_PATTERNS = Object.freeze([
  /\/sewa\/[^/]+\/[^/]+\/ruko\/?$/i,
  /\/sewa\/ruko\/[^/]+\/?$/i,
  /\/sewa\/ruko\/[^/]+\/[^/]+\/?$/i,
  /\/sewa-properti\/[^/]+\/[^/]+\/?$/i,
  /\/sewa\/[^/]+\/[^/]+\/?$/i,
  /\/cari-properti\/?$/i,
]);

/**
 * Validasi ketat apakah URL listing adalah URL kategori/pencarian direktori generik (bukan unit listing spesifik).
 * Listing publik yang sah harus merujuk pada unit properti tunggal yang terverifikasi (memiliki slug / ID unit spesifik).
 */
export function isGenericListingUrl(url) {
  if (typeof url !== 'string' || !url.trim().startsWith('http')) return true;
  const clean = url.trim();
  for (const pat of GENERIC_CATEGORY_PATTERNS) {
    if (pat.test(clean)) return true;
  }
  return false;
}

/**
 * Validasi ketat batas kepercayaan (trust boundary) listing properti:
 * Hanya listing dengan bukti verifikasi publik riil dan URL unit spesifik yang lolos ke state frontend.
 */
export function isValidEvidenceListing(featureOrProps) {
  const p = featureOrProps?.properties ?? featureOrProps ?? {};
  const url = typeof p.source_url === 'string' ? p.source_url.trim() : '';
  if (!url || isGenericListingUrl(url)) return false;
  const isVerified =
    p.is_verified_public === true ||
    p.evidence_source === 'reports/research.md' ||
    Boolean(p.verification_date && p.source_portal);
  if (!isVerified) return false;
  if (!p.title && !p.id && !p.listing_id) return false;
  return true;
}

function parseListings(json) {
  const items = [];
  const validRecords = [];
  let skipped = 0;
  let rejectedGeneric = 0;
  let missingCoords = 0;
  for (const feature of json?.features || []) {
    const p = feature?.properties ?? {};
    const id = str(p.listing_id || p.id);
    if (!id) {
      skipped++;
      continue;
    }
    // Defense-in-depth: Tolak listing yang hanya memakai URL direktori/kategori generik
    // atau tidak memiliki bukti verifikasi publik yang sah
    if (!isValidEvidenceListing(p)) {
      skipped++;
      rejectedGeneric++;
      continue;
    }
    validRecords.push({ id, ...p });
    const c = pointCoords(feature);
    if (!c) {
      // Listing memiliki bukti sah namun tidak memiliki koordinat geokoding independen (anti-invensi).
      // Fitur ini tidak diplot sebagai marker kanvas peta.
      skipped++;
      missingCoords++;
      continue;
    }
    const w = lonLatToWorld(c[0], c[1]);
    items.push({
      id,
      title: str(p.title) || id,
      name: str(p.title) || id,
      address: str(p.address),
      areaCluster: str(p.area_cluster),
      subdistrict: str(p.subdistrict),
      urbanVillage: str(p.urban_village),
      propertyType: str(p.property_type),
      floors: num(p.floors),
      buildingAreaSqm: num(p.building_area_sqm),
      landAreaSqm: num(p.land_area_sqm),
      rentalPriceYr: num(p.rental_price_yr),
      priceSqmYr: num(p.price_sqm_yr),
      sourcePortal: str(p.source_portal),
      sourceUrl: str(p.source_url),
      verificationDate: str(p.verification_date),
      nearestUniversityId: str(p.nearest_university_id) || null,
      nearestUniversityName: str(p.nearest_university_name),
      distanceM: num(p.distance_meters),
      isInBuffer: typeof p.is_in_buffer === 'boolean' ? p.is_in_buffer : null,
      isVerifiedPublic: true,
      dataKind: 'listing',
      properties: { ...p },
      lon: c[0],
      lat: c[1],
      wx: w.x,
      wy: w.y,
      institution: null,
    });
  }
  return {
    items,
    validRecords,
    skipped,
    rejectedGeneric,
    missingCoords,
    totalFeatures: (json.features || []).length,
    metadata: json.metadata ?? null,
  };
}

function parseAreaSummary(json) {
  if (!json || typeof json !== 'object') {
    return { items: [], summaries: [], metadata: null };
  }
  const summaries = Array.isArray(json.area_summaries) ? json.area_summaries : [];
  return { items: summaries, summaries, metadata: json.metadata ?? null };
}

/**
 * Validasi silang ringkasan kawasan terhadap daftar listing terverifikasi yang lolos trust boundary.
 * Bila jumlah listing terverifikasi < 3 (atau 0), status kawasan diturunkan ke INSUFFICIENT_DATA
 * dan seluruh estimasi rentang harga (median, min, max) dikosongkan (null) guna mencegah estimasi palsu.
 */
export function validateAreaSummariesWithListings(summaries, validListings = []) {
  const validIdSet = new Set((validListings || []).map((l) => l.id));
  return (summaries || []).map((s) => {
    const comparables = (s.comparable_listing_ids || []).filter((id) => validIdSet.has(id));
    const requiredMin = s.required_minimum || 3;
    const isSupported = comparables.length >= requiredMin;
    if (!isSupported) {
      return {
        ...s,
        has_sufficient_listings: false,
        status: 'INSUFFICIENT_DATA',
        count: comparables.length,
        min_price_yr: null,
        max_price_yr: null,
        median_price_yr: null,
        mean_price_yr: null,
        min_price_sqm_yr: null,
        max_price_sqm_yr: null,
        median_price_sqm_yr: null,
        isSupported: false,
        note:
          validListings.length === 0
            ? 'Belum ada data listing sewa terverifikasi dari backend.'
            : `Listing terverifikasi (${comparables.length}) belum memenuhi batas minimum ${requiredMin}.`,
      };
    }
    return {
      ...s,
      count: comparables.length,
      isSupported: true,
    };
  });
}

export function parseOsmBuildings(json) {
  if (!json || !Array.isArray(json?.features)) {
    return { items: [], skipped: 0, metadata: null };
  }
  const items = [];
  let skipped = 0;
  for (const feature of json.features) {
    const g = feature?.geometry;
    const p = feature?.properties ?? {};
    const id = str(p.id) || str(p.osm_way_ref) || `OSM-BLD-${items.length + 1}`;
    const polygons =
      g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : null;
    if (!Array.isArray(polygons)) {
      skipped++;
      continue;
    }
    const bounds = emptyBounds();
    const rings = [];
    let bad = false;
    let countVertices = 0;
    let sumLon = 0;
    let sumLat = 0;
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
        for (const pt of ring) {
          if (isLonLat(pt)) {
            sumLon += pt[0];
            sumLat += pt[1];
            countVertices++;
          }
        }
      }
      if (bad) break;
    }
    if (bad || rings.length === 0) {
      skipped++;
      continue;
    }

    let centerLon = null;
    let centerLat = null;
    if (Array.isArray(p.center_coordinate) && isLonLat(p.center_coordinate)) {
      centerLon = p.center_coordinate[0];
      centerLat = p.center_coordinate[1];
    } else if (countVertices > 0) {
      centerLon = sumLon / countVertices;
      centerLat = sumLat / countVertices;
    }

    let wx = null;
    let wy = null;
    if (centerLon != null && centerLat != null) {
      const w = lonLatToWorld(centerLon, centerLat);
      wx = w.x;
      wy = w.y;
    }

    items.push({
      id,
      institution: str(p.institution) || null,
      universityName: str(p.university_name),
      campusName: str(p.campus_name) || str(p.name) || id,
      osmWayRef: str(p.osm_way_ref),
      campusAreaHa: num(p.campus_area_ha),
      source: str(p.source),
      verifiedAt: str(p.verified_at),
      lon: centerLon,
      lat: centerLat,
      wx,
      wy,
      rings,
      bounds,
      isFactual: true,
      dataKind: 'osm_building',
      properties: { ...p },
    });
  }
  return { items, skipped, metadata: json.metadata ?? null };
}

export function parseOsmCafes(json) {
  if (!json || !Array.isArray(json?.features)) {
    return { items: [], skipped: 0, metadata: null };
  }
  const items = [];
  let skipped = 0;
  for (const feature of json.features) {
    const c = pointCoords(feature);
    const p = feature?.properties ?? {};
    const id = str(p.id || p.osm_id || p.cafe_id);
    if (!c || !id) {
      skipped++;
      continue;
    }
    const w = lonLatToWorld(c[0], c[1]);
    items.push({
      id,
      name: str(p.name) || 'Kafe OSM Eksisting',
      amenity: str(p.amenity) || 'cafe',
      cuisine: str(p.cuisine),
      brand: str(p.brand),
      openingHours: str(p.opening_hours),
      operator: str(p.operator),
      source: str(p.source) || 'OpenStreetMap',
      verifiedAt: str(p.verified_at),
      isExistingCafe: true,
      isPlannerAllowed: false,
      isFactual: true,
      dataKind: 'osm_cafe',
      lon: c[0],
      lat: c[1],
      wx: w.x,
      wy: w.y,
      properties: { ...p },
    });
  }
  return { items, skipped, metadata: json.metadata ?? null };
}

export const PARSERS = {
  universities: parseUniversities,
  buffers: parseBuffers,
  candidates: parseCandidates,
  listings: parseListings,
  areaSummary: parseAreaSummary,
  osmBuildings: parseOsmBuildings,
  osmCafes: parseOsmCafes,
};

const OPTIONAL_DATA_KEYS = new Set(['listings', 'areaSummary', 'osmCafes', 'osmBuildings']);

/**
 * Muat file spasial secara paralel. Tidak pernah melempar error: tiap layer
 * mengembalikan { ok, items, error, skipped }.
 */
export async function loadAllData(files = DATA_FILES) {
  const keys = Object.keys(PARSERS);
  const settled = await Promise.allSettled(
    keys.map(async (key) => {
      const url = files[key];
      if (!url) return { items: [], skipped: 0, metadata: null };
      const raw = await fetchJson(url);
      const data = key === 'areaSummary' ? raw : requireFeatureCollection(raw);
      return PARSERS[key](data);
    })
  );
  const result = {};
  keys.forEach((key, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      result[key] = { ok: true, error: null, ...s.value };
    } else {
      const err = s.reason;
      if (OPTIONAL_DATA_KEYS.has(key) && (err?.kind === 'http' || err?.kind === 'network' || !files[key])) {
        result[key] = {
          ok: true,
          items: [],
          skipped: 0,
          metadata: null,
          error: null,
          status: 'UNAVAILABLE_OPTIONAL',
          path: files[key],
        };
      } else {
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
    }
  });
  linkInstitutions(result);
  return result;
}

/** Hubungkan kandidat dan listing ke institusi lewat nearest_university_id (join, bukan tebakan). */
export function linkInstitutions(result) {
  const byId = new Map();
  const register = (id, inst) => {
    if (!id || !inst) return;
    byId.set(id, inst);
    byId.set(id.toLowerCase(), inst);
    byId.set(id.toUpperCase(), inst);
  };
  if (result.buffers?.items) {
    for (const b of result.buffers.items) if (b.universityId && b.institution) register(b.universityId, b.institution);
  }
  if (result.universities?.items) {
    for (const u of result.universities.items) if (u.institution) register(u.id, u.institution);
  }
  if (result.buffers?.items) {
    for (const b of result.buffers.items) {
      if (!b.institution && b.universityId) {
        b.institution = byId.get(b.universityId) ?? byId.get(b.universityId.toLowerCase()) ?? null;
      }
    }
  }
  if (result.candidates?.items) {
    for (const c of result.candidates.items) {
      c.institution =
        (c.nearestUniversityId && (byId.get(c.nearestUniversityId) || byId.get(c.nearestUniversityId.toLowerCase()))) ||
        (c.properties?.institution ? str(c.properties.institution) : null);
    }
  }
  if (result.listings?.items) {
    for (const l of result.listings.items) {
      l.institution =
        (l.nearestUniversityId && (byId.get(l.nearestUniversityId) || byId.get(l.nearestUniversityId.toLowerCase()))) ||
        (l.properties?.institution ? str(l.properties.institution) : null);
    }
  }
  if (result.osmBuildings?.items) {
    for (const b of result.osmBuildings.items) {
      if (!b.institution && b.id) {
        b.institution = byId.get(b.id) ?? byId.get(b.id.toLowerCase()) ?? null;
      }
    }
  }
  if (result.areaSummary?.summaries) {
    const validListings = result.listings?.validRecords || result.listings?.items || [];
    result.areaSummary.summaries = validateAreaSummariesWithListings(result.areaSummary.summaries, validListings);
    result.areaSummary.items = result.areaSummary.summaries;
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
