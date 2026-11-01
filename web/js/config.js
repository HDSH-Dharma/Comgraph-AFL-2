// Konfigurasi peta Buka Kafe.
// Semua nilai yang perlu disepakati dengan anggota lain (path data, taksonomi
// status, label kampus) dikumpulkan di sini supaya modul lain tidak hardcode.

// Path data relatif terhadap web/index.html.
// Jalankan server dari ROOT repo (bukan dari web/) supaya ../data bisa diakses:
//   python3 -m http.server 8000   →   http://localhost:8000/web/
export const DATA_FILES = Object.freeze({
  universities: '../data/processed/universities.geojson',
  buffers: '../data/processed/buffer_1km.geojson',
  candidates: '../data/processed/land_candidates.geojson',
  listings: '../data/processed/real_rental_listings.geojson',
  areaSummary: '../data/processed/area_rental_price_summary.json',
  osmBuildings: '../data/processed/universities_polygons.geojson',
  osmCafes: '../data/processed/osm_cafes.geojson',
});

export const DATA_LABELS = Object.freeze({
  universities: 'Titik kampus (OSM faktual)',
  buffers: 'Buffer 1 km',
  candidates: 'Kandidat lahan (Survei Google Maps & Street View)',
  listings: 'Listing sewa riil publik',
  osmBuildings: 'Perimeter kampus/bangunan (OSM faktual)',
  osmCafes: 'Kafe eksisting (OSM faktual)',
});

export const LISTING_STYLE = Object.freeze({
  color: '#8B5CF6',
  radius: 8,
  glyph: 'L',
  label: 'Listing sewa riil publik',
});

export const OSM_BUILDING_STYLE = Object.freeze({
  fill: 'rgba(51, 65, 85, 0.15)',
  stroke: '#334155',
  lineWidth: 1.5,
  label: 'Perimeter bangunan/kampus OSM (faktual)',
});

export const OSM_CAFE_STYLE = Object.freeze({
  color: '#D97706',
  stroke: '#78350F',
  radius: 7,
  glyph: '☕',
  label: 'Kafe eksisting OSM (faktual)',
});

// Lima status lahan. `value` harus sama persis dengan VALID_LAND_STATUSES
// di scripts/gis_pipeline.py. Warna sesuai brief UI; bentuk + huruf dipakai
// supaya status tetap terbaca tanpa membedakan warna.
export const LAND_STATUSES = Object.freeze([
  {
    key: 'kosong',
    value: 'Lahan kosong',
    label: 'Lahan kosong',
    badgeLabel: 'Lahan Kosong',
    actionable: true,
    isPlannerAllowed: true,
    color: '#10B981',
    ink: '#052E1F',
    glyph: 'K',
    shape: 'circle',
    shapeName: 'lingkaran',
  },
  {
    key: 'sewa',
    value: 'Lahan yang tersedia untuk disewakan',
    label: 'Tersedia disewakan',
    badgeLabel: 'Tersedia Disewakan',
    actionable: true,
    isPlannerAllowed: true,
    color: '#3B82F6',
    ink: '#FFFFFF',
    glyph: 'S',
    shape: 'square',
    shapeName: 'kotak',
  },
  {
    key: 'rumah',
    value: 'Rumah atau bangunan tempat tinggal',
    label: 'Tidak Disewakan atau Dijual (Rumah)',
    badgeLabel: 'Tidak Disewakan atau Dijual',
    actionable: false,
    isPlannerAllowed: false,
    color: '#F59E0B',
    ink: '#2B1700',
    glyph: 'R',
    shape: 'house',
    shapeName: 'rumah',
  },
  {
    key: 'fungsi_lain',
    value: 'Bangunan yang telah digunakan untuk fungsi lain',
    label: 'Tidak Disewakan atau Dijual (Ruko/Fungsi Lain)',
    badgeLabel: 'Tidak Disewakan atau Dijual',
    actionable: false,
    isPlannerAllowed: false,
    color: '#6B7280',
    ink: '#FFFFFF',
    glyph: 'F',
    shape: 'diamond',
    shapeName: 'belah ketupat',
  },
  {
    key: 'belum',
    value: 'Lahan yang statusnya belum terverifikasi',
    label: 'Belum terverifikasi',
    badgeLabel: 'Belum Terverifikasi',
    actionable: false,
    isPlannerAllowed: false,
    color: '#9CA3AF',
    ink: '#111827',
    glyph: '?',
    shape: 'triangle',
    shapeName: 'segitiga',
  },
]);

// Sama dengan DEFAULT_LAND_STATUS di pipeline: status kosong/tidak dikenal
// diperlakukan sebagai "belum terverifikasi".
export const DEFAULT_STATUS_KEY = 'belum';

// Dipakai hanya untuk teks alasan di inspector jika metadata GIS tidak memuat
// evaluation_rules. Keputusan kelayakan tetap dari field is_eligible hasil GIS.
export const FALLBACK_ELIGIBLE_STATUSES = Object.freeze([
  'Lahan kosong',
  'Lahan yang tersedia untuk disewakan',
]);

// Label singkat institusi sasaran (Unair, UKWMS, Ubaya).
// Kode diambil dari properti `institution` di GeoJSON.
export const INSTITUTION_LABELS = Object.freeze({
  UNAIR: 'Unair',
  UKWMS: 'UKWMS',
  UBAYA: 'Ubaya',
});

// Quick-jump untuk 3 kampus sasaran proyek: Unair, UKWMS, Ubaya.
// Kode yang belum memiliki data di GeoJSON tetap tampil sebagai tombol
// nonaktif dengan label "(belum ada data)" (toleransi data gagal/belum tersedia,
// bukan mengarang koordinat fiktif). Kontrol filter di sidebar tetap dinamis
// mengikuti data aktual yang berhasil dimuat.
export const QUICK_JUMP_TARGETS = Object.freeze(['UNAIR', 'UKWMS', 'UBAYA']);

export const BUFFER_STYLE = Object.freeze({
  fill: 'rgba(99, 102, 241, 0.12)',
  stroke: 'rgba(67, 56, 202, 0.85)',
  lineWidth: 1.5,
  dash: [6, 4],
});

export const CAMPUS_STYLE = Object.freeze({
  fill: '#1E1B4B',
  ring: '#FFFFFF',
  size: 13,
  polygonFill: 'rgba(30, 27, 75, 0.15)',
  polygonStroke: '#1E1B4B',
  polygonLineWidth: 1.5,
});

export const MARKER_RADIUS = 10; // px CSS, konstan di semua zoom
export const OUT_OF_BUFFER_ALPHA = 0.5;

export const BASEMAP = Object.freeze({
  // Tile OSM hanya sebagai latar. Atribusi wajib tampil (lihat index.html).
  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileSize: 256,
  minZoom: 0,
  maxZoom: 19,
  maxCachedTiles: 400,
});

export const VIEW = Object.freeze({
  minZoom: 10,
  maxZoom: 19,
  // Dipakai hanya jika file kampus gagal dimuat dan tidak ada geometri lain.
  // Ini titik tengah tampilan Surabaya, bukan data.
  fallbackCenter: { lon: 112.75, lat: -7.29 },
  fallbackZoom: 12,
  fitPadding: 40,
});
