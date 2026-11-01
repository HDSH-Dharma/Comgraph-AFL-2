// Renderer Canvas 2D. Menggambar ulang seluruh peta dari state ViewModel
// setiap kali ada perubahan (dibatch dengan requestAnimationFrame).
// Urutan layer: latar → basemap → buffer → kampus → kandidat → sorotan → label.

import {
  BUFFER_STYLE,
  CAMPUS_STYLE,
  MARKER_RADIUS,
  OUT_OF_BUFFER_ALPHA,
  OSM_BUILDING_STYLE,
  OSM_CAFE_STYLE,
} from './config.js';
import {
  drawStatusMarker,
  drawHighlightRing,
  drawCampusMarker,
  drawListingMarker,
  drawOsmCafeMarker,
  campusHeadCenter,
} from './symbols.js';
import { worldToLonLat } from './viewport.js';

const BACKGROUND = '#EEF2F6';
const GRATICULE_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];

export class MapRenderer {
  constructor(canvas, viewport, vm, tileLayer) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.viewport = viewport;
    this.vm = vm;
    this.tiles = tileLayer;
    this.dpr = 1;
    this.pending = false;
    this.afterRender = null;
  }

  resize(width, height) {
    this.dpr = window.devicePixelRatio || 1;
    this.viewport.setSize(width, height);
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.render();
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    const { ctx, viewport: vp } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, vp.width, vp.height);

    const { layers } = this.vm;
    const basemapUsable = layers.basemap && this.tiles.status !== 'failed';
    if (layers.basemap) {
      try {
        this.tiles.draw(ctx, vp);
      } catch (err) {
        // Basemap tidak boleh menghentikan layer data.
        console.error('[peta] basemap:', err);
      }
    }
    if (!basemapUsable) this.drawGraticule();

    const visible = this.vm.visible;
    this.drawBuffers(visible.buffers);
    this.drawOsmBuildings(visible.osmBuildings);
    this.drawCampuses(visible.campuses);
    this.drawOsmCafes(visible.osmCafes);
    this.drawListings(visible.listings);
    this.drawCandidates(visible.candidates);
    this.drawLabels(visible);
    this.afterRender?.();
  }

  /** Garis bujur/lintang sebagai acuan saat basemap mati/gagal. */
  drawGraticule() {
    const { ctx, viewport: vp } = this;
    const nw = worldToLonLat(...vp.screenToWorld(0, 0));
    const se = worldToLonLat(...vp.screenToWorld(vp.width, vp.height));
    const pxPerDeg = vp.width / Math.max(se.lon - nw.lon, 1e-9);
    const step = GRATICULE_STEPS.find((s) => s * pxPerDeg >= 90) ?? 1;
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));

    ctx.save();
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.18)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(51, 65, 85, 0.75)';
    ctx.font = '11px system-ui, sans-serif';
    // Label bujur di tepi bawah, lintang di tepi kanan: tidak bertabrakan dengan toolbar kiri-atas.
    ctx.beginPath();
    ctx.textAlign = 'left';
    for (let i = Math.ceil(nw.lon / step); i * step <= se.lon; i++) {
      const lon = i * step;
      const [x] = vp.worldToScreen((lon + 180) / 360, 0);
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, vp.height);
      if (x < vp.width - 70) ctx.fillText(`${lon.toFixed(decimals)}°BT`, x + 3, vp.height - 6);
    }
    ctx.textAlign = 'right';
    for (let i = Math.ceil(se.lat / step); i * step <= nw.lat; i++) {
      const lat = i * step;
      const s = Math.sin((lat * Math.PI) / 180);
      const wy = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
      const [, y] = vp.worldToScreen(0, wy);
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(vp.width, Math.round(y) + 0.5);
      if (y > 20 && y < vp.height - 24) {
        ctx.fillText(`${Math.abs(lat).toFixed(decimals)}°${lat < 0 ? 'LS' : 'LU'}`, vp.width - 4, y - 4);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  tracePolygon(rings) {
    const { ctx, viewport: vp } = this;
    const s = vp.scale;
    const ox = vp.width / 2 - s * vp.cx;
    const oy = vp.height / 2 - s * vp.cy;
    ctx.beginPath();
    for (const ring of rings) {
      // Matriks afin M diterapkan langsung: x' = s·x + ox, y' = s·y + oy.
      ctx.moveTo(ring[0] * s + ox, ring[1] * s + oy);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i] * s + ox, ring[i + 1] * s + oy);
      ctx.closePath();
    }
  }

  inView(bounds, margin = 0) {
    const [minX, minY, maxX, maxY] = this.viewport.visibleWorldBounds();
    const m = margin / this.viewport.scale;
    return !(bounds[2] < minX - m || bounds[0] > maxX + m || bounds[3] < minY - m || bounds[1] > maxY + m);
  }

  drawBuffers(buffers) {
    if (!buffers.length) return;
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = BUFFER_STYLE.fill;
    for (const b of buffers) {
      if (!this.inView(b.bounds)) continue;
      this.tracePolygon(b.rings);
      ctx.fill('evenodd');
    }
    ctx.strokeStyle = BUFFER_STYLE.stroke;
    ctx.lineWidth = BUFFER_STYLE.lineWidth;
    ctx.setLineDash(BUFFER_STYLE.dash);
    for (const b of buffers) {
      if (!this.inView(b.bounds)) continue;
      this.tracePolygon(b.rings);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawOsmBuildings(buildings) {
    if (!buildings || !buildings.length) return;
    const { ctx } = this;
    const { selection, hover } = this.vm;
    ctx.save();
    for (const b of buildings) {
      if (!b.rings || !b.rings.length || !this.inView(b.bounds)) continue;
      const isSelected = selection?.kind === 'osm_building' && selection.id === b.id;
      const isHovered = hover?.kind === 'osm_building' && hover.id === b.id;

      ctx.fillStyle = isSelected
        ? 'rgba(59, 130, 246, 0.35)'
        : isHovered
          ? 'rgba(71, 85, 105, 0.28)'
          : OSM_BUILDING_STYLE.fill;
      this.tracePolygon(b.rings);
      ctx.fill('evenodd');

      ctx.strokeStyle = isSelected ? '#1D4ED8' : OSM_BUILDING_STYLE.stroke;
      ctx.lineWidth = isSelected ? 2.5 : OSM_BUILDING_STYLE.lineWidth;
      ctx.setLineDash([]);
      this.tracePolygon(b.rings);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCampuses(campuses) {
    const { selection, hover } = this.vm;
    // Gambar poligon batas area kampus jika tersedia di data
    for (const u of campuses) {
      if (u.rings && u.rings.length > 0) {
        if (!this.inView(u.bounds)) continue;
        this.ctx.save();
        this.ctx.fillStyle = CAMPUS_STYLE.polygonFill || 'rgba(30, 27, 75, 0.15)';
        this.tracePolygon(u.rings);
        this.ctx.fill('evenodd');
        this.ctx.strokeStyle = CAMPUS_STYLE.polygonStroke || '#1E1B4B';
        this.ctx.lineWidth = CAMPUS_STYLE.polygonLineWidth || 1.5;
        this.ctx.setLineDash([]);
        this.tracePolygon(u.rings);
        this.ctx.stroke();
        this.ctx.restore();
      }
    }
    // Gambar penanda pin kampus
    for (const u of campuses) {
      const [x, y] = this.viewport.worldToScreen(u.wx, u.wy);
      if (x < -40 || y < -60 || x > this.viewport.width + 40 || y > this.viewport.height + 40) continue;
      const highlight =
        (selection?.kind === 'campus' && selection.id === u.id) || (hover?.kind === 'campus' && hover.id === u.id);
      drawCampusMarker(this.ctx, x, y, CAMPUS_STYLE.size, { highlight });
    }
  }

  /** Urutan gambar: di luar buffer dulu, lalu di dalam buffer, terpilih paling atas. */
  orderedCandidates(candidates) {
    const sel = this.vm.selection?.kind === 'land' ? this.vm.selection.id : null;
    return [...candidates].sort((a, b) => {
      const ra = (a.id === sel ? 2 : 0) + (a.isInBuffer === false ? 0 : 1);
      const rb = (b.id === sel ? 2 : 0) + (b.isInBuffer === false ? 0 : 1);
      return ra - rb;
    });
  }

  drawCandidates(candidates) {
    const { ctx, viewport: vp } = this;
    const { selection, hover } = this.vm;
    const r = MARKER_RADIUS;
    for (const c of this.orderedCandidates(candidates)) {
      const [x, y] = vp.worldToScreen(c.wx, c.wy);
      if (x < -30 || y < -30 || x > vp.width + 30 || y > vp.height + 30) continue;
      const isSelected = selection?.kind === 'land' && selection.id === c.id;
      const isHovered = hover?.kind === 'land' && hover.id === c.id;
      if (isSelected) drawHighlightRing(ctx, x, y, r, { selected: true, warn: c.isEligible === false });
      else if (isHovered) drawHighlightRing(ctx, x, y, r);
      drawStatusMarker(ctx, c.status, x, y, r, {
        alpha: c.isInBuffer === false && !isSelected ? OUT_OF_BUFFER_ALPHA : 1,
        outOfBuffer: c.isInBuffer === false,
      });
    }
  }

  drawOsmCafes(cafes) {
    if (!cafes || !cafes.length) return;
    const { ctx, viewport: vp } = this;
    const { selection, hover } = this.vm;
    const r = OSM_CAFE_STYLE.radius || 7;
    for (const c of cafes) {
      const [x, y] = vp.worldToScreen(c.wx, c.wy);
      if (x < -30 || y < -30 || x > vp.width + 30 || y > vp.height + 30) continue;
      const isSelected = selection?.kind === 'osm_cafe' && selection.id === c.id;
      const isHovered = hover?.kind === 'osm_cafe' && hover.id === c.id;
      if (isSelected) drawHighlightRing(ctx, x, y, r, { selected: true, warn: false });
      else if (isHovered) drawHighlightRing(ctx, x, y, r);
      drawOsmCafeMarker(ctx, x, y, r, {
        highlight: isSelected || isHovered,
      });
    }
  }

  drawListings(listings) {
    if (!listings || !listings.length) return;
    const { ctx, viewport: vp } = this;
    const { selection, hover } = this.vm;
    const r = 8;
    for (const l of listings) {
      const [x, y] = vp.worldToScreen(l.wx, l.wy);
      if (x < -30 || y < -30 || x > vp.width + 30 || y > vp.height + 30) continue;
      const isSelected = selection?.kind === 'listing' && selection.id === l.id;
      const isHovered = hover?.kind === 'listing' && hover.id === l.id;
      drawListingMarker(ctx, x, y, r, {
        highlight: isSelected || isHovered,
        isInBuffer: l.isInBuffer !== false,
        alpha: l.isInBuffer === false && !isSelected ? 0.6 : 1,
      });
    }
  }

  drawText(text, x, y, { align = 'left', weight = 600, size = 12 } = {}) {
    const { ctx } = this;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#0F172A';
    ctx.fillText(text, x, y);
  }

  drawLabels(visible) {
    const { viewport: vp } = this;
    const z = vp.zoom;
    this.ctx.save();
    if (z >= 12.5) {
      for (const u of visible.campuses) {
        const [x, y] = vp.worldToScreen(u.wx, u.wy);
        const [hx, hy] = campusHeadCenter(x, y);
        const label = z >= 14.5 ? u.campusName : u.institution ?? u.campusName;
        this.drawText(label, hx + CAMPUS_STYLE.size + 5, hy, { weight: 700, size: 12 });
      }
    }
    if (z >= 16) {
      for (const c of visible.candidates) {
        const [x, y] = vp.worldToScreen(c.wx, c.wy);
        this.drawText(c.name, x + MARKER_RADIUS + 7, y, { weight: 600, size: 11 });
      }
    }
    if (z >= 16.5 && visible.listings?.length) {
      for (const l of visible.listings) {
        const [x, y] = vp.worldToScreen(l.wx, l.wy);
        this.drawText(l.title, x + 12, y, { weight: 600, size: 10 });
      }
    }
    if (z >= 16.5 && visible.osmCafes?.length) {
      for (const c of visible.osmCafes) {
        const [x, y] = vp.worldToScreen(c.wx, c.wy);
        this.drawText(c.name, x + 12, y, { weight: 600, size: 10 });
      }
    }
    this.ctx.restore();
  }

  /**
   * Cari fitur di titik layar (sx, sy). Toleransi lebih besar untuk sentuhan.
   * Kandidat diperiksa dari yang digambar paling atas.
   */
  hitTest(sx, sy, tolerance = 4) {
    const vp = this.viewport;
    const visible = this.vm.visible;
    const ordered = this.orderedCandidates(visible.candidates);
    const r = MARKER_RADIUS + tolerance;
    let best = null;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const c = ordered[i];
      const [x, y] = vp.worldToScreen(c.wx, c.wy);
      const d = Math.hypot(sx - x, sy - y);
      if (d <= r && (!best || d < best.d - 0.5)) {
        best = { kind: 'land', item: c, d };
        if (i === ordered.length - 1) break;
      }
    }
    if (best) return best;

    // Hit test listing sewa riil publik
    if (visible.listings?.length) {
      const lr = 8 + tolerance;
      for (let i = visible.listings.length - 1; i >= 0; i--) {
        const l = visible.listings[i];
        const [x, y] = vp.worldToScreen(l.wx, l.wy);
        const d = Math.hypot(sx - x, sy - y);
        if (d <= lr && (!best || d < best.d - 0.5)) {
          best = { kind: 'listing', item: l, d };
          break;
        }
      }
      if (best) return best;
    }

    // Hit test kafe eksisting OSM
    if (visible.osmCafes?.length) {
      const cr = (OSM_CAFE_STYLE.radius || 7) + tolerance;
      for (let i = visible.osmCafes.length - 1; i >= 0; i--) {
        const c = visible.osmCafes[i];
        const [x, y] = vp.worldToScreen(c.wx, c.wy);
        const d = Math.hypot(sx - x, sy - y);
        if (d <= cr && (!best || d < best.d - 0.5)) {
          best = { kind: 'osm_cafe', item: c, d };
          break;
        }
      }
      if (best) return best;
    }

    for (const u of visible.campuses) {
      const [x, y] = vp.worldToScreen(u.wx, u.wy);
      const [hx, hy] = campusHeadCenter(x, y);
      const inHead = Math.hypot(sx - hx, sy - hy) <= CAMPUS_STYLE.size + tolerance;
      const inStem = Math.abs(sx - x) <= 6 + tolerance && sy <= y + tolerance && sy >= hy;
      if (inHead || inStem) return { kind: 'campus', item: u, d: 0 };
    }

    // Hit test perimeter kampus OSM (berdasarkan titik tengah)
    if (visible.osmBuildings?.length) {
      const br = 12 + tolerance;
      for (const b of visible.osmBuildings) {
        if (b.wx != null && b.wy != null) {
          const [x, y] = vp.worldToScreen(b.wx, b.wy);
          const d = Math.hypot(sx - x, sy - y);
          if (d <= br) {
            return { kind: 'osm_building', item: b, d };
          }
        }
      }
    }

    return null;
  }
}
