// Transformasi koordinat peta.
//
// Rantai transformasi (setiap frame hanya langkah 2 yang dihitung ulang):
//   1. EPSG:4326 (lon, lat derajat)  →  koordinat "dunia" Web Mercator ternormalisasi
//      [0..1] × [0..1]. Dihitung SEKALI saat data dimuat.
//   2. Dunia → layar (px CSS) dengan matriks afin homogen 3×3:
//        M = T(w/2, h/2) · S(s, s) · T(−cx, −cy),   s = tileSize · 2^zoom
//      Skala x dan y sama (s), jadi aspek rasio selalu terjaga.
//
// Web Mercator dipakai untuk tampilan karena tile OSM memakai proyeksi itu;
// dengan begitu vektor dan basemap selalu sejajar. Peta TIDAK menghitung jarak
// atau buffer dari derajat: jarak & buffer berasal dari pipeline GIS (EPSG:32749).
// Satu-satunya besaran meter di sini adalah skala bar, dari faktor skala proyeksi.

const EARTH_RADIUS_M = 6378137;
const MAX_LAT = 85.05112878;

export function lonLatToWorld(lon, lat) {
  const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);
  return {
    x: (lon + 180) / 360,
    y: 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI),
  };
}

export function worldToLonLat(x, y) {
  const n = Math.PI * (1 - 2 * y);
  return {
    lon: x * 360 - 180,
    lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
  };
}

export class Viewport {
  constructor({ tileSize = 256, minZoom = 0, maxZoom = 19 } = {}) {
    this.tileSize = tileSize;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.cx = 0.5;
    this.cy = 0.5;
    this.zoom = minZoom;
    this.width = 1;
    this.height = 1;
  }

  /** Piksel layar per satu unit dunia. */
  get scale() {
    return this.tileSize * 2 ** this.zoom;
  }

  /** Matriks M (baris-utama, 3×3) — dipakai untuk dokumentasi/debug. */
  matrix() {
    const s = this.scale;
    return [
      [s, 0, this.width / 2 - s * this.cx],
      [0, s, this.height / 2 - s * this.cy],
      [0, 0, 1],
    ];
  }

  setSize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  worldToScreen(wx, wy) {
    const s = this.scale;
    return [(wx - this.cx) * s + this.width / 2, (wy - this.cy) * s + this.height / 2];
  }

  screenToWorld(sx, sy) {
    const s = this.scale;
    return [(sx - this.width / 2) / s + this.cx, (sy - this.height / 2) / s + this.cy];
  }

  clampZoom(z) {
    return Math.max(this.minZoom, Math.min(this.maxZoom, z));
  }

  setCenterLonLat(lon, lat, zoom = this.zoom) {
    const w = lonLatToWorld(lon, lat);
    this.cx = w.x;
    this.cy = w.y;
    this.zoom = this.clampZoom(zoom);
  }

  centerLonLat() {
    return worldToLonLat(this.cx, this.cy);
  }

  /** Geser tampilan sejauh (dx, dy) px layar. */
  panBy(dx, dy) {
    const s = this.scale;
    this.cx -= dx / s;
    this.cy -= dy / s;
  }

  /**
   * Zoom dengan titik jangkar (sx, sy) tetap di tempat:
   * komposit T(p) · S(k) · T(−p) terhadap titik layar p.
   */
  zoomAt(sx, sy, targetZoom) {
    const newZoom = this.clampZoom(targetZoom);
    if (newZoom === this.zoom) return false;
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.zoom = newZoom;
    const s = this.scale;
    this.cx = wx - (sx - this.width / 2) / s;
    this.cy = wy - (sy - this.height / 2) / s;
    return true;
  }

  /** Muat kotak dunia [minX, minY, maxX, maxY] ke layar dengan padding px. */
  fitBounds(bounds, padding = 32, maxZoom = this.maxZoom) {
    const [minX, minY, maxX, maxY] = bounds;
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const availW = Math.max(this.width - padding * 2, 40);
    const availH = Math.max(this.height - padding * 2, 40);
    const s = Math.min(availW / spanX, availH / spanY);
    const z = Math.log2(s / this.tileSize);
    this.zoom = Math.min(this.clampZoom(z), maxZoom);
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
  }

  /** Meter per piksel CSS di pusat tampilan (faktor skala Mercator). */
  metersPerPixel() {
    const { lat } = this.centerLonLat();
    return (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * EARTH_RADIUS_M) / this.scale;
  }

  /** Batas dunia yang terlihat: [minX, minY, maxX, maxY]. */
  visibleWorldBounds() {
    const [minX, minY] = this.screenToWorld(0, 0);
    const [maxX, maxY] = this.screenToWorld(this.width, this.height);
    return [minX, minY, maxX, maxY];
  }
}
