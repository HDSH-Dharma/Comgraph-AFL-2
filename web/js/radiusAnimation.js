// Animasi radius buffer: lingkaran di setiap titik kampus membesar dari 0 m
// sampai radius skenario, sama seperti animasi di notebook GeoPandas.
// Modul ini TIDAK menghitung jarak sendiri: jarak kafe dan kandidat ke kampus
// terdekat sudah dihitung pipeline GIS (EPSG:32749) di properti distance_meters.

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;
const RENTABLE_KEYS = new Set(['kosong', 'sewa']);

/** Jari-jari lingkaran (px layar) untuk radius meter di lintang tertentu (Web Mercator). */
export function radiusMetersToPixels(radiusM, latDeg, scale) {
  const metersPerWorldUnit = EARTH_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180);
  return (radiusM / metersPerWorldUnit) * scale;
}

/** Jumlah kafe OSM dan lahan layak (kosong/disewakan) yang berjarak <= radius dari kampus terdekat. */
export function countWithinRadius(cafes, candidates, radiusM) {
  const within = (d) => d != null && Number.isFinite(d) && d <= radiusM;
  return {
    cafes: cafes.filter((c) => within(c.distanceM)).length,
    eligibleLand: candidates.filter((c) => within(c.distanceM) && RENTABLE_KEYS.has(c.status?.key)).length,
    land: candidates.filter((c) => within(c.distanceM)).length,
  };
}

export function isRentable(candidate) {
  return RENTABLE_KEYS.has(candidate?.status?.key);
}

export class RadiusAnimation {
  constructor({ maxRadiusM = 1000, durationMs = 6000, onChange = () => {} } = {}) {
    this.maxRadiusM = maxRadiusM;
    this.durationMs = durationMs;
    this.onChange = onChange;
    this.radiusM = null; // null = overlay tidak tampil
    this.playing = false;
    this.frame = null;
  }

  setRadius(radiusM) {
    this.stop();
    this.radiusM = radiusM == null ? null : Math.max(0, Math.min(this.maxRadiusM, radiusM));
    this.onChange(this);
  }

  play({ reducedMotion = false } = {}) {
    this.stop();
    if (reducedMotion) {
      this.radiusM = this.maxRadiusM;
      this.onChange(this);
      return;
    }
    const startRadius = this.radiusM != null && this.radiusM < this.maxRadiusM ? this.radiusM : 0;
    const startTime = performance.now() - (startRadius / this.maxRadiusM) * this.durationMs;
    this.playing = true;
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / this.durationMs);
      this.radiusM = Math.round((t * this.maxRadiusM) / 10) * 10;
      this.onChange(this);
      if (t < 1 && this.playing) {
        this.frame = requestAnimationFrame(step);
      } else {
        this.playing = false;
        this.frame = null;
        this.onChange(this);
      }
    };
    this.frame = requestAnimationFrame(step);
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.playing) {
      this.playing = false;
      this.onChange(this);
    }
  }

  reset() {
    this.stop();
    this.radiusM = null;
    this.onChange(this);
  }
}
