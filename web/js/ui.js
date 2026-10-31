// View DOM: kontrol, legenda, daftar kandidat, inspector, tooltip, pesan.
// Semua teks dari data dimasukkan lewat textContent (tidak lewat innerHTML).

import {
  LAND_STATUSES,
  QUICK_JUMP_TARGETS,
  DATA_LABELS,
  MARKER_RADIUS,
  OUT_OF_BUFFER_ALPHA,
  BUFFER_STYLE,
} from './config.js';
import { NO_INSTITUTION, institutionLabel } from './mapViewModel.js';
import { paintSwatch, drawStatusMarker, drawCampusMarker } from './symbols.js';

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
  demo: 'Data demo (simulasi akademik), belum diverifikasi lapangan',
  verified: 'Terverifikasi',
  unknown: 'Sumber data belum jelas',
};
const DATA_KIND_SHORT = { demo: 'Demo', verified: 'Terverifikasi', unknown: 'Belum jelas' };

function statusSwatch(status, size = 28, opts = {}) {
  const c = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
  paintSwatch(c, (ctx, x, y) => drawStatusMarker(ctx, status, x, y, size * 0.3, opts), size);
  return c;
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
    const bufferCanvas = h('canvas', { class: 'swatch', 'aria-hidden': 'true' });
    paintSwatch(bufferCanvas, (ctx, x, y) => {
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.fillStyle = BUFFER_STYLE.fill;
      ctx.fill();
      ctx.setLineDash(BUFFER_STYLE.dash.map((d) => d / 2));
      ctx.strokeStyle = BUFFER_STYLE.stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }, 26);
    list.append(
      h('li', { class: 'legend-sep' }, outCanvas, h('span', { text: 'Pudar + garis putus di dalam = di luar buffer 1 km' })),
      h('li', {}, campusCanvas, h('span', { text: 'Titik kampus (pin)' })),
      h('li', {}, bufferCanvas, h('span', { text: 'Buffer 1 km dari kampus' }))
    );
    this.els.legend.replaceChildren(list);
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
    const codes = [...QUICK_JUMP_TARGETS, ...[...present].filter((c) => !QUICK_JUMP_TARGETS.includes(c)).sort()];
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
    this.els.notice.textContent = `${parts.join('; ')}. Cek label jenis data di tiap lokasi.`;
  }

  renderDataErrors() {
    const { data } = this.vm;
    const failed = Object.entries(data).filter(([, d]) => !d.ok);
    const warnings = [];
    for (const [key, d] of Object.entries(data)) {
      if (d.ok && d.skipped) warnings.push(`${DATA_LABELS[key]}: ${d.skipped} fitur dilewati karena geometri/id tidak valid.`);
      if (d.ok && d.unknownStatus) warnings.push(`${DATA_LABELS[key]}: ${d.unknownStatus} status tidak dikenal, ditampilkan sebagai “Belum terverifikasi”.`);
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
    this.els.count.textContent = cand.ok ? `${visible.length} dari ${cand.items.length}` : '';
    if (!cand.ok) {
      this.els.list.replaceChildren(h('li', { class: 'muted', text: 'Data kandidat belum tersedia.' }));
      return;
    }
    if (!vm.layers.candidates) {
      this.els.list.replaceChildren(h('li', { class: 'muted', text: 'Layer kandidat lahan sedang disembunyikan.' }));
      return;
    }
    if (!visible.length) {
      this.els.list.replaceChildren(
        h('li', { class: 'muted', text: cand.items.length ? 'Tidak ada kandidat yang cocok dengan filter.' : 'Belum ada data kandidat lahan.' })
      );
      return;
    }
    const selectedId = vm.selection?.kind === 'land' ? vm.selection.id : null;
    this.els.list.replaceChildren(
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
            statusSwatch(c.status, 26, { alpha: c.isInBuffer === false ? OUT_OF_BUFFER_ALPHA : 1, outOfBuffer: c.isInBuffer === false }),
            h(
              'span',
              { class: 'candidate-text' },
              h('span', { class: 'candidate-name', text: c.name }),
              h('span', {
                class: 'candidate-meta',
                text: [
                  c.status.label,
                  c.distanceM != null ? formatMeters(c.distanceM).split(' (')[0] : null,
                  c.isInBuffer === false ? 'di luar buffer' : null,
                  DATA_KIND_SHORT[c.dataKind],
                ]
                  .filter(Boolean)
                  .join(' · '),
              })
            )
          )
        )
      )
    );
  }

  // ---------- Inspector ----------

  eligibilityBlock(c, eligibleStatuses) {
    if (c.isEligible === true) {
      return h(
        'div',
        { class: 'callout callout-ok', role: 'status' },
        h('strong', { text: '✓ Memenuhi syarat (menurut data GIS). ' }),
        'Berada di dalam buffer 1 km dan status lahannya bisa dipilih.'
      );
    }
    if (c.isEligible === false) {
      const reasons = [];
      if (c.isInBuffer === false) {
        reasons.push(`Di luar buffer 1 km: ${formatMeters(c.distanceM)} dari ${c.nearestUniversityName || 'kampus terdekat'}.`);
      }
      if (!eligibleStatuses.includes(c.status.value)) reasons.push(`Status “${c.status.label}” tidak dapat dipilih.`);
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

  showLandInspector(c, { handlerStatus, eligibleStatuses }) {
    const rows = [
      ['Alamat', c.address || '—'],
      ['Status lahan', h('span', { class: 'status-inline' }, statusSwatch(c.status, 22), `${c.status.label} (${c.status.glyph})`)],
      ['Kampus terdekat', c.nearestUniversityName || c.nearestUniversityId || '—'],
      ['Jarak', formatMeters(c.distanceM)],
      ['Jenis data', DATA_KIND_TEXT[c.dataKind]],
    ];
    if (c.areaSqm) rows.push(['Luas', `${numberID.format(c.areaSqm)} m²`]);
    if (c.rentalPriceYr) rows.push(['Sewa per tahun', rupiah.format(c.rentalPriceYr)]);
    if (c.properties.source) rows.push(['Sumber', String(c.properties.source)]);

    const handlerText = {
      called: 'Data lokasi sudah dikirim ke modul perencanaan.',
      missing: 'Modul perencanaan belum dimuat — hanya detail lokasi yang ditampilkan.',
      error: 'Modul perencanaan gagal memproses lokasi ini (cek console).',
    }[handlerStatus];

    this.els.inspectorTitle.textContent = c.name;
    this.els.inspectorBody.replaceChildren(
      this.eligibilityBlock(c, eligibleStatuses),
      this.detailList(rows),
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
      el.replaceChildren(
        h('strong', { text: c.name }),
        h('span', { text: `${c.status.label} (${c.status.glyph})` }),
        h('span', {
          text: `${formatMeters(c.distanceM).split(' (')[0]} dari ${c.nearestUniversityName || 'kampus'}${c.isInBuffer === false ? ' · di luar buffer' : ''}`,
        }),
        h('span', { class: 'tooltip-kind', text: DATA_KIND_SHORT[c.dataKind] })
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
