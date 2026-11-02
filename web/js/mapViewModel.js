// ViewModel peta: menyimpan state UI (layer, filter, seleksi) dan menurunkan
// daftar fitur yang terlihat. View (renderer & UI) hanya membaca dari sini dan
// memanggil method di sini; tidak ada view yang menyimpan state filter sendiri.

import { LAND_STATUSES, INSTITUTION_LABELS } from './config.js';

export const NO_INSTITUTION = '__none__';

export function institutionLabel(code) {
  if (!code || code === NO_INSTITUTION) return 'Tanpa kampus terkait';
  return INSTITUTION_LABELS[code] ?? code;
}

export class MapViewModel {
  constructor() {
    this.data = {
      universities: { ok: false, items: [] },
      buffers: { ok: false, items: [] },
      candidates: { ok: false, items: [] },
      scenarios: { ok: false, items: [] },
      listings: { ok: false, items: [] },
      areaSummary: { ok: false, summaries: [], metadata: null },
      osmBuildings: { ok: false, items: [] },
      osmCafes: { ok: false, items: [] },
    };
    // Pengaturan visibilitas lapisan bawaan:
    // - Baseline buffer 500m & kandidat observasi Street View aktif secara default (fokus utama analisis).
    // - Skenario buffer 1km & skenario sintetis acak nonaktif secara default (fitur eksplorasi opt-in).
    this.layers = {
      basemap: true,
      buffers: true, // Buffer 500 m (baseline): default ON
      buffer1km: false, // Skenario buffer 1 km: default OFF (analisis opsi perluasan)
      campuses: true,
      candidates: true, // Kandidat observasi Street View: default ON (Task 2)
      scenarios: false, // Skenario sintetis acak: default OFF (opt-in ketat)
      listings: true,
      osmBuildings: true,
      osmCafes: true,
    };
    this.institutions = new Map(); // code → { code, label, enabled, campusCount, candidateCount }
    this.statusEnabled = new Map(LAND_STATUSES.map((s) => [s.key, true]));
    this.selection = null; // { kind: 'land' | 'campus' | 'listing' | 'osm_building' | 'osm_cafe', id }
    this.hover = null; // { kind, id }
    this.loading = true;
    this.listeners = new Set();
    this.derived = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason) {
    this.derived = null;
    for (const fn of this.listeners) fn(reason, this);
  }

  setData(data) {
    this.data = data;
    this.loading = false;
    this.institutions.clear();
    const ensure = (code) => {
      const key = code || NO_INSTITUTION;
      if (!this.institutions.has(key)) {
        this.institutions.set(key, {
          code: key,
          label: institutionLabel(key),
          enabled: true,
          campusCount: 0,
          candidateCount: 0,
        });
      }
      return this.institutions.get(key);
    };
    for (const u of data.universities.items) ensure(u.institution).campusCount++;
    for (const b of data.buffers.items) ensure(b.institution);
    for (const c of data.candidates.items) ensure(c.institution).candidateCount++;
    for (const c of data.scenarios?.items || []) ensure(c.institution).candidateCount++;
    if (data.listings?.items) {
      for (const l of data.listings.items) ensure(l.institution);
    }
    if (data.osmBuildings?.items) {
      for (const ob of data.osmBuildings.items) if (ob.institution) ensure(ob.institution);
    }
    this.emit('data');
  }

  setLayer(name, on) {
    if (!(name in this.layers) || this.layers[name] === on) return;
    this.layers[name] = on;
    if (!on && (name === 'candidates' || name === 'scenarios') && this.selection?.kind === 'land') {
      const derived = this.computeDerived();
      const stillVisible = derived.candidates.some((x) => x.id === this.selection.id) ||
                           derived.scenarios.some((x) => x.id === this.selection.id);
      if (!stillVisible) this.selection = null;
    }
    if (!on && name === 'campuses' && this.selection?.kind === 'campus') this.selection = null;
    if (!on && name === 'listings' && this.selection?.kind === 'listing') this.selection = null;
    if (!on && name === 'osmBuildings' && this.selection?.kind === 'osm_building') this.selection = null;
    if (!on && name === 'osmCafes' && this.selection?.kind === 'osm_cafe') this.selection = null;
    this.emit('layers');
  }

  setInstitution(code, on) {
    const inst = this.institutions.get(code);
    if (!inst || inst.enabled === on) return;
    inst.enabled = on;
    this.dropHiddenSelection();
    this.emit('filters');
  }

  setStatus(key, on) {
    if (!this.statusEnabled.has(key) || this.statusEnabled.get(key) === on) return;
    this.statusEnabled.set(key, on);
    this.dropHiddenSelection();
    this.emit('filters');
  }

  resetFilters() {
    for (const inst of this.institutions.values()) inst.enabled = true;
    for (const key of this.statusEnabled.keys()) this.statusEnabled.set(key, true);
    this.layers.candidates = true;
    this.emit('filters');
  }

  institutionEnabled(code) {
    return this.institutions.get(code || NO_INSTITUTION)?.enabled ?? true;
  }

  select(selection) {
    this.selection = selection;
    this.emit('selection');
  }

  setHover(hover) {
    const same = hover?.kind === this.hover?.kind && hover?.id === this.hover?.id;
    if (same) return;
    this.hover = hover;
    this.emit('hover');
  }

  dropHiddenSelection() {
    const sel = this.selection;
    if (!sel) return;
    const visible = this.computeDerived();
    const list =
      sel.kind === 'land'
        ? [...visible.candidates, ...(visible.scenarios || [])]
        : sel.kind === 'campus'
          ? visible.campuses
          : sel.kind === 'listing'
            ? visible.listings
            : sel.kind === 'osm_building'
              ? visible.osmBuildings
              : sel.kind === 'osm_cafe'
                ? visible.osmCafes
                : [];
    if (!list.some((x) => x.id === sel.id)) this.selection = null;
  }

  computeDerived() {
    const { universities, buffers, candidates, listings, osmBuildings, osmCafes } = this.data;
    return {
      campuses: this.layers.campuses
        ? universities.items.filter((u) => this.institutionEnabled(u.institution))
        : [],
      // Baseline buffer 500 m: dipetakan menggunakan geometri rings500 jika aktif
      buffers: this.layers.buffers
        ? buffers.items.filter((b) => this.institutionEnabled(b.institution)).map((b) => ({
            ...b,
            radiusM: 500,
            rings: b.rings500 || b.rings,
            bounds: b.bounds500 || b.bounds,
          }))
        : [],
      // Skenario buffer 1 km: dipetakan menggunakan geometri rings1km (geometri penuh 1000m)
      buffers1km: this.layers.buffer1km
        ? buffers.items.filter((b) => this.institutionEnabled(b.institution)).map((b) => ({
            ...b,
            radiusM: 1000,
            rings: b.rings1km || b.rings,
            bounds: b.bounds1km || b.bounds,
          }))
        : [],
      candidates: this.layers.candidates
        ? candidates.items.filter(
            (c) => this.institutionEnabled(c.institution) && this.statusEnabled.get(c.status.key)
          )
        : [],
      scenarios: this.layers.scenarios
        ? (this.data.scenarios?.items || []).filter((c) => this.institutionEnabled(c.institution) && this.statusEnabled.get(c.status.key))
        : [],
      listings:
        this.layers.listings && listings?.items
          ? listings.items.filter((l) => this.institutionEnabled(l.institution))
          : [],
      osmBuildings:
        this.layers.osmBuildings && osmBuildings?.items
          ? osmBuildings.items.filter((b) => !b.institution || this.institutionEnabled(b.institution))
          : [],
      osmCafes:
        this.layers.osmCafes && osmCafes?.items
          ? osmCafes.items
          : [],
    };
  }

  /** Fitur yang lolos layer + filter. Di-cache sampai ada perubahan state. */
  get visible() {
    if (!this.derived) this.derived = this.computeDerived();
    return this.derived;
  }

  findCandidate(id) {
    return (
      this.data.candidates.items.find((c) => c.id === id) ??
      this.data.scenarios?.items?.find((c) => c.id === id) ??
      null
    );
  }

  findCampus(id) {
    return this.data.universities.items.find((u) => u.id === id) ?? null;
  }

  findListing(id) {
    return this.data.listings?.items?.find((l) => l.id === id) ?? null;
  }

  findOsmCafe(id) {
    return this.data.osmCafes?.items?.find((c) => c.id === id) ?? null;
  }

  findOsmBuilding(id) {
    return this.data.osmBuildings?.items?.find((b) => b.id === id) ?? null;
  }

  findAreaSummary(areaCluster) {
    if (!areaCluster || !this.data.areaSummary?.summaries) return null;
    const norm = String(areaCluster).toLowerCase().trim();
    return (
      this.data.areaSummary.summaries.find(
        (s) => s.area_cluster && s.area_cluster.toLowerCase().trim() === norm
      ) ?? null
    );
  }

  statusCounts() {
    const counts = new Map(LAND_STATUSES.map((s) => [s.key, 0]));
    for (const c of this.data.candidates.items) counts.set(c.status.key, counts.get(c.status.key) + 1);
    return counts;
  }
}
