// View DOM: kontrol, legenda, daftar kandidat, inspector, tooltip, pesan.
// Semua teks dari data dimasukkan lewat textContent (tidak lewat innerHTML).

import {
  LAND_STATUSES,
  QUICK_JUMP_TARGETS,
  DATA_LABELS,
  MARKER_RADIUS,
  OUT_OF_BUFFER_ALPHA,
  BUFFER_STYLE,
  BUFFER_1KM_STYLE,
  OSM_BUILDING_STYLE,
  OSM_CAFE_STYLE,
  FALLBACK_ELIGIBLE_STATUSES,
} from './config.js';
import { NO_INSTITUTION, institutionLabel } from './mapViewModel.js';
import {
  paintSwatch,
  drawStatusMarker,
  drawCampusMarker,
  drawListingMarker,
  drawOsmCafeMarker,
} from './symbols.js';
import { buildLandData } from './data.js';
import { calculateFeasibilityPoints } from './planner.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}

const numberID = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const decimalID = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });

export function formatMeters(m) {
  if (m == null) return '—';
  const base = `${numberID.format(Math.round(m))} m`;
  return m >= 1000 ? `${base} (${decimalID.format(m / 1000)} km)` : base;
}

const DATA_KIND_TEXT = {
  scenario: 'Skenario sintetis (simulasi hipotetis / penempatan acak), bukan data faktual',
  demo: 'Data demo (simulasi akademik), belum diverifikasi lapangan',
  verified: 'Survei lapangan empiris terverifikasi',
  listing: 'Listing properti eksternal (terverifikasi)',
  osm: 'Konteks OpenStreetMap (ODbL 1.0)',
  unknown: 'Sumber data belum jelas',
};
const DATA_KIND_SHORT = {
  scenario: 'Skenario Sintetis',
  demo: 'Simulasi Demo',
  verified: 'Survei Faktual',
  listing: 'Listing Riil',
  osm: 'OSM Konteks',
  unknown: 'Belum jelas',
};

function statusSwatch(status, size = 28, opts = {}) {
  const c = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
  paintSwatch(c, (ctx, x, y) => drawStatusMarker(ctx, status, x, y, size * 0.3, opts), size);
  return c;
}

export function findMatchingAreaSummary(candidate, areaSummaries) {
  if (!candidate || !Array.isArray(areaSummaries)) return null;
  const text = `${candidate.address || ''} ${candidate.nearestUniversityName || ''} ${candidate.nearestUniversityId || ''}`.toLowerCase();
  for (const s of areaSummaries) {
    if (!s.area_cluster) continue;
    const tokens = s.area_cluster
      .toLowerCase()
      .replace(/[()]/g, ' ')
      .split(/[/,–—]/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 3);
    if (tokens.some((p) => text.includes(p))) {
      return s;
    }
  }
  return null;
}

// Relasi Spasial (Spatial Join): Menemukan kafe OSM terdekat untuk kandidat lahan tertentu.
// Memprioritaskan nearestCafeId dari backend jika tersedia; fallback ke kalkulasi jarak Haversine (lingkaran besar).
export function findNearestOsmCafe(c, cafes) {
  if (!cafes || !cafes.length) return null;
  if (c.nearestCafeId) {
    const matched = cafes.find((cafe) => cafe.id === c.nearestCafeId);
    if (matched) {
      return { cafe: matched, distanceM: c.nearestCafeDistM ?? null };
    }
  }
  if (c.lat == null || c.lon == null) return null;
  let best = null;
  let minDist = Infinity;
  const lat1 = c.lat;
  const lon1 = c.lon;
  for (const cafe of cafes) {
    if (cafe.lat == null || cafe.lon == null) continue;
    const dLat = ((cafe.lat - lat1) * Math.PI) / 180;
    const dLon = ((cafe.lon - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((cafe.lat * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const d = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (d < minDist) {
      minDist = d;
      best = { cafe, distanceM: d };
    }
  }
  return best;
}

export function evaluateCandidateEligibility(c, eligibleStatuses) {
  const inRadius = c.distanceM != null ? c.distanceM <= 1000.0 : c.isInBuffer !== false;
  const isStatusOk = Array.isArray(eligibleStatuses) && eligibleStatuses.includes(c.status?.value);
  const passesDefenseInDepth = inRadius && isStatusOk && c.isInBuffer !== false;
  const isEligible = c.isEligible === true && passesDefenseInDepth;
  const reasons = [];
  if (!inRadius || c.isInBuffer === false) {
    reasons.push(c.distanceM != null ? `Di luar buffer 1 km (${formatMeters(c.distanceM)})` : 'Di luar buffer 1 km');
  }
  if (!isStatusOk) {
    reasons.push(`Status “${c.status?.label || c.status?.value || 'Tidak dikenal'}” tidak dapat dipilih.`);
  }
  return {
    isEligible,
    inRadius,
    isStatusOk,
    passesDefenseInDepth,
    reasons,
  };
}

export class MapUI {
  constructor(vm, actions) {
    this.vm = vm;
    this.actions = actions;
    this.els = {
      notice: $('data-notice'),
      errors: $('data-errors'),
      quickJump: $('quick-jump'),
      institutions: $('filter-institutions'),
      statuses: $('filter-statuses'),
      legend: $('legend-body'),
      list: $('candidate-list'),
      count: $('candidate-count'),
      rankingList: $('ranking-list'),
      rankingCount: $('ranking-count'),
      inspector: $('inspector'),
      inspectorBody: $('inspector-body'),
      inspectorTitle: $('inspector-title'),
      tooltip: $('map-tooltip'),
      message: $('map-message'),
      live: $('live-region'),
      scaleLine: $('scale-line'),
      scaleLabel: $('scale-label'),
      basemapNote: $('basemap-note'),
      attribution: $('attribution-basemap'),
    };
    this.bindStaticControls();
    this.buildLegend();
    this.renderStatusFilters();
    // Di layar kecil legenda dilipat dulu supaya tidak menutupi peta; tombolnya tetap terlihat.
    if (window.matchMedia('(max-width: 899px)').matches) $('legend').open = false;
  }

  // ---------- Kontrol statis (layer, zoom, inspector) ----------

  bindStaticControls() {
    document.querySelectorAll('input[data-layer]').forEach((input) => {
      input.checked = this.vm.layers[input.dataset.layer];
      input.addEventListener('change', () => this.actions.setLayer(input.dataset.layer, input.checked));
    });
    $('zoom-in').addEventListener('click', () => this.actions.zoomBy(1));
    $('zoom-out').addEventListener('click', () => this.actions.zoomBy(-1));
    $('zoom-fit').addEventListener('click', () => this.actions.fitAll());
    $('inspector-close').addEventListener('click', () => this.actions.clearSelection());
    $('reset-filters').addEventListener('click', () => this.actions.resetFilters());
  }

  syncLayerInputs() {
    document.querySelectorAll('input[data-layer]').forEach((input) => {
      input.checked = this.vm.layers[input.dataset.layer];
    });
  }

  // ---------- Legenda ----------

  buildLegend() {
    const list = h('ul', { class: 'legend-list' });
    for (const s of LAND_STATUSES) {
      list.append(
        h(
          'li',
          {},
          statusSwatch(s, 26),
          h('span', {}, h('strong', { text: s.label }), h('span', { class: 'legend-hint', text: ` · ${s.glyph}, ${s.shapeName}` }))
        )
      );
    }
    const sample = LAND_STATUSES[0];
    const outCanvas = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
    paintSwatch(outCanvas, (ctx, x, y) =>
      drawStatusMarker(ctx, sample, x, y, 26 * 0.3, { alpha: OUT_OF_BUFFER_ALPHA, outOfBuffer: true })
    , 26);
    const campusCanvas = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
    paintSwatch(campusCanvas, (ctx, x, y) => drawCampusMarker(ctx, x, y + 9, 7), 26);

    // Legenda Dual-Buffer: visual swatch untuk buffer 500m baseline (garis solid/tegas) vs 1km skenario (garis putus-putus)
    const buffer500Canvas = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
    paintSwatch(buffer500Canvas, (ctx, x, y) => {
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fillStyle = BUFFER_STYLE.fill;
      ctx.fill();
      ctx.setLineDash(BUFFER_STYLE.dash.map((d) => d / 2));
      ctx.strokeStyle = BUFFER_STYLE.stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }, 26);

    // Buffer 1km skenario (opsional / jangkauan luas)
    const buffer1kmCanvas = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
    paintSwatch(buffer1kmCanvas, (ctx, x, y) => {
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fillStyle = BUFFER_1KM_STYLE.fill;
      ctx.fill();
      ctx.setLineDash(BUFFER_1KM_STYLE.dash.map((d) => d / 2));
      ctx.strokeStyle = BUFFER_1KM_STYLE.stroke;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }, 26);

    const osmBuildingCanvas = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
    paintSwatch(osmBuildingCanvas, (ctx, x, y) => {
      ctx.beginPath();
      ctx.rect(x - 9, y - 9, 18, 18);
      ctx.fillStyle = OSM_BUILDING_STYLE.fill;
      ctx.fill();
      ctx.strokeStyle = OSM_BUILDING_STYLE.stroke;
      ctx.lineWidth = OSM_BUILDING_STYLE.lineWidth;
      ctx.stroke();
    }, 26);
    const osmCafeCanvas = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
    paintSwatch(osmCafeCanvas, (ctx, x, y) => drawOsmCafeMarker(ctx, x, y, 7), 26);
    const listingCanvas = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
    paintSwatch(listingCanvas, (ctx, x, y) => drawListingMarker(ctx, x, y, 7), 26);
    this.els.listingLegendText = h('span', { id: 'legend-listing-text', text: 'Listing sewa riil publik (L)' });
    this.els.listingLegendItem = h('li', { id: 'legend-listing-item' }, listingCanvas, this.els.listingLegendText);

    list.append(
      h('li', { class: 'legend-sep' }, outCanvas, h('span', { text: 'Pudar = di luar buffer 500 m (baseline)' })),
      h('li', {}, campusCanvas, h('span', { text: 'Titik kampus (pin)' })),
      h('li', {}, osmBuildingCanvas, h('span', { text: 'Perimeter kampus (OSM faktual)' })),
      h('li', {}, buffer500Canvas, h('span', { text: 'Buffer 500 m (baseline)' })),
      h('li', {}, buffer1kmCanvas, h('span', { text: 'Skenario buffer 1 km (opsional)' })),
      h('li', {}, osmCafeCanvas, h('span', { text: 'Kafe eksisting (OSM faktual; 4 tanpa nama)' })),
      this.els.listingLegendItem,
      h('li', { class: 'legend-units-note' }, h('small', { class: 'muted', text: 'Satuan: jarak (m), luas (m²), sewa (Rp/tahun), kelayakan (poin 0–100)' }))
    );
    this.els.legend.replaceChildren(list);
  }

  updateListingLayerState() {
    const listingInput = document.querySelector('input[data-layer="listings"]');
    const listingLabel = document.getElementById('layer-listings-label') || listingInput?.nextElementSibling;
    const count = this.vm.data.listings?.items?.length || 0;
    if (listingLabel) {
      if (count === 0) {
        listingLabel.textContent = 'Listing sewa riil (belum ada data terverifikasi)';
      } else {
        listingLabel.textContent = `Listing sewa riil publik (${count} unit)`;
      }
    }
    if (listingInput) {
      if (count === 0) {
        listingInput.disabled = true;
        listingInput.checked = false;
        this.vm.layers.listings = false;
        listingInput.title = 'Belum ada data listing sewa riil publik yang terverifikasi dari backend.';
      } else {
        listingInput.disabled = false;
        listingInput.checked = this.vm.layers.listings;
        listingInput.title = 'Tampilkan atau sembunyikan listing sewa riil publik.';
      }
    }

    const cafeInput = document.querySelector('input[data-layer="osmCafes"]');
    const cafeLabel = document.getElementById('layer-osm-cafes-label') || cafeInput?.nextElementSibling;
    const cafeCount = this.vm.data.osmCafes?.items?.length || 0;
    if (cafeLabel) {
      if (cafeCount === 0) {
        cafeLabel.textContent = 'Kafe eksisting (data OSM belum tersedia)';
      } else {
        cafeLabel.textContent = `Kafe eksisting OSM (${cafeCount} kafe; 4 tanpa nama)`;
      }
    }

    const candInput = document.querySelector('input[data-layer="candidates"]');
    const candLabel = document.getElementById('layer-candidates-label') || candInput?.nextElementSibling;
    const candCount = this.vm.data.candidates?.items?.length || 0;
    if (candLabel) {
      if (candCount === 0) {
        candLabel.textContent = 'Kandidat lahan observasi (Street View faktual)';
      } else {
        candLabel.textContent = `Kandidat lahan observasi (${candCount} lokasi Street View)`;
      }
    }

    const scenarioInput = document.querySelector('input[data-layer="scenarios"]');
    const scenarioLabel = document.getElementById('layer-scenarios-label') || scenarioInput?.nextElementSibling;
    const scenarioCount = this.vm.data.scenarios?.items?.length || 0;
    if (scenarioLabel) {
      if (scenarioCount === 0) {
        scenarioLabel.textContent = '🧪 Skenario sintetis (simulasi acak)';
      } else {
        scenarioLabel.textContent = `🧪 Skenario sintetis (${scenarioCount} simulasi acak)`;
      }
    }
    if (this.els.listingLegendItem && this.els.listingLegendText) {
      if (count === 0) {
        this.els.listingLegendText.textContent = 'Listing sewa riil (belum ada data terverifikasi)';
        this.els.listingLegendItem.classList.add('muted');
      } else {
        this.els.listingLegendText.textContent = `Listing sewa riil publik (${count} unit) (L)`;
        this.els.listingLegendItem.classList.remove('muted');
      }
    }
  }

  // ---------- Filter ----------

  renderStatusFilters() {
    const counts = this.vm.statusCounts();
    const loaded = this.vm.data.candidates.ok;
    this.els.statuses.replaceChildren(
      ...LAND_STATUSES.map((s) =>
        h(
          'label',
          { class: 'check-row' },
          h('input', {
            type: 'checkbox',
            checked: this.vm.statusEnabled.get(s.key),
            onchange: (e) => this.actions.setStatus(s.key, e.target.checked),
          }),
          statusSwatch(s, 24),
          h('span', { class: 'check-label', text: s.label }),
          h('span', { class: 'count', text: loaded ? String(counts.get(s.key)) : '–' })
        )
      )
    );
  }

  renderInstitutionFilters() {
    const items = [...this.vm.institutions.values()];
    if (!items.length) {
      this.els.institutions.replaceChildren(h('p', { class: 'muted', text: 'Belum ada data kampus.' }));
      return;
    }
    items.sort((a, b) => (a.code === NO_INSTITUTION) - (b.code === NO_INSTITUTION) || a.label.localeCompare(b.label));
    this.els.institutions.replaceChildren(
      ...items.map((inst) =>
        h(
          'label',
          { class: 'check-row' },
          h('input', {
            type: 'checkbox',
            checked: inst.enabled,
            onchange: (e) => this.actions.setInstitution(inst.code, e.target.checked),
          }),
          h('span', { class: 'check-label', text: inst.label }),
          h('span', {
            class: 'count',
            text: `${inst.campusCount} kampus · ${inst.candidateCount} lahan`,
          })
        )
      )
    );
  }

  syncFilterInputs() {
    this.renderInstitutionFilters();
    this.renderStatusFilters();
    this.syncLayerInputs();
  }

  renderQuickJump() {
    const present = new Set(
      [...this.vm.data.universities.items, ...this.vm.data.buffers.items].map((x) => x.institution).filter(Boolean)
    );
    // Quick-jump khusus untuk 3 kampus sasaran proyek: Unair, UKWMS, Ubaya.
    // Kode tanpa data tetap tampil sebagai chip nonaktif (bukan mengarang koordinat).
    // Institusi lain di data tidak mengontaminasi quick-jump, melainkan dikelola
    // oleh kontrol filter universitas yang memang dinamis.
    const codes = QUICK_JUMP_TARGETS;
    this.els.quickJump.replaceChildren(
      ...codes.map((code) => {
        const available = present.has(code);
        return h(
          'button',
          {
            type: 'button',
            class: 'chip',
            disabled: !available,
            title: available ? `Pusatkan peta ke ${institutionLabel(code)}` : 'Titik kampus ini belum ada di data GIS',
            onclick: () => this.actions.jumpTo(code),
          },
          institutionLabel(code),
          available ? null : h('span', { class: 'chip-note', text: ' (belum ada data)' })
        );
      })
    );
  }

  // ---------- Ringkasan & error data ----------

  renderDataNotice() {
    const cand = this.vm.data.candidates;
    if (!cand.ok) return;
    const total = cand.items.length;
    if (!total) {
      this.els.notice.textContent = 'Belum ada data kandidat lahan dari tim GIS.';
      return;
    }
    const demo = cand.items.filter((c) => c.dataKind === 'demo').length;
    const unverified = cand.items.filter((c) => c.status.key === 'belum').length;
    const parts = [];
    if (demo) parts.push(`${demo} dari ${total} lokasi lahan adalah data demo (simulasi akademik), belum hasil survei lapangan`);
    else parts.push(`${total} lokasi lahan dimuat`);
    if (unverified) parts.push(`${unverified} lokasi statusnya belum terverifikasi`);

    const validListings = this.vm.data.listings?.items?.length || 0;
    if (validListings === 0) {
      parts.push('belum ada listing sewa publik terverifikasi (harga sewa belum tersedia)');
    } else {
      parts.push(`${validListings} listing sewa riil publik terverifikasi`);
    }

    this.els.notice.textContent = `${parts.join('; ')}. Cek label jenis data di tiap lokasi.`;
  }

  renderDataErrors() {
    const { data } = this.vm;
    const failed = Object.entries(data).filter(([, d]) => !d.ok);
    const warnings = [];
    for (const [key, d] of Object.entries(data)) {
      if (d.ok && d.skipped && !d.rejectedGeneric) {
        warnings.push(`${DATA_LABELS[key]}: ${d.skipped} fitur dilewati karena geometri/id tidak valid.`);
      }
      if (d.ok && d.rejectedGeneric) {
        warnings.push(`${DATA_LABELS[key]}: ${d.rejectedGeneric} entri ditolak guard verifikasi karena menggunakan URL direktori/kategori generik.`);
      }
      if (d.ok && d.unknownStatus) {
        warnings.push(`${DATA_LABELS[key]}: ${d.unknownStatus} status tidak dikenal, ditampilkan sebagai “Belum terverifikasi”.`);
      }
    }
    if (!failed.length && !warnings.length) {
      this.els.errors.hidden = true;
      this.els.errors.replaceChildren();
      return;
    }
    const children = [];
    if (failed.length) {
      children.push(
        h('p', { class: 'alert-title', text: `${failed.length} file data gagal dimuat. Peta tetap jalan dengan data yang ada.` }),
        h(
          'ul',
          {},
          failed.map(([key, d]) =>
            h('li', {}, h('strong', { text: `${DATA_LABELS[key]}: ` }), d.error, ' ', h('code', { text: d.path }))
          )
        )
      );
    }
    if (warnings.length) children.push(h('ul', { class: 'alert-warnings' }, warnings.map((w) => h('li', { text: w }))));
    this.els.errors.className = failed.length ? 'alert alert-error' : 'alert alert-warn';
    this.els.errors.replaceChildren(...children);
    this.els.errors.hidden = false;
  }

  // ---------- Pesan di atas peta ----------

  showMessage(text, { busy = false, action = null } = {}) {
    const el = this.els.message;
    const children = [];
    if (busy) children.push(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    children.push(h('span', { text }));
    if (action) children.push(h('button', { type: 'button', class: 'link-button', onclick: action.onClick, text: action.label }));
    el.replaceChildren(...children);
    el.hidden = false;
    el.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  hideMessage() {
    this.els.message.hidden = true;
    this.els.message.replaceChildren();
  }

  updateMapMessage() {
    const { vm } = this;
    if (vm.loading) return;
    const cand = vm.data.candidates;
    if (!vm.layers.candidates) return this.hideMessage();
    if (!cand.ok) return this.showMessage('Data kandidat lahan gagal dimuat — lihat detail di panel kontrol.');
    if (!cand.items.length) return this.showMessage('Belum ada data kandidat lahan dari tim GIS.');
    if (!vm.visible.candidates.length) {
      return this.showMessage('Tidak ada kandidat yang cocok dengan filter.', {
        action: { label: 'Reset filter', onClick: () => this.actions.resetFilters() },
      });
    }
    this.hideMessage();
  }

  announce(text) {
    this.els.live.textContent = '';
    // Jeda singkat supaya pembaca layar membaca ulang teks yang sama.
    setTimeout(() => (this.els.live.textContent = text), 30);
  }

  // ---------- Daftar kandidat ----------

  renderCandidateList() {
    const { vm } = this;
    const cand = vm.data.candidates;
    const visible = [...vm.visible.candidates].sort(
      (a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity)
    );
    const factualCount = (cand.items || []).filter((c) => c.isFactual).length;
    const scenarioCount = (cand.items || []).filter((c) => c.isScenario || c.dataKind === 'scenario').length;
    const demoCount = (cand.items || []).filter((c) => !c.isFactual && !c.isScenario && c.dataKind !== 'scenario').length;

    if (!cand.ok) {
      this.els.count.textContent = '';
      this.els.list.replaceChildren(h('li', { class: 'muted', text: 'Data kandidat belum tersedia.' }));
      return;
    }

    // Penanganan Cabang Lapisan Kandidat Nonaktif (Hidden Candidates Branch):
    // Melaporkan jumlah factualCount aktual (menghindari hardcoded 0) dan menyajikan notice tersembunyi yang jujur
    // tanpa memunculkan pesan stale no-survey saat data observasi Street View sebenarnya sudah ada.
    if (!vm.layers.candidates) {
      const parts = [`${factualCount} survei faktual`];
      if (scenarioCount > 0) parts.push(`${scenarioCount} skenario`);
      if (demoCount > 0) parts.push(`${demoCount} demo`);
      this.els.count.textContent = `(${parts.join(' · ')} nonaktif)`;

      const extraText = (demoCount + scenarioCount > 0) ? ` · ${demoCount + scenarioCount} simulasi skenario/demo` : '';
      this.els.list.replaceChildren(
        h(
          'li',
          { class: 'muted candidate-hidden-notice' },
          h('strong', { text: '👁️ Lapisan Kandidat Lahan Dinonaktifkan: ' }),
          `Lapisan kandidat lahan sedang disembunyikan (${factualCount} lokasi observasi Street View faktual${extraText} dinonaktifkan). Centang opsi "Kandidat lahan observasi (Street View faktual)" pada kontrol lapisan untuk menampilkan seluruh titik kandidat di peta.`
        )
      );
      return;
    }

    const scenarioText = scenarioCount > 0 ? `${scenarioCount} skenario · ` : '';
    this.els.count.textContent = factualCount > 0
      ? `${visible.length} terlihat (${factualCount} faktual · ${scenarioText}${demoCount} demo)`
      : `${visible.length} terlihat (${scenarioText}${demoCount} simulasi demo · 0 faktual)`;

    if (!visible.length) {
      this.els.list.replaceChildren(
        h('li', { class: 'muted', text: cand.items.length ? 'Tidak ada kandidat yang cocok dengan filter.' : 'Belum ada data kandidat lahan.' })
      );
      return;
    }

    const selectedId = vm.selection?.kind === 'land' ? vm.selection.id : null;
    const items = [];

    // Jika seluruh kandidat yang aktif adalah data demo / skenario (0 faktual), sematkan callout peringatan di atas daftar
    if (factualCount === 0) {
      items.push(
        h(
          'li',
          { class: 'callout callout-warn candidate-demo-list-banner', role: 'note' },
          h('strong', { text: '⚠️ Simulasi Akademik Demo & Skenario: ' }),
          `Menampilkan ${visible.length} titik simulasi (0 data survei faktual). Angka sewa & luas adalah parameter skenario/asumsi, bukan harga pasar nyata.`
        )
      );
    }

    items.push(
      ...visible.map((c) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'candidate-item',
              'aria-pressed': String(c.id === selectedId),
              dataset: { id: c.id },
              onclick: () => this.actions.selectCandidate(c.id, { source: 'list' }),
            },
            statusSwatch(c.status, 26, {
              alpha: c.isInBuffer === false ? OUT_OF_BUFFER_ALPHA : 1,
              outOfBuffer: c.isInBuffer === false,
              isScenario: Boolean(c.isScenario || c.simulated || c.dataKind === 'scenario'),
            }),
            h(
              'span',
              { class: 'candidate-text' },
              h(
                'span',
                { class: 'candidate-name' },
                c.name,
                c.isScenario ? h('span', { class: 'tag-scenario', text: c.isRandomPlacement ? '🎲 Acak' : '🧪 Skenario' }) : null
              ),
              h('span', {
                class: 'candidate-meta',
                text: [
                  c.status.key === 'rumah' || c.status.key === 'fungsi_lain'
                    ? 'Tidak Disewakan atau Dijual'
                    : c.status.label,
                  c.distanceM != null ? formatMeters(c.distanceM).split(' (')[0] : null,
                  c.isInBuffer === false ? 'di luar buffer' : null,
                  c.isScenario
                    ? (c.isRandomPlacement ? 'Skenario (Penempatan Acak)' : 'Skenario Sintetis')
                    : (!c.isFactual ? 'Estimasi Demo' : 'Survei Faktual'),
                  c.rentalPriceYr
                    ? (c.isScenario
                        ? `${rupiah.format(c.rentalPriceYr)} (harga skenario)`
                        : (!c.isFactual ? `${rupiah.format(c.rentalPriceYr)} (est. demo)` : rupiah.format(c.rentalPriceYr)))
                    : 'Sewa: n/a',
                ]
                  .filter(Boolean)
                  .join(' · '),
              })
            )
          )
        )
      )
    );

    this.els.list.replaceChildren(...items);
  }

  // ---------- Panel Peringkat Kelayakan Lahan (Web Task 7) ----------
  // Mengurutkan kandidat berdasarkan skor kelayakan bisnis (0-100 poin) dengan tie-breaker proksimitas
  renderRankingPanel() {
    if (!this.els.rankingList) return;
    const cand = this.vm.data.candidates;
    if (!cand.ok || !this.vm.layers.candidates) {
      if (this.els.rankingCount) this.els.rankingCount.textContent = '';
      this.els.rankingList.replaceChildren(
        h('li', { class: 'muted', text: 'Kandidat lahan tidak aktif atau belum dimuat.' })
      );
      return;
    }

    const visible = [...this.vm.visible.candidates];
    if (!visible.length) {
      if (this.els.rankingCount) this.els.rankingCount.textContent = '(0)';
      this.els.rankingList.replaceChildren(
        h('li', { class: 'muted', text: 'Tidak ada kandidat yang cocok dengan filter.' })
      );
      return;
    }

    // Hitung skor kelayakan bisnis untuk tiap kandidat yang terlihat (proksimitas, luas, efisiensi sewa)
    const scored = visible.map((c) => {
      const score = calculateFeasibilityPoints({
        distance_meters: c.distanceM,
        area_sqm: c.areaSqm,
        rental_price_yr: c.rentalPriceYr,
      });
      // Guard kelayakan: hanya kandidat di dalam baseline 500 m dengan status valid yang eligible
      const in500 = c.isInBuffer500 ?? (c.distanceM != null ? c.distanceM <= 500.0 : true);
      const isEligible = Boolean(c.isEligible && in500);
      return {
        candidate: c,
        score,
        isEligible,
      };
    });

    // Peringkat: Utamakan status eligible, lalu skor tertinggi, lalu jarak fisik terdekat sebagai pemecah seri
    scored.sort((a, b) => {
      if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
      if (b.score.points !== a.score.points) return b.score.points - a.score.points;
      return (a.candidate.distanceM ?? Infinity) - (b.candidate.distanceM ?? Infinity);
    });

    if (this.els.rankingCount) {
      this.els.rankingCount.textContent = `(${scored.length})`;
    }

    const selectedId = this.vm.selection?.kind === 'land' ? this.vm.selection.id : null;
    const items = scored.map((item, idx) => {
      const c = item.candidate;
      const { points, grade, breakdown } = item.score;
      const badgeClass = points >= 70 ? 'score-high' : points >= 40 ? 'score-mid' : 'score-low';
      const isSelected = c.id === selectedId;

      return h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'ranking-item',
            'aria-pressed': String(isSelected),
            dataset: { id: c.id },
            title: `Peringkat #${idx + 1}: ${c.name} (${points} poin - ${grade}). Klik untuk memilih di peta.`,
            onclick: () => this.actions.selectCandidate(c.id, { source: 'ranking' }),
          },
          h('span', { class: 'ranking-pos', text: `#${idx + 1}` }),
          statusSwatch(c.status, 22, {
            alpha: c.isInBuffer === false ? OUT_OF_BUFFER_ALPHA : 1,
            outOfBuffer: c.isInBuffer === false,
            isScenario: Boolean(c.isScenario || c.simulated || c.dataKind === 'scenario'),
          }),
          h(
            'div',
            { class: 'ranking-info' },
            h('span', { class: 'ranking-name', text: c.name }),
            h('span', {
              class: 'ranking-meta',
              text: `${c.status.key === 'rumah' || c.status.key === 'fungsi_lain' ? 'Tidak Disewakan/Dijual' : c.status.label} · ${formatMeters(c.distanceM).split(' (')[0]}${c.isInBuffer500 === false ? ' (di luar buffer 500m)' : ''}`,
            })
          ),
          h(
            'span',
            {
              class: `ranking-score-badge ${badgeClass}`,
              title: `Kedekatan: ${breakdown.proximity} poin, Ruang: ${breakdown.space} poin, Biaya: ${breakdown.cost_efficiency} poin`,
            },
            `${points} poin`
          )
        )
      );
    });

    this.els.rankingList.replaceChildren(...items);
  }

  syncRankingSelection() {
    if (!this.els.rankingList) return;
    const id = this.vm.selection?.kind === 'land' ? this.vm.selection.id : null;
    this.els.rankingList.querySelectorAll('button[data-id]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.id === id));
    });
  }

  // ---------- Inspector ----------

  eligibilityBlock(c, eligibleStatuses = FALLBACK_ELIGIBLE_STATUSES) {
    const evaluation = evaluateCandidateEligibility(c, eligibleStatuses);
    if (evaluation.isEligible) {
      return h(
        'div',
        { class: 'callout callout-ok', role: 'status' },
        h('strong', { text: '✓ Memenuhi syarat (menurut data GIS). ' }),
        'Berada di dalam buffer 1 km dan status lahannya bisa dipilih.'
      );
    }
    if (c.isEligible === false || !evaluation.passesDefenseInDepth) {
      const reasons = [];
      if (!evaluation.inRadius || c.isInBuffer === false) {
        reasons.push(`Di luar buffer 1 km: ${formatMeters(c.distanceM)} dari ${c.nearestUniversityName || 'kampus terdekat'}.`);
      }
      if (!evaluation.isStatusOk) {
        if (c.status?.key === 'rumah' || c.status?.key === 'fungsi_lain') {
          reasons.push(`Status “${c.status?.value}” ditandai “Tidak Disewakan atau Dijual” (bukan lahan komersial/kosong).`);
        } else {
          reasons.push(`Status “${c.status?.label || c.status?.value}” tidak dapat dipilih.`);
        }
      }
      if (!reasons.length) reasons.push('Tidak memenuhi syarat menurut data GIS.');
      return h(
        'div',
        { class: 'callout callout-warn', role: 'status' },
        h('strong', { text: '✕ Tidak memenuhi syarat untuk perencanaan kafe.' }),
        h('ul', {}, reasons.map((r) => h('li', { text: r })))
      );
    }
    return h('div', { class: 'callout', role: 'status', text: 'Kelayakan belum dihitung oleh pipeline GIS.' });
  }

  showLandInspector(c, { handlerStatus, eligibleStatuses = FALLBACK_ELIGIBLE_STATUSES, areaSummary } = {}) {
    const evaluation = evaluateCandidateEligibility(c, eligibleStatuses);
    const isNonActionable = c.status?.key === 'rumah' || c.status?.key === 'fungsi_lain' || c.status?.isPlannerAllowed === false;
    const isScenario = Boolean(
      c.isScenario ||
      c.dataKind === 'scenario' ||
      c.properties?.data_kind === 'synthetic_scenario' ||
      c.properties?.simulated === true ||
      /(scenario|skenario)/.test(String(c.properties?.data_kind || ''))
    );
    const isRandomPlacement = Boolean(
      c.isRandomPlacement ||
      c.properties?.random_placement === true ||
      c.properties?.is_random_placement === true ||
      c.properties?.placement === 'random' ||
      c.properties?.is_random === true
    );
    const isDemo = isScenario || c.dataKind === 'demo' || !c.isFactual;
    const statusDisplay = isNonActionable
      ? `Tidak Disewakan atau Dijual (${c.status?.label || c.status?.value})`
      : `${c.status.label} (${c.status.glyph})`;
    const rows = [
      ['Alamat', c.address || '—'],
      ['Status lahan', h('span', { class: 'status-inline' }, statusSwatch(c.status, 22), statusDisplay)],
      ['Kampus terdekat', c.nearestUniversityName || c.nearestUniversityId || '—'],
      ['Jarak ke centroid kampus', formatMeters(c.distanceM)],
    ];

    const distPoly = c.distanceToPolygonM ?? c.properties?.distance_to_polygon_meters;
    if (distPoly != null) {
      rows.push(['Jarak ke perimeter kampus', formatMeters(distPoly)]);
    }
    const in500 = c.isInBuffer500 ?? (c.distanceM != null ? c.distanceM <= 500.0 : null);
    if (in500 != null) {
      rows.push(['Status buffer 500 m (baseline)', in500 ? '✓ Di dalam buffer 500 m' : '✕ Di luar buffer 500 m']);
    }
    const in1km = c.isInBuffer1km ?? (c.distanceM != null ? c.distanceM <= 1000.0 : null);
    if (in1km != null) {
      rows.push(['Status buffer 1 km (skenario)', in1km ? '✓ Di dalam skenario 1 km' : '✕ Di luar skenario 1 km']);
    }

    rows.push(['Jenis data', c.provenanceLabel || DATA_KIND_TEXT[c.dataKind] || 'Simulasi Akademik']);

    if (isScenario) {
      if (c.areaSqm) {
        rows.push(['Luas lahan', `${numberID.format(c.areaSqm)} m² (nilai skenario simulasi)`]);
      } else {
        rows.push(['Luas lahan', 'Belum ditentukan (wajib diisi di planner)']);
      }
      if (c.rentalPriceYr) {
        rows.push(['Estimasi sewa skenario', `${rupiah.format(c.rentalPriceYr)} (nilai skenario simulasi, bukan harga pasar)`]);
      } else {
        rows.push(['Harga sewa', 'Belum ada data (wajib diisi di planner)']);
      }
      if (isRandomPlacement) {
        rows.push(['Penempatan spasial', 'Koordinat acak (Random Placement untuk simulasi)']);
      }
      rows.push(['Status simulasi', 'Skenario Hipotetis (simulated=true)']);
      if (c.properties?.price_basis) {
        rows.push(['Basis estimasi sewa', String(c.properties.price_basis)]);
      }
      if (Array.isArray(c.properties?.source_range) && c.properties.source_range.length === 2) {
        rows.push([
          'Rentang riset pembanding',
          `${rupiah.format(c.properties.source_range[0])} – ${rupiah.format(c.properties.source_range[1])}/thn (reports/research.md)`,
        ]);
      }
      if (c.properties?.generation_method) {
        rows.push(['Metode simulasi', `${c.properties.generation_method} (seed: ${c.properties.seed ?? 42})`]);
      }
    } else if (isDemo) {
      if (c.areaSqm) {
        rows.push(['Luas lahan', `${numberID.format(c.areaSqm)} m² (estimasi asumsi demo)`]);
      } else {
        rows.push(['Luas lahan', 'Belum diketahui (wajib diisi di planner)']);
      }
      if (c.rentalPriceYr) {
        rows.push(['Estimasi sewa / thn', `${rupiah.format(c.rentalPriceYr)} (asumsi demo, bukan data pasar)`]);
      } else {
        rows.push(['Harga sewa', 'Belum ada data (wajib diisi di planner)']);
      }
    } else {
      // Penanganan Nilai Null Jujur (Anti-Fabrikasi): Tidak mengarang angka jika observasi Street View tidak menemukan plang sewa/luas
      if (c.areaSqm != null) {
        rows.push(['Luas lahan', `${numberID.format(c.areaSqm)} m² (hasil observasi/survei)`]);
      } else {
        rows.push(['Luas lahan', 'null (Belum ada data luas)']);
      }
      if (c.rentalPriceYr != null) {
        const priceLabel = c.properties?.price_kind === 'estimate' ? 'estimasi dari rentang listing' : 'harga listing/survei';
        rows.push([`Harga sewa / thn (${priceLabel})`, rupiah.format(c.rentalPriceYr)]);
        if (c.priceSourceUrl || c.properties?.price_source_url) {
          rows.push([
            'Bukti harga sewa',
            h('a', { href: c.priceSourceUrl || c.properties.price_source_url, target: '_blank', rel: 'noopener noreferrer' }, 'Tautan Bukti Sewa ↗'),
          ]);
        }
      } else {
        rows.push(['Harga sewa', 'null (Belum ada data sewa (tidak ada papan sewa terverifikasi))']);
      }
      // Metadata observasi Google Street View (bukti empiris dan parameter kamera)
      if (c.surveyMethod || c.properties?.survey_method) {
        rows.push(['Metode survei', String(c.surveyMethod || c.properties.survey_method)]);
      }
      if (c.observedAt || c.properties?.observed_at) {
        rows.push(['Tanggal observasi', String(c.observedAt || c.properties.observed_at)]);
      }
      if (c.evidenceUrl || c.properties?.evidence_url) {
        rows.push([
          'Bukti observasi',
          h('a', { href: c.evidenceUrl || c.properties.evidence_url, target: '_blank', rel: 'noopener noreferrer' }, 'Tautan Bukti Observasi ↗'),
        ]);
      }
      const pano = c.panoId || c.properties?.pano_id;
      if (pano) rows.push(['ID Pano (Street View)', String(pano)]);
      const head = c.headingDeg ?? c.properties?.heading_deg;
      if (head != null) rows.push(['Sudut pandang (heading)', `${head}°`]);
      const imgDate = c.imageryDate || c.properties?.imagery_date;
      if (imgDate) rows.push(['Tanggal gambar Street View', String(imgDate)]);
      const locMethod = c.locationMethod || c.properties?.location_method;
      if (locMethod) rows.push(['Metode penentuan lokasi', String(locMethod)]);
      const notes = c.notes || c.properties?.notes;
      if (notes) rows.push(['Catatan observasi', String(notes)]);
      if (c.surveyedBy || c.properties?.surveyed_by) {
        rows.push(['Disurvei oleh', String(c.surveyedBy || c.properties.surveyed_by)]);
      }
    }

    // Tautan kafe OSM terdekat (interaksi klik untuk memusatkan peta ke kafe pesaing terdekat)
    const nearCafeInfo = findNearestOsmCafe(c, this.vm.data.osmCafes?.items);
    if (nearCafeInfo && nearCafeInfo.cafe) {
      rows.push([
        'Kafe OSM terdekat',
        h(
          'button',
          {
            type: 'button',
            class: 'nearest-cafe-btn',
            title: `Pusatkan ke ${nearCafeInfo.cafe.name} di peta`,
            onclick: () => {
              if (typeof this.actions.selectOsmCafe === 'function') {
                this.actions.selectOsmCafe(nearCafeInfo.cafe.id);
              } else {
                this.vm.select({ kind: 'osm_cafe', id: nearCafeInfo.cafe.id });
              }
            },
          },
          `☕ ${nearCafeInfo.cafe.name}${nearCafeInfo.distanceM != null ? ` (~${formatMeters(nearCafeInfo.distanceM)})` : ''} ↗`
        ),
      ]);
    }

    if (c.properties?.source) rows.push(['Sumber', String(c.properties.source)]);
    if (c.properties?.listing_id) rows.push(['ID Listing', String(c.properties.listing_id)]);
    if (c.properties?.listing_provider) rows.push(['Penyedia Listing', String(c.properties.listing_provider)]);
    if (c.properties?.listing_url) {
      rows.push([
        'Tautan Listing',
        h('a', { href: c.properties.listing_url, target: '_blank', rel: 'noopener noreferrer' }, 'Buka Listing ↗'),
      ]);
    }

    if (areaSummary) {
      const match = findMatchingAreaSummary(c, areaSummary);
      if (match && match.isSupported && match.has_sufficient_listings && match.median_price_yr != null) {
        rows.push([
          'Pasar sewa kawasan',
          `${rupiah.format(match.median_price_yr)}/thn (median estimasi dari ${match.count} listing pembanding)`,
        ]);
      } else {
        // Hapus data rentang harga jika ringkasan tidak didukung data listing terverifikasi (anti-fabrikasi)
        rows.push([
          'Pasar sewa kawasan',
          'Belum ada data sewa terverifikasi (estimasi pasar tidak tersedia)',
        ]);
      }
    }

    const handlerText = {
      called: 'Data lokasi sudah dikirim ke modul perencanaan.',
      missing: 'Modul perencanaan belum dimuat — hanya detail lokasi yang ditampilkan.',
      error: 'Modul perencanaan gagal memproses lokasi ini (cek console).',
    }[handlerStatus];

    const planBtnText = isScenario
      ? '☕ Rencanakan Modal Kafe (Skenario Sintetis)'
      : isDemo
        ? '☕ Rencanakan Modal Kafe (Simulasi Demo)'
        : '☕ Rencanakan Modal Kafe';

    const planBtn = evaluation.isEligible
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn-plan-action',
            id: 'inspector-plan-btn',
            onclick: () => {
              const landData = buildLandData(c);
              if (typeof window?.handleLandMarkerClick === 'function') {
                window.handleLandMarkerClick(landData);
              }
            },
          },
          planBtnText
        )
      : h(
          'button',
          {
            type: 'button',
            class: 'btn-plan-action btn-plan-disabled',
            disabled: true,
            title: isNonActionable
              ? 'Lokasi ini berstatus tempat tinggal atau fungsi lain, ditandai "Tidak Disewakan atau Dijual (Non-Planner)".'
              : 'Lokasi ini tidak memenuhi syarat untuk perencanaan kafe.',
          },
          isNonActionable
            ? '✕ Non-Planner: Tempat Tinggal / Komersial Aktif'
            : '✕ Lahan Tidak Memenuhi Syarat'
        );

    const callouts = [];
    if (isScenario) {
      callouts.push(
        h(
          'div',
          { class: 'callout callout-warn scenario-inspector-callout', role: 'alert' },
          h('strong', { text: isRandomPlacement ? '🎲 Skenario Sintetis (Penempatan Acak): ' : '🧪 Skenario Sintetis (Simulasi Hipotetis): ' }),
          `Lokasi ini merupakan titik simulasi skenario ${isRandomPlacement ? 'dengan penempatan spasial acak (random placement)' : ''}. Bukan merupakan listing properti faktual maupun hasil survei riil. Seluruh harga dan luas adalah parameter simulasi murni.`
        )
      );
    } else if (isDemo) {
      callouts.push(
        h(
          'div',
          { class: 'callout callout-warn', role: 'status' },
          h('strong', { text: '⚠️ Simulasi Akademik Demo (Tanpa Provenans Faktual). ' }),
          'Kandidat lahan ini adalah data sintetis demo akademik dan tidak memiliki verifikasi survei empiris di lapangan. Angka sewa dan luas adalah estimasi asumsi simulasi, bukan data pasar riil.'
        )
      );
    } else if (c.isSurvey) {
      callouts.push(
        h(
          'div',
          { class: 'callout callout-ok', role: 'status' },
          h('strong', { text: '📍 Observasi Street View. ' }),
          `Dilihat ${c.observedAt || '-'} pada gambar Street View ${c.imageryDate || '(tanggal gambar tidak dicatat)'}. Titik = posisi kamera (selisih ±10–30 m). Ketersediaan sewa belum dicek kecuali ada papan yang terbaca; status bisa berubah sejak tanggal gambar.`
        )
      );
    }
    callouts.push(this.eligibilityBlock(c, eligibleStatuses));

    const actionButtons = [];
    if (c.evidenceUrl || c.properties?.evidence_url) {
      actionButtons.push(
        h(
          'a',
          {
            class: 'btn-panorama',
            href: c.evidenceUrl || c.properties.evidence_url,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          '🔗 Buka Panorama Google Street View ↗'
        )
      );
    }
    actionButtons.push(planBtn);

    this.els.inspectorTitle.textContent = c.name;
    this.els.inspectorBody.replaceChildren(
      ...callouts,
      this.detailList(rows),
      ...actionButtons,
      handlerText ? h('p', { class: `handler-note handler-${handlerStatus}`, text: handlerText }) : null
    );
    this.openInspector();
  }

  showCampusInspector(u) {
    const rows = [
      ['Universitas', u.universityName || institutionLabel(u.institution)],
      ['Institusi', institutionLabel(u.institution)],
      ['Koordinat', `${u.lat.toFixed(6)}, ${u.lon.toFixed(6)}`],
    ];
    if (u.verifiedAt) rows.push(['Dicek', u.verifiedAt]);
    const sourceLink = /^https?:\/\//.test(u.source)
      ? h('a', { href: u.source, target: '_blank', rel: 'noopener', text: 'Lihat di OpenStreetMap' })
      : u.source || '—';
    rows.push(['Sumber', sourceLink]);
    this.els.inspectorTitle.textContent = u.campusName;
    this.els.inspectorBody.replaceChildren(
      h('p', { class: 'muted', text: 'Titik referensi kampus. Buffer 1 km dihitung dari titik ini.' }),
      this.detailList(rows)
    );
    this.openInspector();
  }

  showListingInspector(l) {
    const rows = [
      ['Judul listing', l.title || l.id],
      ['Alamat', l.address || '—'],
      ['Kawasan', l.areaCluster || '—'],
      ['Tipe properti', l.propertyType ? l.propertyType.toUpperCase() : 'RUKO'],
    ];
    if (l.buildingAreaSqm) rows.push(['Luas bangunan', `${numberID.format(l.buildingAreaSqm)} m²`]);
    if (l.landAreaSqm) rows.push(['Luas tanah', `${numberID.format(l.landAreaSqm)} m²`]);
    if (l.rentalPriceYr) rows.push(['Harga sewa / thn', `${rupiah.format(l.rentalPriceYr)} (Listing riil terverifikasi)`]);
    else rows.push(['Harga sewa / thn', 'Harga sewa tidak tercantum di listing']);
    if (l.priceSqmYr) rows.push(['Harga / m² / thn', `${rupiah.format(Math.round(l.priceSqmYr))} / m² (Listing riil)`]);
    rows.push(['Kampus terdekat', `${l.nearestUniversityName || '—'} (${formatMeters(l.distanceM)})`]);
    rows.push(['Status buffer', l.isInBuffer ? '✓ Di dalam buffer 1 km' : '✕ Di luar buffer 1 km']);
    rows.push(['Portal sumber', l.sourcePortal || 'Portal Publik']);
    if (l.sourceUrl) {
      rows.push([
        'Tautan listing',
        h('a', { href: l.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, `Buka di ${l.sourcePortal || 'Portal'} ↗`),
      ]);
    }
    rows.push(['Jenis data', 'Listing sewa riil publik (terverifikasi)']);

    const callout = h(
      'div',
      { class: 'callout callout-ok', role: 'status' },
      h('strong', { text: '🏢 Data Listing Sewa Riil Publik. ' }),
      'Informasi ini merupakan data pembanding pasar sewa terverifikasi dari portal properti publik Surabaya, terpisah dari simulasi kandidat lahan demo.'
    );

    const isRentable = l.isInBuffer !== false;
    const planBtn = isRentable
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn-plan-action',
            id: 'inspector-listing-plan-btn',
            onclick: () => {
              const landData = {
                id: l.id,
                name: l.title || l.id,
                address: l.address,
                status: 'Lahan yang tersedia untuk disewakan',
                area_sqm: l.landAreaSqm || l.buildingAreaSqm || null,
                rental_price_yr: l.rentalPriceYr || null,
                nearest_university_id: l.nearestUniversityId,
                nearest_university_name: l.nearestUniversityName,
                distance_meters: l.distanceM ?? null,
                is_in_buffer: true,
                institution: l.institution,
                coordinates: [l.lon, l.lat],
                data_kind: 'listing_properti_2026',
                is_verified_public: true,
                source_url: l.sourceUrl,
                source_portal: l.sourcePortal,
              };
              if (typeof window?.handleLandMarkerClick === 'function') {
                window.handleLandMarkerClick(landData);
              }
            },
          },
          '☕ Rencanakan Modal Kafe (Listing Terverifikasi)'
        )
      : h(
          'button',
          {
            type: 'button',
            class: 'btn-plan-action btn-plan-disabled',
            disabled: true,
            title: 'Listing di luar radius buffer 1 km dari kampus sasaran.',
          },
          '✕ Listing di Luar Buffer 1 km'
        );

    this.els.inspectorTitle.textContent = l.title || l.id;
    this.els.inspectorBody.replaceChildren(callout, this.detailList(rows), planBtn);
    this.openInspector();
  }

  showOsmCafeInspector(c) {
    const rows = [
      ['Nama Kafe', c.name || 'Kafe Eksisting'],
      ['Jenis Fasilitas', 'Kafe Eksisting (Kompetitor / Faktual)'],
      ['Koordinat', `${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`],
      ['Sumber', c.source || 'OpenStreetMap'],
    ];
    if (c.cuisine) rows.push(['Jenis Kuliner', c.cuisine]);
    if (c.brand) rows.push(['Merek / Brand', c.brand]);
    if (c.openingHours) rows.push(['Jam Buka', c.openingHours]);
    if (c.operator) rows.push(['Operator', c.operator]);
    if (c.verifiedAt) rows.push(['Tanggal Verifikasi', c.verifiedAt]);

    const callout = h(
      'div',
      { class: 'callout callout-ok', role: 'status' },
      h('strong', { text: '☕ Kafe Eksisting (Faktual OSM). ' }),
      'Titik ini merupakan data faktual kafe yang telah beroperasi di sekitar kawasan kampus. Menjadi acuan peta kompetisi usaha kafe (bukan lahan untuk disewa).'
    );

    const nonPlanBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn-plan-action btn-plan-disabled',
        disabled: true,
        title: 'Kafe eksisting yang sudah beroperasi tidak dapat direncanakan sebagai lokasi kafe baru.',
      },
      '✕ Non-Planner: Kafe Eksisting Aktif'
    );

    this.els.inspectorTitle.textContent = c.name;
    this.els.inspectorBody.replaceChildren(callout, this.detailList(rows), nonPlanBtn);
    this.openInspector();
  }

  showOsmBuildingInspector(b) {
    const rows = [
      ['Nama Gedung/Kampus', b.campusName || b.universityName || b.id],
      ['Institusi', institutionLabel(b.institution)],
      ['Ref OSM Way', b.osmWayRef || '—'],
    ];
    if (b.campusAreaHa) rows.push(['Perkiraan Luas Area', `${decimalID.format(b.campusAreaHa)} hektar`]);
    if (b.verifiedAt) rows.push(['Tanggal Verifikasi', b.verifiedAt]);
    const sourceLink = /^https?:\/\//.test(b.source)
      ? h('a', { href: b.source, target: '_blank', rel: 'noopener noreferrer', text: 'Buka di OpenStreetMap ↗' })
      : b.source || 'OpenStreetMap';
    rows.push(['Sumber', sourceLink]);

    const callout = h(
      'div',
      { class: 'callout callout-ok', role: 'status' },
      h('strong', { text: '🏛️ Perimeter Bangunan Kampus OSM (Faktual). ' }),
      'Geometri poligon batas fisik kampus resmi yang diambil langsung dari OSM ways.'
    );

    this.els.inspectorTitle.textContent = b.campusName || b.id;
    this.els.inspectorBody.replaceChildren(callout, this.detailList(rows));
    this.openInspector();
  }

  detailList(rows) {
    return h(
      'dl',
      { class: 'detail-list' },
      rows.map(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)])
    );
  }

  openInspector() {
    this.els.inspector.hidden = false;
  }

  hideInspector() {
    const hadFocus = this.els.inspector.contains(document.activeElement);
    this.els.inspector.hidden = true;
    if (hadFocus) $('map-canvas').focus();
  }

  // ---------- Tooltip ----------

  showTooltip(hit, x, y) {
    const el = this.els.tooltip;
    if (!hit) {
      el.hidden = true;
      return;
    }
    if (hit.kind === 'land') {
      const c = hit.item;
      const isScenario = Boolean(c.isScenario || c.dataKind === 'scenario' || c.simulated);
      const isNonActionable = c.status?.key === 'rumah' || c.status?.key === 'fungsi_lain';
      const statusText = isNonActionable
        ? 'Tidak Disewakan atau Dijual'
        : `${c.status.label} (${c.status.glyph})`;
      const kindLabel = isScenario
        ? (c.isRandomPlacement ? 'Skenario (Acak)' : 'Skenario Sintetis')
        : (DATA_KIND_SHORT[c.dataKind] || 'Kandidat');
      const priceText = c.rentalPriceYr
        ? (isScenario
            ? `${rupiah.format(c.rentalPriceYr)}/thn (harga skenario)`
            : (!c.isFactual ? `${rupiah.format(c.rentalPriceYr)}/thn (est. demo)` : `${rupiah.format(c.rentalPriceYr)}/thn`))
        : null;

      el.replaceChildren(
        h('strong', { text: c.name }),
        h('span', { text: statusText }),
        h('span', {
          text: `${formatMeters(c.distanceM).split(' (')[0]} dari ${c.nearestUniversityName || 'kampus'}${c.isInBuffer === false ? ' · di luar buffer' : ''}`,
        }),
        priceText ? h('span', { text: priceText }) : null,
        h('span', { class: `tooltip-kind ${isScenario ? 'tooltip-kind-scenario' : ''}`.trim(), text: kindLabel })
      );
    } else if (hit.kind === 'listing') {
      const l = hit.item;
      el.replaceChildren(
        h('strong', { text: l.title }),
        h('span', { text: `${rupiah.format(l.rentalPriceYr)}/thn (${l.sourcePortal || 'Portal'})` }),
        h('span', {
          text: `${formatMeters(l.distanceM).split(' (')[0]} dari ${l.nearestUniversityName || 'kampus'}${l.isInBuffer === false ? ' · di luar buffer' : ''}`,
        }),
        h('span', { class: 'tooltip-kind', text: 'Listing' })
      );
    } else if (hit.kind === 'osm_cafe') {
      const c = hit.item;
      el.replaceChildren(
        h('strong', { text: c.name }),
        h('span', { text: 'Kafe Eksisting (OSM Faktual)' }),
        h('span', { class: 'tooltip-kind', text: 'Kafe' })
      );
    } else if (hit.kind === 'osm_building') {
      const b = hit.item;
      el.replaceChildren(
        h('strong', { text: b.campusName || b.id }),
        h('span', { text: institutionLabel(b.institution) }),
        h('span', { class: 'tooltip-kind', text: 'Perimeter' })
      );
    } else {
      el.replaceChildren(h('strong', { text: hit.item.campusName }), h('span', { text: institutionLabel(hit.item.institution) }));
    }
    el.hidden = false;
    const stage = el.parentElement.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let left = x + 14;
    let top = y + 14;
    if (left + w > stage.width - 8) left = x - w - 14;
    if (top + hgt > stage.height - 8) top = y - hgt - 14;
    el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }

  // ---------- Skala & basemap ----------

  updateScaleBar(metersPerPixel) {
    const target = 110 * metersPerPixel;
    const pow = 10 ** Math.floor(Math.log10(target));
    const nice = [5, 2, 1].map((m) => m * pow).find((v) => v <= target) ?? pow;
    this.els.scaleLine.style.width = `${Math.round(nice / metersPerPixel)}px`;
    this.els.scaleLabel.textContent = nice >= 1000 ? `${decimalID.format(nice / 1000)} km` : `${numberID.format(nice)} m`;
  }

  updateBasemapNote(layerOn, status) {
    const note = this.els.basemapNote;
    this.els.attribution.hidden = !layerOn;
    if (!layerOn) {
      note.hidden = false;
      note.textContent = 'Basemap disembunyikan — menampilkan grid bujur/lintang.';
      return;
    }
    const text = {
      failed: 'Basemap OSM tidak bisa dimuat (offline/diblokir). Layer data tetap tampil di atas grid.',
      partial: 'Sebagian tile basemap gagal dimuat.',
    }[status];
    note.hidden = !text;
    note.textContent = text ?? '';
  }
}
