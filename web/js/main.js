// Entry point peta Buka Kafe: merangkai ViewModel, renderer Canvas, interaksi,
// dan UI DOM. Modul planner (milik anggota lain) TIDAK dibuka dari sini —
// peta hanya memanggil window.handleLandMarkerClick(landData) jika tersedia.

import { BASEMAP, VIEW, FALLBACK_ELIGIBLE_STATUSES } from './config.js';
import { Viewport } from './viewport.js';
import { TileLayer } from './tiles.js';
import { loadAllData, mergeBounds, boundsValid, buildLandData, notifyPlanner } from './data.js';
import { MapViewModel, institutionLabel } from './mapViewModel.js';
import { MapRenderer } from './renderer.js';
import { attachInteractions } from './interaction.js';
import { MapUI, evaluateCandidateEligibility } from './ui.js';

const canvas = document.getElementById('map-canvas');
const stage = document.getElementById('map-stage');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const vm = new MapViewModel();
const viewport = new Viewport({ tileSize: BASEMAP.tileSize, minZoom: VIEW.minZoom, maxZoom: VIEW.maxZoom });
viewport.setCenterLonLat(VIEW.fallbackCenter.lon, VIEW.fallbackCenter.lat, VIEW.fallbackZoom);

const ui = new MapUI(vm, {
  setLayer,
  setInstitution: (code, on) => vm.setInstitution(code, on),
  setStatus: (key, on) => vm.setStatus(key, on),
  resetFilters,
  zoomBy,
  fitAll: () => fitAll(true),
  jumpTo,
  selectCandidate,
  selectListing,
  clearSelection,
});

const tiles = new TileLayer({
  ...BASEMAP,
  onTileLoad: () => renderer.requestRender(),
  onStatusChange: (status) => {
    ui.updateBasemapNote(vm.layers.basemap, status);
    renderer.requestRender();
  },
});
const renderer = new MapRenderer(canvas, viewport, vm, tiles);
renderer.afterRender = () => ui.updateScaleBar(viewport.metersPerPixel());

let allBounds = null;
let eligibleStatuses = [...FALLBACK_ELIGIBLE_STATUSES];
let animation = null;
let announceTimer = null;

// ---------------------------------------------------------------- tampilan

function viewChanged() {
  renderer.requestRender();
}

function cancelAnimation() {
  if (animation) cancelAnimationFrame(animation);
  animation = null;
}

/** Animasi pusat & zoom (dimatikan bila pengguna memilih reduced motion). */
function flyTo(cx, cy, zoom, duration = 450) {
  cancelAnimation();
  const target = { cx, cy, zoom: viewport.clampZoom(zoom) };
  if (reduceMotion.matches || duration <= 0) {
    Object.assign(viewport, target);
    viewChanged();
    return;
  }
  const from = { cx: viewport.cx, cy: viewport.cy, zoom: viewport.zoom };
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    viewport.cx = from.cx + (target.cx - from.cx) * e;
    viewport.cy = from.cy + (target.cy - from.cy) * e;
    viewport.zoom = from.zoom + (target.zoom - from.zoom) * e;
    viewChanged();
    animation = t < 1 ? requestAnimationFrame(step) : null;
  };
  animation = requestAnimationFrame(step);
}

function fitTo(bounds, { animate = true, maxZoom = VIEW.maxZoom } = {}) {
  if (!boundsValid(bounds)) return;
  const probe = new Viewport({ tileSize: viewport.tileSize, minZoom: viewport.minZoom, maxZoom: viewport.maxZoom });
  probe.setSize(viewport.width, viewport.height);
  probe.fitBounds(bounds, VIEW.fitPadding, maxZoom);
  flyTo(probe.cx, probe.cy, probe.zoom, animate ? 450 : 0);
}

function pointBounds(items) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of items) {
    if (p.bounds) {
      if (p.bounds[0] < b[0]) b[0] = p.bounds[0];
      if (p.bounds[1] < b[1]) b[1] = p.bounds[1];
      if (p.bounds[2] > b[2]) b[2] = p.bounds[2];
      if (p.bounds[3] > b[3]) b[3] = p.bounds[3];
    } else {
      b[0] = Math.min(b[0], p.wx);
      b[1] = Math.min(b[1], p.wy);
      b[2] = Math.max(b[2], p.wx);
      b[3] = Math.max(b[3], p.wy);
    }
  }
  return b;
}

function fitAll(animate) {
  if (boundsValid(allBounds)) fitTo(allBounds, { animate, maxZoom: 15 });
  else flyTo(...centerOf(VIEW.fallbackCenter), VIEW.fallbackZoom, animate ? 450 : 0);
}

function centerOf({ lon, lat }) {
  const probe = new Viewport();
  probe.setCenterLonLat(lon, lat);
  return [probe.cx, probe.cy];
}

function zoomBy(delta) {
  cancelAnimation();
  flyTo(viewport.cx, viewport.cy, Math.round(viewport.zoom) + delta, 220);
}

function jumpTo(code) {
  const buffers = vm.data.buffers.items.filter((b) => b.institution === code);
  const campuses = vm.data.universities.items.filter((u) => u.institution === code);
  const bounds = mergeBounds(...buffers.map((b) => b.bounds), campuses.length ? pointBounds(campuses) : null);
  if (!boundsValid(bounds)) {
    ui.announce(`Data lokasi untuk ${institutionLabel(code)} belum tersedia di peta.`);
    return;
  }
  if (!vm.institutionEnabled(code)) {
    vm.setInstitution(code, true);
    ui.syncFilterInputs();
  }
  fitTo(bounds, { maxZoom: 15.5 });
  ui.announce(`Peta dipusatkan ke ${institutionLabel(code)}.`);
}

// ---------------------------------------------------------------- state

function setLayer(name, on) {
  if (name === 'basemap' && on) tiles.resetErrors();
  vm.setLayer(name, on);
}

function resetFilters() {
  vm.resetFilters();
  ui.syncFilterInputs();
}

/**
 * Pastikan marker terpilih terlihat dan tidak tertutup inspector.
 * Inspector lebar (ponsel) → marker ditaruh di area atasnya;
 * inspector sempit (desktop, kiri-bawah) → marker ditaruh di area kanannya.
 */
function revealSelected(item, { forceZoom = false } = {}) {
  const zoom = forceZoom ? Math.max(viewport.zoom, 15) : viewport.zoom;
  const s = viewport.tileSize * 2 ** zoom;
  const [x, y] = forceZoom
    ? [viewport.width / 2, viewport.height / 2]
    : viewport.worldToScreen(item.wx, item.wy);

  const stageRect = stage.getBoundingClientRect();
  const local = (el) => {
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left - stageRect.left, top: r.top - stageRect.top, right: r.right - stageRect.left, bottom: r.bottom - stageRect.top, width: r.width };
  };
  const pad = 56;
  const free = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const insp = local(ui.els.inspector);
  if (insp) {
    if (insp.width > viewport.width * 0.6) free.bottom = insp.top;
    else free.left = insp.right;
  }
  // Legenda (kanan-atas) juga overlay: hindari kalau memotong area bebas.
  const legend = local(document.getElementById('legend'));
  if (legend && legend.right > free.left && legend.left < free.right && legend.top < free.bottom && legend.bottom > free.top) {
    if (free.bottom - legend.bottom >= pad * 2 + 40) free.top = legend.bottom;
    else free.right = legend.left;
  }
  const visible = x > free.left + pad && x < free.right - pad && y > free.top + pad && y < free.bottom - pad;
  if (visible && !forceZoom) return;

  const tx = (free.left + free.right) / 2;
  const ty = Math.max(free.top + pad, (free.top + free.bottom) / 2);
  flyTo(item.wx - (tx - viewport.width / 2) / s, item.wy - (ty - viewport.height / 2) / s, zoom);
}

function selectCandidate(id, { source = 'map' } = {}) {
  const c = vm.findCandidate(id);
  if (!c) return;
  vm.select({ kind: 'land', id });
  const evaluation = evaluateCandidateEligibility(c, eligibleStatuses);
  let handlerStatus = null;
  // Hanya lahan yang memenuhi syarat (dalam buffer 1 km & berstatus kosong/disewakan)
  // yang dapat memicu modul planner
  if (evaluation.isEligible) {
    handlerStatus = notifyPlanner(c);
  }
  ui.showLandInspector(c, {
    handlerStatus,
    eligibleStatuses,
    areaSummary: vm.data.areaSummary?.summaries,
  });
  revealSelected(c, { forceZoom: source === 'list' && viewport.zoom < 14 });
  const verdict =
    c.isEligible === true ? 'Memenuhi syarat.' : c.isEligible === false ? 'Tidak memenuhi syarat.' : 'Kelayakan belum dihitung.';
  ui.announce(`${c.name}: ${c.status.label}. ${verdict}`);
}

function selectListing(id, { source = 'map' } = {}) {
  const l = vm.findListing(id);
  if (!l) return;
  vm.select({ kind: 'listing', id });
  ui.showListingInspector(l);
  revealSelected(l, { forceZoom: source === 'list' && viewport.zoom < 14 });
  ui.announce(`Listing: ${l.title}. Rp ${l.rentalPriceYr.toLocaleString('id-ID')}/tahun.`);
}

function selectCampus(id) {
  const u = vm.findCampus(id);
  if (!u) return;
  vm.select({ kind: 'campus', id });
  ui.showCampusInspector(u);
}

function selectOsmCafe(id) {
  const c = vm.findOsmCafe(id);
  if (!c) return;
  vm.select({ kind: 'osm_cafe', id });
  ui.showOsmCafeInspector(c);
  revealSelected(c);
  ui.announce(`Kafe OSM: ${c.name}. Faktual.`);
}

function selectOsmBuilding(id) {
  const b = vm.findOsmBuilding(id);
  if (!b) return;
  vm.select({ kind: 'osm_building', id });
  ui.showOsmBuildingInspector(b);
  if (b.wx != null && b.wy != null) revealSelected(b);
  ui.announce(`Perimeter Kampus: ${b.campusName || b.id}. Faktual.`);
}

function clearSelection() {
  vm.select(null);
  ui.hideInspector();
}

vm.onChange((reason) => {
  switch (reason) {
    case 'data':
      ui.renderInstitutionFilters();
      ui.renderStatusFilters();
      ui.renderQuickJump();
      ui.renderDataNotice();
      ui.renderDataErrors();
      ui.updateListingLayerState();
      ui.renderCandidateList();
      ui.updateMapMessage();
      break;
    case 'layers':
    case 'filters':
      if (!vm.selection) ui.hideInspector();
      ui.updateListingLayerState();
      ui.renderCandidateList();
      ui.updateMapMessage();
      ui.updateBasemapNote(vm.layers.basemap, tiles.status);
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => ui.announce(`${vm.visible.candidates.length} kandidat lahan terlihat.`), 400);
      break;
    case 'selection':
      syncListSelection();
      break;
    default:
      break;
  }
  renderer.requestRender();
});

function syncListSelection() {
  const id = vm.selection?.kind === 'land' ? vm.selection.id : null;
  ui.els.list.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.id === id));
  });
}

// ---------------------------------------------------------------- interaksi

attachInteractions(canvas, {
  viewport,
  renderer,
  onViewChange: () => {
    cancelAnimation();
    ui.showTooltip(null);
  },
  onHover: (hit, x, y) => {
    vm.setHover(hit ? { kind: hit.kind, id: hit.item.id } : null);
    canvas.style.cursor = hit ? 'pointer' : '';
    ui.showTooltip(hit, x, y);
  },
  onTap: (hit) => {
    if (!hit) return clearSelection();
    if (hit.kind === 'land') selectCandidate(hit.item.id, { source: 'map' });
    else if (hit.kind === 'listing') selectListing(hit.item.id, { source: 'map' });
    else if (hit.kind === 'osm_cafe') selectOsmCafe(hit.item.id);
    else if (hit.kind === 'osm_building') selectOsmBuilding(hit.item.id);
    else selectCampus(hit.item.id);
  },
  onFit: () => fitAll(true),
  onEscape: clearSelection,
});
canvas.addEventListener('pointerdown', cancelAnimation);
canvas.addEventListener('wheel', cancelAnimation, { passive: true });

let firstSize = true;
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  if (width < 1 || height < 1) return;
  renderer.resize(width, height);
  if (firstSize && allBounds) fitAll(false);
  firstSize = false;
}).observe(stage);

// ---------------------------------------------------------------- mulai

async function init() {
  ui.showMessage('Memuat data peta…', { busy: true });
  ui.updateBasemapNote(vm.layers.basemap, tiles.status);
  const data = await loadAllData();

  const rules = data.candidates.metadata?.evaluation_rules?.eligible_statuses;
  if (Array.isArray(rules) && rules.length) eligibleStatuses = rules.map(String);

  allBounds = mergeBounds(
    ...data.buffers.items.map((b) => b.bounds),
    data.universities.items.length ? pointBounds(data.universities.items) : null,
    data.candidates.items.length ? pointBounds(data.candidates.items) : null,
    data.osmBuildings?.items?.length ? mergeBounds(...data.osmBuildings.items.map((b) => b.bounds)) : null
  );

  ui.hideMessage();
  vm.setData(data);
  if (viewport.width > 1) fitAll(false);
}

init().catch((err) => {
  console.error('[peta] init:', err);
  vm.loading = false;
  ui.showMessage('Peta gagal dimulai. Muat ulang halaman; detail ada di console.');
});

// Untuk debug & tes manual di console. Bukan kontrak antarmodul.
window.bukaKafeMap = Object.freeze({ vm, viewport, renderer });
