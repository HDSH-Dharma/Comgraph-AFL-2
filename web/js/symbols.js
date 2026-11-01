// Simbol marker. Dipakai bersama oleh renderer peta dan legenda supaya
// bentuk/warna/huruf di legenda selalu identik dengan yang ada di peta.

import { CAMPUS_STYLE } from './config.js';

const TAU = Math.PI * 2;

/** Offset vertikal huruf supaya terlihat di tengah bentuk. */
const GLYPH_OFFSET = { circle: 0, square: 0, diamond: 0, triangle: 0.28, house: 0.22 };

export function traceShape(ctx, shape, x, y, r) {
  ctx.beginPath();
  switch (shape) {
    case 'square': {
      const h = r * 0.9;
      ctx.moveTo(x - h, y - h);
      ctx.lineTo(x + h, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.lineTo(x - h, y + h);
      ctx.closePath();
      break;
    }
    case 'diamond': {
      const d = r * 1.2;
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
      break;
    }
    case 'triangle': {
      const t = r * 1.25;
      ctx.moveTo(x, y - t);
      ctx.lineTo(x + t, y + t * 0.75);
      ctx.lineTo(x - t, y + t * 0.75);
      ctx.closePath();
      break;
    }
    case 'house': {
      const w = r * 0.95;
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + w * 1.05, y - r * 0.15);
      ctx.lineTo(x + w, y - r * 0.15);
      ctx.lineTo(x + w, y + r * 0.95);
      ctx.lineTo(x - w, y + r * 0.95);
      ctx.lineTo(x - w, y - r * 0.15);
      ctx.lineTo(x - w * 1.05, y - r * 0.15);
      ctx.closePath();
      break;
    }
    case 'circle':
    default:
      ctx.arc(x, y, r, 0, TAU);
  }
}

/**
 * Gambar marker status lahan.
 * @param {object} opts { alpha, outOfBuffer }
 */
export function drawStatusMarker(ctx, status, x, y, r, opts = {}) {
  const { alpha = 1, outOfBuffer = false, isScenario = false } = opts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';

  traceShape(ctx, status.shape, x, y, r);
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.6)';
  ctx.stroke();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
  ctx.fillStyle = status.color;
  ctx.fill();

  if (outOfBuffer) {
    // Garis putus-putus di dalam tepi: penanda "di luar buffer" yang tidak bergantung warna.
    traceShape(ctx, status.shape, x, y, r * 0.78);
    ctx.setLineDash([2.5, 2.5]);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = status.ink;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (isScenario) {
    // Penanda skenario sintetis: cincin halo putus-putus ungu khas simulasi
    ctx.beginPath();
    ctx.arc(x, y, r + 4, 0, TAU);
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#9333EA';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = status.ink;
  ctx.font = `700 ${Math.round(r * 1.05)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(status.glyph, x, y + r * (GLYPH_OFFSET[status.shape] ?? 0) + 0.5);
  ctx.restore();
}

/** Cincin sorotan untuk marker terpilih / di-hover. */
export function drawHighlightRing(ctx, x, y, r, { selected = false, warn = false } = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r + (selected ? 8 : 6), 0, TAU);
  if (selected) {
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = warn ? '#B91C1C' : '#111827';
    if (warn) ctx.setLineDash([5, 3]);
    ctx.stroke();
  } else {
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(17, 24, 39, 0.55)';
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Marker kampus berbentuk pin (ujung lancip = lokasi), sengaja beda dari
 * kelima bentuk marker lahan. Kepala pin berisi ikon gedung putih.
 */
export function drawCampusMarker(ctx, x, y, size = CAMPUS_STYLE.size, { highlight = false } = {}) {
  const r = size;
  const hx = x;
  const hy = y - r * 1.55;
  ctx.save();
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - r * 0.35, y - r * 0.6, hx - r, hy + r * 0.55, hx - r, hy);
  ctx.arc(hx, hy, r, Math.PI, 0);
  ctx.bezierCurveTo(hx + r, hy + r * 0.55, x + r * 0.35, y - r * 0.6, x, y);
  ctx.closePath();
  ctx.lineWidth = highlight ? 6 : 4.5;
  ctx.strokeStyle = highlight ? '#F59E0B' : 'rgba(15, 23, 42, 0.55)';
  ctx.stroke();
  ctx.lineWidth = 2.25;
  ctx.strokeStyle = CAMPUS_STYLE.ring;
  ctx.stroke();
  ctx.fillStyle = CAMPUS_STYLE.fill;
  ctx.fill();

  // Ikon gedung: atap segitiga + badan + 3 tiang.
  const s = r * 0.55;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.moveTo(hx, hy - s);
  ctx.lineTo(hx + s, hy - s * 0.35);
  ctx.lineTo(hx - s, hy - s * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(hx - s, hy + s * 0.55, s * 2, s * 0.3);
  for (const dx of [-0.7, 0, 0.7]) ctx.fillRect(hx + dx * s - s * 0.12, hy - s * 0.25, s * 0.24, s * 0.8);
  ctx.restore();
}

/** Titik pusat kepala pin, dipakai untuk hit-test kampus. */
export function campusHeadCenter(x, y, size = CAMPUS_STYLE.size) {
  return [x, y - size * 1.55];
}

/**
 * Marker listing sewa riil publik.
 * Berbentuk lingkaran ungu dengan glif 'L' dan border putih, terpisah visual dari kandidat lahan & kampus.
 */
export function drawListingMarker(ctx, x, y, r = 8, { highlight = false, isInBuffer = true, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.lineWidth = highlight ? 4.5 : 2.5;
  ctx.strokeStyle = highlight ? '#F59E0B' : '#FFFFFF';
  ctx.stroke();
  ctx.fillStyle = isInBuffer ? '#7C3AED' : '#A78BFA';
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 ${Math.round(r * 1.15)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('L', x, y + 0.5);
  ctx.restore();
}

/**
 * Marker kafe eksisting OSM (faktual).
 * Berbentuk lingkaran amber/oranye dengan ikon cangkir kopi (☕) atau border cokelat tebal.
 */
export function drawOsmCafeMarker(ctx, x, y, r = 7, { highlight = false, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.lineWidth = highlight ? 4.5 : 2;
  ctx.strokeStyle = highlight ? '#F59E0B' : '#78350F';
  ctx.stroke();
  ctx.fillStyle = '#D97706';
  ctx.fill();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 ${Math.round(r * 1.1)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('☕', x, y + 0.5);
  ctx.restore();
}

/** Gambar simbol ke kanvas kecil (legenda, daftar, inspector). */
export function paintSwatch(canvas, draw, cssSize = 28) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  canvas.style.width = `${cssSize}px`;
  canvas.style.height = `${cssSize}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  draw(ctx, cssSize / 2, cssSize / 2);
}
