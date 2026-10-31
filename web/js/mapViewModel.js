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
    };
    this.layers = { basemap: true, buffers: true, campuses: true, candidates: true };
    this.institutions = new Map(); // code → { code, label, enabled, campusCount, candidateCount }
    this.statusEnabled = new Map(LAND_STATUSES.map((s) => [s.key, true]));
    this.selection = null; // { kind: 'land' | 'campus', id }
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
    this.emit('data');
  }

  setLayer(name, on) {
    if (!(name in this.layers) || this.layers[name] === on) return;
    this.layers[name] = on;
    if (!on && name === 'candidates' && this.selection?.kind === 'land') this.selection = null;
    if (!on && name === 'campuses' && this.selection?.kind === 'campus') this.selection = null;
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
    const list = sel.kind === 'land' ? visible.candidates : visible.campuses;
    if (!list.some((x) => x.id === sel.id)) this.selection = null;
  }

  computeDerived() {
    const { universities, buffers, candidates } = this.data;
    return {
      campuses: this.layers.campuses
        ? universities.items.filter((u) => this.institutionEnabled(u.institution))
        : [],
      buffers: this.layers.buffers ? buffers.items.filter((b) => this.institutionEnabled(b.institution)) : [],
      candidates: this.layers.candidates
        ? candidates.items.filter(
            (c) => this.institutionEnabled(c.institution) && this.statusEnabled.get(c.status.key)
          )
        : [],
    };
  }

  /** Fitur yang lolos layer + filter. Di-cache sampai ada perubahan state. */
  get visible() {
    if (!this.derived) this.derived = this.computeDerived();
    return this.derived;
  }

  findCandidate(id) {
    return this.data.candidates.items.find((c) => c.id === id) ?? null;
  }

  findCampus(id) {
    return this.data.universities.items.find((u) => u.id === id) ?? null;
  }

  statusCounts() {
    const counts = new Map(LAND_STATUSES.map((s) => [s.key, 0]));
    for (const c of this.data.candidates.items) counts.set(c.status.key, counts.get(c.status.key) + 1);
    return counts;
  }
}
