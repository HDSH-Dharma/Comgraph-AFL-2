// Test suite untuk logika frontend peta Buka Kafe (ESM, zero external dependencies).
// Dijalankan dengan: node web/test_frontend.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  DATA_FILES,
  DATA_LABELS,
  LISTING_STYLE,
  QUICK_JUMP_TARGETS,
  INSTITUTION_LABELS,
  LAND_STATUSES,
  DEFAULT_STATUS_KEY,
  FALLBACK_ELIGIBLE_STATUSES,
} from './js/config.js';
import { MapViewModel, institutionLabel, NO_INSTITUTION } from './js/mapViewModel.js';
import {
  statusByKey,
  classifyDataKind,
  buildLandData,
  notifyPlanner,
  PARSERS,
  linkInstitutions,
  isGenericListingUrl,
  isValidEvidenceListing,
  validateAreaSummariesWithListings,
} from './js/data.js';
import { evaluateCandidateEligibility, findMatchingAreaSummary, MapUI } from './js/ui.js';
import {
  canPlanForLand,
  calculateInitialCapital,
  calculateFeasibilityPoints,
  formatRupiah,
  downloadJsonFile,
  ELIGIBLE_LAND_STATUSES,
  DEFAULT_PLAN_COSTS,
  COST_ASSUMPTIONS,
  escapeHtml,
  PlanStorage,
  PlannerUI,
  initPlanner,
} from './js/planner.js';
import { MapRenderer } from './js/renderer.js';
import { Viewport } from './js/viewport.js';
import { drawStatusMarker } from './js/symbols.js';

test('1. Konfigurasi Institusi Sasaran & Eliminasi Mismatch Unesa', () => {
  // Target institusi resmi proyek adalah tripartit: UNAIR, UKWMS, UBAYA.
  assert.deepEqual(
    QUICK_JUMP_TARGETS,
    ['UNAIR', 'UKWMS', 'UBAYA'],
    'QUICK_JUMP_TARGETS harus persis [UNAIR, UKWMS, UBAYA]'
  );

  assert.equal(INSTITUTION_LABELS.UNAIR, 'Unair');
  assert.equal(INSTITUTION_LABELS.UKWMS, 'UKWMS');
  assert.equal(INSTITUTION_LABELS.UBAYA, 'Ubaya');

  // Memastikan mismatch Unesa telah dihapus dari konfigurasi sasaran hardcoded
  assert.equal(
    Object.prototype.hasOwnProperty.call(INSTITUTION_LABELS, 'UNESA'),
    false,
    'UNESA tidak boleh ada di INSTITUTION_LABELS (mismatch target harus dieliminasi)'
  );

  // Verifikasi 5 taksonomi status lahan
  assert.equal(LAND_STATUSES.length, 5, 'Harus ada 5 status lahan baku');
  const statusValues = LAND_STATUSES.map((s) => s.value);
  assert.ok(statusValues.includes('Lahan kosong'));
  assert.ok(statusValues.includes('Lahan yang tersedia untuk disewakan'));
  assert.ok(statusValues.includes('Rumah atau bangunan tempat tinggal'));
  assert.ok(statusValues.includes('Bangunan yang telah digunakan untuk fungsi lain'));
  assert.ok(statusValues.includes('Lahan yang statusnya belum terverifikasi'));
});

test('2. Resolusi Label Institusi & Fallback Toleran (mapViewModel.js)', () => {
  // Label terkonfigurasi
  assert.equal(institutionLabel('UNAIR'), 'Unair');
  assert.equal(institutionLabel('UKWMS'), 'UKWMS');
  assert.equal(institutionLabel('UBAYA'), 'Ubaya');

  // Fallback institusi dinamis dari data luar target (misal data warisan UNESA)
  assert.equal(
    institutionLabel('UNESA'),
    'UNESA',
    'Institusi non-target harus fallback ke kodenya tanpa crash'
  );

  // Fallback kosong / null
  assert.equal(institutionLabel(null), 'Tanpa kampus terkait');
  assert.equal(institutionLabel(NO_INSTITUTION), 'Tanpa kampus terkait');
});

test('3. ViewModel: Isolasi Quick-Jump vs Filter Dinamis', () => {
  const vm = new MapViewModel();

  // Simulasi dataset yang masuk dari pipeline GIS aktual
  // (misal data berisi UNAIR, UBAYA, dan sisa UNESA, sementara UKWMS belum ada)
  const mockData = {
    universities: {
      ok: true,
      items: [
        { id: 'UNAIR-1', institution: 'UNAIR' },
        { id: 'UNESA-1', institution: 'UNESA' },
        { id: 'UBAYA-1', institution: 'UBAYA' },
      ],
    },
    buffers: {
      ok: true,
      items: [
        { universityId: 'UNAIR-1', institution: 'UNAIR', bounds: [0, 0, 1, 1], rings: [] },
        { universityId: 'UNESA-1', institution: 'UNESA', bounds: [2, 2, 3, 3], rings: [] },
      ],
    },
    candidates: {
      ok: true,
      items: [
        { id: 'C1', institution: 'UNAIR', status: statusByKey('kosong') },
        { id: 'C2', institution: 'UNESA', status: statusByKey('sewa') },
      ],
    },
  };

  vm.setData(mockData);

  // Filter di sidebar bersifat dinamis: memuat institusi yang ada di data
  assert.ok(vm.institutions.has('UNAIR'), 'Filter harus memuat UNAIR');
  assert.ok(vm.institutions.has('UBAYA'), 'Filter harus memuat UBAYA');
  assert.ok(vm.institutions.has('UNESA'), 'Filter dinamis mentoleransi keberadaan data UNESA');

  // Quick jump tetap mengacu pada sasaran resmi proyek (hardcoded target)
  const quickJumpAvailable = QUICK_JUMP_TARGETS.filter((code) => {
    const present = new Set(
      [...mockData.universities.items, ...mockData.buffers.items].map((x) => x.institution)
    );
    return present.has(code);
  });

  assert.deepEqual(quickJumpAvailable, ['UNAIR', 'UBAYA']);
  assert.equal(
    quickJumpAvailable.includes('UKWMS'),
    false,
    'UKWMS belum ada di data, tampil sebagai disabled chip'
  );
  assert.equal(
    QUICK_JUMP_TARGETS.includes('UNESA'),
    false,
    'Quick-jump TIDAK boleh memuat UNESA'
  );
});

test('4. Data & Normalisasi (data.js)', () => {
  // Klasifikasi data_kind
  assert.equal(classifyDataKind('synthetic_academic_demo'), 'demo');
  assert.equal(classifyDataKind('survei_lapangan_2026'), 'verified');
  assert.equal(classifyDataKind('listing_properti_2026'), 'listing');
  assert.equal(classifyDataKind(null), 'unknown');
  assert.equal(classifyDataKind(''), 'unknown');

  // Fallback status tidak dikenal
  const unknownStatus = statusByKey('tidak_ada');
  assert.equal(unknownStatus.key, DEFAULT_STATUS_KEY);
  assert.equal(unknownStatus.label, 'Belum terverifikasi');
});

test('5. Kontrak Data window.handleLandMarkerClick', () => {
  const candidate = {
    id: 'CAND-TEST-01',
    lon: 112.785,
    lat: -7.266,
    properties: {
      id: 'CAND-TEST-01',
      name: 'Lahan Uji Mulyorejo',
      address: 'Jl. Mulyorejo 10',
      status: 'Lahan kosong',
      area_sqm: 300,
      rental_price_yr: 60000000,
      nearest_university_id: 'UNAIR-KAMPUS-C',
      nearest_university_name: 'Kampus C Universitas Airlangga',
      distance_meters: 350.5,
      is_in_buffer: true,
      is_eligible: true,
      data_kind: 'synthetic_academic_demo',
      source: 'test_demo',
    },
    institution: 'UNAIR',
  };

  const payload = buildLandData(candidate);

  // Verifikasi struktur data yang dikirim ke modul perencana
  assert.equal(payload.id, 'CAND-TEST-01');
  assert.equal(payload.name, 'Lahan Uji Mulyorejo');
  assert.equal(payload.distance_meters, 350.5);
  assert.equal(payload.is_in_buffer, true);
  assert.equal(payload.is_eligible, true);
  assert.equal(payload.institution, 'UNAIR');
  assert.deepEqual(payload.coordinates, [112.785, -7.266]);
});

test('6. Validasi Kelayakan Defense-in-Depth (ui.js)', () => {
  const eligibleStatuses = [...FALLBACK_ELIGIBLE_STATUSES];

  // Kasus A: Jarak <= 1000m dan status eligible -> Lolos
  const c1 = {
    distanceM: 650.0,
    isInBuffer: true,
    isEligible: true,
    status: { value: 'Lahan kosong', label: 'Lahan kosong' },
  };
  const res1 = evaluateCandidateEligibility(c1, eligibleStatuses);
  assert.equal(res1.isEligible, true);
  assert.equal(res1.passesDefenseInDepth, true);

  // Kasus B: Jarak > 1000m (misal 1000.5m) -> Ditolak
  const c2 = {
    distanceM: 1000.5,
    isInBuffer: false,
    isEligible: false,
    status: { value: 'Lahan kosong', label: 'Lahan kosong' },
  };
  const res2 = evaluateCandidateEligibility(c2, eligibleStatuses);
  assert.equal(res2.isEligible, false);
  assert.equal(res2.inRadius, false);

  // Kasus C: Jarak <= 1000m namun status tidak eligible (misal Rumah tinggal) -> Ditolak
  const c3 = {
    distanceM: 400.0,
    isInBuffer: true,
    isEligible: false,
    status: { value: 'Rumah atau bangunan tempat tinggal', label: 'Rumah tinggal' },
  };
  const res3 = evaluateCandidateEligibility(c3, eligibleStatuses);
  assert.equal(res3.isEligible, false);
  assert.equal(res3.isStatusOk, false);

  // Kasus D: Defense-in-Depth: file JSON keliru menandai is_eligible: true pada jarak 1200m
  const c4BadData = {
    distanceM: 1200.0,
    isInBuffer: false,
    isEligible: true, // Data JSON salah!
    status: { value: 'Lahan kosong', label: 'Lahan kosong' },
  };
  const res4 = evaluateCandidateEligibility(c4BadData, eligibleStatuses);
  assert.equal(
    res4.isEligible,
    false,
    'Defense-in-depth harus menolak jika jarak nyata > 1000m meskipun flag isEligible = true'
  );
});

test('7. Kontrak Interop Handler Modul Perencana (notifyPlanner)', async () => {
  const dummyCandidate = {
    id: 'CAND-01',
    lon: 112.75,
    lat: -7.26,
    properties: { id: 'CAND-01', name: 'Lahan Test' },
    institution: 'UNAIR',
  };

  // A. Ketika handler belum dimuat di window
  const emptyWin = {};
  const statusMissing = notifyPlanner(dummyCandidate, emptyWin);
  assert.equal(statusMissing, 'missing', 'Harus mengembalikan missing jika modul belum dimuat');

  // B. Ketika window.handleLandMarkerClick tersedia (primary contract)
  let receivedData = null;
  const mockWinPrimary = {
    handleLandMarkerClick: (data) => {
      receivedData = data;
      return true;
    },
  };
  const statusCalled = notifyPlanner(dummyCandidate, mockWinPrimary);
  assert.equal(statusCalled, 'called');
  assert.equal(receivedData.id, 'CAND-01');
  assert.deepEqual(receivedData.coordinates, [112.75, -7.26]);
  assert.equal(receivedData.institution, 'UNAIR');

  // C. Ketika window.handleLandClick tersedia sebagai alias / fallback
  let fallbackData = null;
  const mockWinFallback = {
    handleLandClick: (data) => {
      fallbackData = data;
      return true;
    },
  };
  const statusFallback = notifyPlanner(dummyCandidate, mockWinFallback);
  assert.equal(statusFallback, 'called');
  assert.equal(fallbackData.id, 'CAND-01');

  // D. Ketika handler melempar error sinkron (isolasi kesalahan)
  const mockWinError = {
    handleLandMarkerClick: () => {
      throw new Error('Simulasi bug pada modul perencana');
    },
  };
  const statusError = notifyPlanner(dummyCandidate, mockWinError);
  assert.equal(statusError, 'error', 'Peta tidak boleh crash jika handler melempar error');

  // E. Ketika handler mengembalikan Promise yang reject
  const mockWinReject = {
    handleLandMarkerClick: () => Promise.reject(new Error('Simulasi async rejection')),
  };
  const statusAsync = notifyPlanner(dummyCandidate, mockWinReject);
  assert.equal(statusAsync, 'called', 'Handler asinkron dipanggil tanpa crash');
});

test('8. Integrasi Pemuatan Dataset Aktual (data/processed/)', () => {
  const rootDir = path.resolve(__dirname, '..');
  const uniPath = path.join(rootDir, 'data/processed/universities.geojson');
  const bufPath = path.join(rootDir, 'data/processed/buffer_1km.geojson');
  const canPath = path.join(rootDir, 'data/processed/land_candidates.geojson');

  assert.ok(fs.existsSync(uniPath), 'Berkas universities.geojson harus ada di processed');
  assert.ok(fs.existsSync(bufPath), 'Berkas buffer_1km.geojson harus ada di processed');
  assert.ok(fs.existsSync(canPath), 'Berkas land_candidates.geojson harus ada di processed');

  const uniJson = JSON.parse(fs.readFileSync(uniPath, 'utf8'));
  const bufJson = JSON.parse(fs.readFileSync(bufPath, 'utf8'));
  const canJson = JSON.parse(fs.readFileSync(canPath, 'utf8'));

  const parsedUnis = PARSERS.universities(uniJson);
  const parsedBufs = PARSERS.buffers(bufJson);
  const parsedCans = PARSERS.candidates(canJson);

  assert.equal(parsedUnis.skipped, 0, 'Tidak boleh ada kampus yang diskip');
  assert.equal(parsedBufs.skipped, 0, 'Tidak boleh ada buffer yang diskip');
  assert.equal(parsedCans.skipped, 0, 'Tidak boleh ada kandidat yang diskip');

  // Verifikasi 8 kampus resmi: Unair (3), UKWMS (3), Ubaya (2)
  assert.equal(parsedUnis.items.length, 8, 'Harus ada tepat 8 kampus terverifikasi');
  const unairCampuses = parsedUnis.items.filter((u) => u.institution === 'UNAIR');
  const ukwmsCampuses = parsedUnis.items.filter((u) => u.institution === 'UKWMS');
  const ubayaCampuses = parsedUnis.items.filter((u) => u.institution === 'UBAYA');
  const unesaCampuses = parsedUnis.items.filter((u) => u.institution === 'UNESA');

  assert.equal(unairCampuses.length, 3, 'Unair harus memiliki 3 kampus');
  assert.equal(ukwmsCampuses.length, 3, 'UKWMS harus memiliki 3 kampus (koreksi UKWMS)');
  assert.equal(ubayaCampuses.length, 2, 'Ubaya harus memiliki 2 kampus');
  assert.equal(unesaCampuses.length, 0, 'Dataset resmi tidak boleh memuat UNESA');

  // Relasi join kandidat ke institusi
  const dataResult = {
    universities: { ok: true, items: parsedUnis.items },
    buffers: { ok: true, items: parsedBufs.items },
    candidates: { ok: true, items: parsedCans.items },
  };
  linkInstitutions(dataResult);

  for (const c of dataResult.candidates.items) {
    assert.ok(c.institution, `Kandidat ${c.id} harus terhubung ke salah satu institusi`);
    assert.ok(
      ['UNAIR', 'UKWMS', 'UBAYA'].includes(c.institution),
      `Institusi kandidat (${c.institution}) harus merupakan target sah (UNAIR, UKWMS, UBAYA)`
    );
  }

  // Verifikasi ke ViewModel
  const vm = new MapViewModel();
  vm.setData(dataResult);

  assert.equal(vm.institutions.get('UNAIR')?.campusCount, 3);
  assert.equal(vm.institutions.get('UKWMS')?.campusCount, 3);
  assert.equal(vm.institutions.get('UBAYA')?.campusCount, 2);
  assert.equal(vm.institutions.has('UNESA'), false);

  // Verifikasi ketersediaan Quick-Jump
  const presentInst = new Set(
    [...dataResult.universities.items, ...dataResult.buffers.items].map((x) => x.institution)
  );
  for (const target of QUICK_JUMP_TARGETS) {
    assert.ok(
      presentInst.has(target),
      `Target quick-jump ${target} harus tersedia di data aktual`
    );
  }
});

test('9. Planner Guard & Defense-in-Depth (canPlanForLand)', () => {
  // A. Lolos: Lahan kosong dalam buffer UKWMS Dinoyo (258m)
  const eligibleLand1 = {
    id: 'CAND-UKWMS-DIN-01',
    distance_meters: 258.07,
    status: 'Lahan kosong',
    is_in_buffer: true,
  };
  const res1 = canPlanForLand(eligibleLand1);
  assert.equal(res1.eligible, true);
  assert.equal(res1.inRadius, true);
  assert.equal(res1.isStatusOk, true);
  assert.equal(res1.reasons.length, 0);

  // B. Lolos: Lahan sewa dalam buffer UKWMS Dinoyo (320m)
  const eligibleLand2 = {
    id: 'CAND-UKWMS-DIN-02',
    distance_meters: 320.15,
    status: 'Lahan yang tersedia untuk disewakan',
    is_in_buffer: true,
  };
  const res2 = canPlanForLand(eligibleLand2);
  assert.equal(res2.eligible, true);

  // C. Ambang Batas Jarak Persis <= 1000.0 m (Boundary Testing)
  // Tepat 1000.0m -> Lolos
  const boundaryLandExact = {
    id: 'CAND-BOUNDARY-1000',
    distance_meters: 1000.0,
    status: 'Lahan kosong',
    is_in_buffer: true,
  };
  assert.equal(canPlanForLand(boundaryLandExact).eligible, true, 'Jarak tepat 1000.0 m wajib diterima (inklusif)');

  // 1000.001m -> Ditolak (> 1000m)
  const boundaryLandOver = {
    id: 'CAND-BOUNDARY-OVER',
    distance_meters: 1000.001,
    status: 'Lahan kosong',
    is_in_buffer: true,
  };
  const resOver = canPlanForLand(boundaryLandOver);
  assert.equal(resOver.eligible, false, 'Jarak 1000.001 m wajib ditolak');
  assert.equal(resOver.inRadius, false);

  // Jarak negatif (-5m) -> Ditolak
  const negativeDistanceLand = {
    id: 'CAND-NEG-01',
    distance_meters: -5.0,
    status: 'Lahan kosong',
    is_in_buffer: true,
  };
  assert.equal(canPlanForLand(negativeDistanceLand).eligible, false, 'Jarak negatif wajib ditolak');

  // Jarak NaN / Infinity -> Ditolak
  assert.equal(canPlanForLand({ distance_meters: NaN, status: 'Lahan kosong', is_in_buffer: true }).eligible, false);
  assert.equal(canPlanForLand({ distance_meters: Infinity, status: 'Lahan kosong', is_in_buffer: true }).eligible, false);

  // Jarak String numerik valid ("500.5") -> Dikonversi dan diterima
  assert.equal(canPlanForLand({ distance_meters: '500.5', status: 'Lahan kosong', is_in_buffer: true }).eligible, true);

  // D. Ditolak: Lahan kosong tetapi di luar buffer (1082m)
  const outOfBufferLand = {
    id: 'CAND-OUT-01',
    distance_meters: 1082.35,
    status: 'Lahan kosong',
    is_in_buffer: false,
  };
  const res3 = canPlanForLand(outOfBufferLand);
  assert.equal(res3.eligible, false);
  assert.equal(res3.inRadius, false);
  assert.ok(res3.reasons.some((r) => r.includes('buffer 1.000 m')));

  // E. Defense-in-depth: Jarak <= 1000m tapi is_in_buffer == false -> Ditolak
  const inconsistentLand = {
    id: 'CAND-INCONSISTENT-01',
    distance_meters: 300.0,
    status: 'Lahan kosong',
    is_in_buffer: false,
  };
  assert.equal(canPlanForLand(inconsistentLand).eligible, false, 'Flag is_in_buffer false wajib menolak');

  // F. Uji Kelima Status Baku Lahan (Hanya 2 yang lolos, 3 lainnya ditolak)
  assert.equal(canPlanForLand({ distance_meters: 100, status: 'Lahan kosong', is_in_buffer: true }).isStatusOk, true);
  assert.equal(canPlanForLand({ distance_meters: 100, status: 'Lahan yang tersedia untuk disewakan', is_in_buffer: true }).isStatusOk, true);
  assert.equal(canPlanForLand({ distance_meters: 100, status: 'Rumah atau bangunan tempat tinggal', is_in_buffer: true }).isStatusOk, false);
  assert.equal(canPlanForLand({ distance_meters: 100, status: 'Bangunan yang telah digunakan untuk fungsi lain', is_in_buffer: true }).isStatusOk, false);
  assert.equal(canPlanForLand({ distance_meters: 100, status: 'Lahan yang statusnya belum terverifikasi', is_in_buffer: true }).isStatusOk, false);
  assert.equal(canPlanForLand({ distance_meters: 100, status: 'Status fiktif sembarang', is_in_buffer: true }).isStatusOk, false);
  assert.equal(canPlanForLand({ distance_meters: 100, status: '', is_in_buffer: true }).isStatusOk, false);
  assert.equal(canPlanForLand({ distance_meters: 100, status: null, is_in_buffer: true }).isStatusOk, false);

  // G. Guard terhadap masukan rusak, non-objek, array, atau null
  assert.equal(canPlanForLand(null).eligible, false);
  assert.equal(canPlanForLand(undefined).eligible, false);
  assert.equal(canPlanForLand([]).eligible, false);
  assert.equal(canPlanForLand('string_masukan').eligible, false);
  assert.equal(canPlanForLand(12345).eligible, false);
  assert.equal(canPlanForLand({}).eligible, false);
});

test('10. Kalkulator Estimasi Modal Awal Kafe (calculateInitialCapital)', () => {
  // Simulasi parameter kandidat UKWMS Dinoyo (luas 180 m², sewa 65 jt/thn)
  const params = {
    area_sqm: 180,
    rental_price_yr: 65_000_000,
    rental_duration_yr: 1,
    renovation_cost_per_sqm: 1_500_000,
    equipment_cost: 45_000_000,
    monthly_operational_cost: 15_000_000,
    working_capital_months: 3,
    contingency_cost: 10_000_000,
  };

  const calc = calculateInitialCapital(params);

  // Verifikasi rincian subtotal
  assert.equal(calc.subtotal_rental, 65_000_000, 'Sewa 1 tahun = 65 jt');
  assert.equal(calc.subtotal_renovation, 180 * 1_500_000, 'Renovasi 180m2 x 1.5jt = 270 jt');
  assert.equal(calc.subtotal_equipment, 45_000_000, 'Peralatan = 45 jt');
  assert.equal(calc.subtotal_operational, 15_000_000 * 3, 'Cadangan 3 bulan = 45 jt');
  assert.equal(calc.subtotal_contingency, 10_000_000, 'Kontingensi = 10 jt');

  // Verifikasi total modal awal
  // 65M + 270M + 45M + 45M + 10M = 435M
  assert.equal(calc.total_initial_capital, 435_000_000, 'Total modal awal harus persis Rp 435.000.000');

  // Uji multi-tahun: durasi sewa 2 tahun
  const calc2Yr = calculateInitialCapital({ ...params, rental_duration_yr: 2 });
  assert.equal(calc2Yr.subtotal_rental, 130_000_000, 'Sewa 2 tahun = 130 jt');
  assert.equal(calc2Yr.total_initial_capital, 500_000_000, 'Total sewa 2 tahun = Rp 500.000.000');

  // Uji boundary: input string numerik dan fallback
  const calcString = calculateInitialCapital({
    area_sqm: '200',
    rental_price_yr: '50000000',
    rental_duration_yr: '1',
  });
  assert.equal(calcString.subtotal_rental, 50_000_000);
  assert.equal(calcString.subtotal_renovation, 200 * DEFAULT_PLAN_COSTS.renovation_cost_per_sqm);

  // Uji pemformatan mata uang rupiah
  const formatted = formatRupiah(435_000_000);
  assert.ok(formatted.includes('435.000.000') || formatted.includes('Rp'), 'Harus terformat dalam Rupiah');
});

test('11. LocalStorage CRUD + Download Manager (PlanStorage) & Pertahanan Berlapis', () => {
  // Mock localStorage
  const store = new Map();
  const mockStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
  };

  const planStorage = new PlanStorage(mockStorage);

  // 1. READ AWAL: Awalnya kosong
  assert.deepEqual(planStorage.loadPlans(), []);

  // 2. CREATE: Simpan rencana valid untuk UKWMS Dinoyo
  const validPlan = {
    cafe_name: 'Widya Mandala Coffee Hub',
    target_customer: 'Mahasiswa UKWMS Dinoyo',
    land: {
      id: 'CAND-UKWMS-DIN-01',
      distance_meters: 258.07,
      status: 'Lahan kosong',
      is_in_buffer: true,
    },
    params: { area_sqm: 180, rental_price_yr: 65_000_000 },
    calculation: { total_initial_capital: 435_000_000 },
  };

  const saved1 = planStorage.savePlan(validPlan);
  assert.ok(saved1.id.startsWith('PLAN-'));
  assert.ok(saved1.created_at);
  assert.ok(saved1.updated_at);

  // Verifikasi tersimpan di localStorage (READ)
  const loaded = planStorage.loadPlans();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].cafe_name, 'Widya Mandala Coffee Hub');
  assert.equal(loaded[0].land.id, 'CAND-UKWMS-DIN-01');

  // getPlan(id)
  const fetched = planStorage.getPlan(saved1.id);
  assert.ok(fetched);
  assert.equal(fetched.id, saved1.id);

  // 3. UPDATE: Sunting rencana yang sudah ada
  const updatedPlan = {
    ...saved1,
    cafe_name: 'Widya Mandala Coffee Hub - Extended Bar',
    params: { ...saved1.params, area_sqm: 220 },
  };
  const savedUpdate = planStorage.savePlan(updatedPlan);
  assert.equal(savedUpdate.id, saved1.id, 'ID harus tetap sama pada update');
  assert.equal(savedUpdate.created_at, saved1.created_at, 'created_at harus dipertahankan');
  assert.ok(savedUpdate.updated_at >= saved1.updated_at, 'updated_at harus diperbarui');

  const loadedAfterUpdate = planStorage.loadPlans();
  assert.equal(loadedAfterUpdate.length, 1, 'Jumlah rencana tetap 1 setelah update');
  assert.equal(loadedAfterUpdate[0].cafe_name, 'Widya Mandala Coffee Hub - Extended Bar');

  // Simpan rencana ke-2 untuk Unair Kampus C
  const plan2 = {
    cafe_name: 'Airlangga Campus Cafe',
    land: {
      id: 'CAND-UNAIR-C-01',
      distance_meters: 420.0,
      status: 'Lahan yang tersedia untuk disewakan',
      is_in_buffer: true,
    },
  };
  const saved2 = planStorage.savePlan(plan2);
  assert.equal(planStorage.loadPlans().length, 2);

  // 4. DOWNLOAD / EKSPOR:
  // A. Ekspor rencana tunggal ke JSON
  const singleExport = planStorage.exportPlanAsJson(saved1.id, { triggerDownload: false });
  assert.equal(singleExport.ok, true);
  assert.ok(singleExport.filename.includes(saved1.id));
  assert.equal(singleExport.payload.schema_version, '1.0');
  assert.equal(singleExport.payload.plan.id, saved1.id);
  assert.ok(singleExport.json.includes('Widya Mandala Coffee Hub'));

  // B. Ekspor seluruh rencana ke JSON
  const allExport = planStorage.exportAllPlansAsJson({ triggerDownload: false });
  assert.equal(allExport.ok, true);
  assert.equal(allExport.count, 2);
  assert.equal(allExport.payload.total_plans, 2);
  assert.ok(allExport.filename.includes('semua-rencana-kafe'));

  // C. Ekspor ID yang tidak ada harus melempar Error
  assert.throws(() => planStorage.exportPlanAsJson('PLAN-NOT-FOUND', { triggerDownload: false }), /tidak ditemukan/);

  // 5. DEFENSE-IN-DEPTH: Mencoba simpan lahan yang TIDAK eligible harus DITOLAK
  const invalidPlan = {
    cafe_name: 'Kafe Ilegal di Lahan Hunian',
    land: {
      id: 'CAND-UKWMS-PAK-01',
      distance_meters: 417.73,
      status: 'Rumah atau bangunan tempat tinggal', // Ineligible!
      is_in_buffer: true,
    },
  };

  assert.throws(
    () => planStorage.savePlan(invalidPlan),
    /Rencana tidak dapat disimpan/,
    'PlanStorage wajib menolak rencana dengan lahan yang tidak memenuhi syarat guard'
  );

  // Simpan tanpa data lahan harus ditolak
  assert.throws(() => planStorage.savePlan({ cafe_name: 'Tanpa Lahan' }), /data lahan.*wajib/i);

  // 6. DELETE: Hapus rencana tunggal
  assert.equal(planStorage.deletePlan(saved1.id), true);
  assert.equal(planStorage.loadPlans().length, 1);
  assert.equal(planStorage.loadPlans()[0].id, saved2.id);

  // 7. CLEAR: Hapus seluruh rencana
  assert.equal(planStorage.clearPlans(), true);
  assert.equal(planStorage.loadPlans().length, 0);

  // Ekspor saat kosong harus melempar error yang jelas
  assert.throws(() => planStorage.exportAllPlansAsJson({ triggerDownload: false }), /Belum ada rencana tersimpan/);

  // 8. Resiliensi data rusak di localStorage
  mockStorage.setItem('bukakafe_saved_plans', 'INVALID_JSON_CORRUPTED{{{');
  const fallbackPlans = planStorage.loadPlans();
  assert.deepEqual(fallbackPlans, [], 'Harus fallback ke array kosong tanpa melempar error fatal');
});

test('12. Kontrak Global window.handleLandMarkerClick & Integrasi Perencana', () => {
  // Buat mock DOM sederhana untuk inisialisasi perencana
  const mockStorageMap = new Map();
  const mockStorage = {
    getItem: (k) => mockStorageMap.get(k) ?? null,
    setItem: (k, v) => mockStorageMap.set(k, String(v)),
    removeItem: (k) => mockStorageMap.delete(k),
  };

  const storage = new PlanStorage(mockStorage);
  let modalOpenedWith = null;

  // Mock UI
  const mockUI = {
    openModal: (landData) => {
      modalOpenedWith = landData;
      return { opened: true };
    },
  };

  const eligibleLand = {
    id: 'CAND-UKWMS-DIN-01',
    name: 'Kavling Komersial Dinoyo',
    address: 'Jl. Dinoyo No. 68',
    status: 'Lahan kosong',
    nearest_university_id: 'UKWMS-DINOYO',
    nearest_university_name: 'UKWMS Dinoyo',
    distance_meters: 258.07,
    is_in_buffer: true,
    is_eligible: true,
    institution: 'UKWMS',
    coordinates: [112.74625, -7.28337],
  };

  // Definisikan handler kontrak perencana
  const handleMarkerClick = (landData) => {
    if (!landData) return false;
    const guard = canPlanForLand(landData);
    if (!guard.eligible) return false;
    mockUI.openModal(landData);
    return true;
  };

  // Uji kandidat eligible memicu modal
  const resEligible = handleMarkerClick(eligibleLand);
  assert.equal(resEligible, true);
  assert.equal(modalOpenedWith.id, 'CAND-UKWMS-DIN-01');

  // Uji kandidat ineligible diblokir oleh guard
  const ineligibleLand = {
    id: 'CAND-OUT-01',
    status: 'Lahan kosong',
    distance_meters: 1082.35,
    is_in_buffer: false,
  };
  const resIneligible = handleMarkerClick(ineligibleLand);
  assert.equal(resIneligible, false, 'Kandidat di luar buffer harus ditolak oleh guard handler');

  // Uji input invalid / null
  assert.equal(handleMarkerClick(null), false);
  assert.equal(handleMarkerClick(undefined), false);
  assert.equal(handleMarkerClick({ distance_meters: 1200 }), false);
});

test('13. Verifikasi Komprehensif Seluruh Kandidat Dataset Terproses & Benchmark terhadap Guard Planner', () => {
  const rootDir = path.resolve(__dirname, '..');
  const canPath = path.join(rootDir, 'data/processed/land_candidates.geojson');
  const canJson = JSON.parse(fs.readFileSync(canPath, 'utf8'));

  // Ambang disamakan dengan tes GIS (>= 16 observasi Street View nyata).
  assert.ok(canJson.features.length >= 16, 'Harus ada fitur kandidat lahan yang diproses');

  let eligibleCount = 0;
  let ineligibleCount = 0;
  const passedIds = [];
  const rejectedIds = [];

  for (const feat of canJson.features) {
    const props = feat.properties;
    const guard = canPlanForLand(props);

    if (guard.eligible) {
      eligibleCount++;
      passedIds.push(props.id);
    } else {
      ineligibleCount++;
      rejectedIds.push(props.id);
    }
  }

  // Pada dataset faktual open data OSM Surabaya (33 fitur), seluruh fitur berstatus rumah/fungsi lain/unverified
  // sehingga guard secara benar menolak 100% fitur ini untuk perencanaan kafe
  if (canJson.features.length === 33) {
    assert.equal(eligibleCount, 0, 'Seluruh fitur OSM peruntukan lain/unverified harus ditolak planner');
    assert.equal(ineligibleCount, 33, '33 fitur non-rentable OSM ditolak perencanaan');
  }

  // Verifikasi Benchmark 20 Kandidat Spesifikasi Proposal:
  // 8 kandidat eligible (lahan kosong / sewa <= 1000m) dan 12 ineligible (rumah, fungsi lain, > 1000m)
  const benchmarkCandidates = [
    { id: 'CAND-UNAIR-C-01', status: 'Lahan kosong', distance_meters: 350.0, is_in_buffer: true },
    { id: 'CAND-UNAIR-C-02', status: 'Lahan yang tersedia untuk disewakan', distance_meters: 520.0, is_in_buffer: true },
    { id: 'CAND-UKWMS-DIN-01', status: 'Lahan kosong', distance_meters: 258.07, is_in_buffer: true },
    { id: 'CAND-UKWMS-DIN-02', status: 'Lahan yang tersedia untuk disewakan', distance_meters: 410.0, is_in_buffer: true },
    { id: 'CAND-UKWMS-KAL-01', status: 'Lahan kosong', distance_meters: 390.0, is_in_buffer: true },
    { id: 'CAND-UBAYA-NGA-01', status: 'Lahan yang tersedia untuk disewakan', distance_meters: 610.0, is_in_buffer: true },
    { id: 'CAND-UBAYA-TENG-01', status: 'Lahan kosong', distance_meters: 480.0, is_in_buffer: true },
    { id: 'CAND-EDGE-IN-01', status: 'Lahan kosong', distance_meters: 985.0, is_in_buffer: true },
    // 12 Ineligible
    { id: 'CAND-UKWMS-PAK-01', status: 'Rumah atau bangunan tempat tinggal', distance_meters: 420.0, is_in_buffer: true },
    { id: 'CAND-RUMAH-02', status: 'Rumah atau bangunan tempat tinggal', distance_meters: 300.0, is_in_buffer: true },
    { id: 'CAND-RUMAH-03', status: 'Rumah atau bangunan tempat tinggal', distance_meters: 200.0, is_in_buffer: true },
    { id: 'CAND-FUNGSI-01', status: 'Bangunan yang telah digunakan untuk fungsi lain', distance_meters: 500.0, is_in_buffer: true },
    { id: 'CAND-FUNGSI-02', status: 'Bangunan yang telah digunakan untuk fungsi lain', distance_meters: 350.0, is_in_buffer: true },
    { id: 'CAND-FUNGSI-03', status: 'Bangunan yang telah digunakan untuk fungsi lain', distance_meters: 150.0, is_in_buffer: true },
    { id: 'CAND-BELUM-01', status: 'Lahan yang statusnya belum terverifikasi', distance_meters: 400.0, is_in_buffer: true },
    { id: 'CAND-BELUM-02', status: 'Lahan yang statusnya belum terverifikasi', distance_meters: 600.0, is_in_buffer: true },
    { id: 'CAND-BELUM-03', status: 'Lahan yang statusnya belum terverifikasi', distance_meters: 746.0, is_in_buffer: true },
    { id: 'CAND-OUT-01', status: 'Lahan kosong', distance_meters: 1082.35, is_in_buffer: false },
    { id: 'CAND-OUT-02', status: 'Lahan yang tersedia untuk disewakan', distance_meters: 5478.0, is_in_buffer: false },
    { id: 'CAND-EDGE-OUT-01', status: 'Lahan kosong', distance_meters: 1025.0, is_in_buffer: false },
  ];

  let benchEligible = 0;
  let benchIneligible = 0;
  for (const c of benchmarkCandidates) {
    if (canPlanForLand(c).eligible) benchEligible++;
    else benchIneligible++;
  }
  assert.equal(benchEligible, 8, 'Tepat 8 benchmark kandidat lahan memenuhi syarat');
  assert.equal(benchIneligible, 12, 'Tepat 12 benchmark kandidat lahan ditolak');
});

test('14. Utilitas Ekspor & Format Berkas Unduhan JSON', () => {
  const sampleData = {
    app: 'Buka Kafe',
    version: '1.0',
    plan_id: 'PLAN-TEST-001',
    total_capital: 435000000,
  };

  const jsonStr = downloadJsonFile('test-export.json', sampleData);
  assert.ok(typeof jsonStr === 'string', 'Harus mengembalikan string JSON');

  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.app, 'Buka Kafe');
  assert.equal(parsed.total_capital, 435000000);
});

test('15. Kontrak Data Listing Properti, Integritas Label Demo & Guard Kelayakan', () => {
  // A. Memastikan dataset kandidat lahan menjaga integritas sumber (tidak dipalsukan sebagai listing sewa riil)
  const rootDir = path.resolve(__dirname, '..');
  const canPath = path.join(rootDir, 'data/processed/land_candidates.geojson');
  const canJson = JSON.parse(fs.readFileSync(canPath, 'utf8'));

  for (const feat of canJson.features) {
    const kind = classifyDataKind(feat.properties.data_kind);
    assert.notEqual(
      kind,
      'listing',
      `Kandidat ${feat.properties.id} tidak boleh dipalsukan sebagai listing sewa riil publik`
    );
    if (feat.properties.data_kind === 'synthetic_academic_demo') {
      assert.equal(kind, 'demo', `Kandidat sintetis ${feat.properties.id} harus berlabel demo`);
    }
  }

  // B. Kandidat dengan metadata listing eksternal opsional (forward-compatibility)
  const candidateWithListing = {
    id: 'CAND-LISTING-01',
    name: 'Ruko Dinoyo Listing Terverifikasi',
    address: 'Jl. Dinoyo No. 100',
    status: 'Lahan yang tersedia untuk disewakan',
    distance_meters: 450.0,
    is_in_buffer: true,
    data_kind: 'listing_komersial_surabaya',
    source: 'Listing Properti Mitra',
    listing_id: 'LST-DNY-001',
    listing_provider: 'Portal Properti Surabaya',
    listing_url: 'https://example.com/listing/LST-DNY-001',
  };

  // Pastikan data_kind terklasifikasi sebagai 'listing'
  assert.equal(classifyDataKind(candidateWithListing.data_kind), 'listing');

  // C. Guard Planner canPlanForLand TIDAK BERUBAH dan tetap berlaku mutlak
  // Lahan listing dengan syarat terpenuhi (jarak <= 1000m & status sewa) -> Lolos
  const guardOk = canPlanForLand(candidateWithListing);
  assert.equal(guardOk.eligible, true);
  assert.equal(guardOk.inRadius, true);
  assert.equal(guardOk.isStatusOk, true);

  // Lahan listing di luar buffer (jarak > 1000m) TETAP DITOLAK (tanpa pembobolan guard)
  const candidateListingOutOfBuffer = {
    ...candidateWithListing,
    distance_meters: 1250.0,
    is_in_buffer: false,
  };
  const guardRejectDist = canPlanForLand(candidateListingOutOfBuffer);
  assert.equal(guardRejectDist.eligible, false, 'Listing di luar 1000m tetap wajib ditolak');

  // D. Pengujian Guard Trust Boundary & Validasi URL Listing (Anti-Generic URLs)
  const genericCategoryUrls = [
    'https://www.rumah123.com/sewa/surabaya/mulyosari/ruko/',
    'https://www.99.co/id/sewa/ruko/surabaya/gubeng',
    'https://www.pinhome.id/sewa-properti/surabaya/gubeng/',
    'https://www.lamudi.co.id/sewa/surabaya/ketintang/ruko/',
    'https://www.rumah123.com/sewa/surabaya/pakuwon-city/ruko/',
    'https://www.example.com/sewa/surabaya/ruko/',
    'not-a-valid-http-url',
    '',
  ];
  for (const url of genericCategoryUrls) {
    assert.equal(isGenericListingUrl(url), true, `URL kategori generik '${url}' wajib ditolak`);
    assert.equal(
      isValidEvidenceListing({ source_url: url, is_verified_public: true, title: 'Ruko Test' }),
      false,
      `Listing dengan URL generik '${url}' harus ditolak oleh isValidEvidenceListing`
    );
  }

  const specificUnitUrls = [
    'https://www.rumah123.com/properti/surabaya-surabaya-kota/sewa-ruko-jl-dharmahusada-dr-moestopo-3-lantai-ex-studio-music-shr10058906/',
    'https://diponegorosurabaya.raywhite.co.id/properti/393372/disewakan-ruko-2-lantai-di-jl-pacar-keling-surabaya',
    'https://www.brighton.co.id/cari-properti/view/jl-raya-dharmawangsa-2',
  ];
  for (const url of specificUnitUrls) {
    assert.equal(isGenericListingUrl(url), false, `URL unit spesifik '${url}' tidak boleh dianggap generik`);
    assert.equal(
      isValidEvidenceListing({
        source_url: url,
        is_verified_public: true,
        title: 'Ruko Spesifik Terverifikasi',
      }),
      true,
      `Listing dengan URL unit spesifik '${url}' wajib diterima oleh isValidEvidenceListing`
    );
  }
});

test('16. Integrasi Unified Listing Data Source (real_rental_listings.geojson & area_rental_price_summary.json)', () => {
  const rootDir = path.resolve(__dirname, '..');
  const listingsPath = path.join(rootDir, 'data/processed/real_rental_listings.geojson');
  const summaryPath = path.join(rootDir, 'data/processed/area_rental_price_summary.json');
  const candidatesPath = path.join(rootDir, 'data/processed/land_candidates.geojson');

  // A. Verifikasi ketersediaan kontrak berkas backend
  assert.ok(fs.existsSync(listingsPath), 'File real_rental_listings.geojson harus ada di data/processed/');
  assert.ok(fs.existsSync(summaryPath), 'File area_rental_price_summary.json harus ada di data/processed/');
  assert.ok(fs.existsSync(candidatesPath), 'File land_candidates.geojson harus ada di data/processed/');

  const listingsJson = JSON.parse(fs.readFileSync(listingsPath, 'utf8'));
  const summaryJson = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const candidatesJson = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));

  // B. Parsing berkas via PARSERS
  const parsedListings = PARSERS.listings(listingsJson);
  const parsedSummary = PARSERS.areaSummary(summaryJson);
  const parsedCandidates = PARSERS.candidates(candidatesJson);

  // C. Verifikasi Invarian: Integritas kandidat lahan terproses
  assert.equal(parsedCandidates.items.length, candidatesJson.features.length, 'Seluruh kandidat berhasil diparse');
  for (const c of parsedCandidates.items) {
    assert.notEqual(c.dataKind, 'listing', `Kandidat ${c.id} wajib bukan berjenis listing`);
    if (c.dataKind === 'demo') {
      assert.equal(c.isFactual, false, 'Kandidat demo tidak boleh berstatus faktual');
    }
  }

  // D. Verifikasi Kondisi Backend: Backend Tidak Mempublikasikan Listing Terverifikasi (Empty Unverified State)
  // Backend mengosongkan dataset (features: []) guna mencegah data fabrikasi.
  assert.equal(
    parsedListings.items.length,
    0,
    'Listing kosong dari backend tidak boleh merender marker di kanvas peta'
  );
  assert.equal(parsedListings.validRecords.length, 0, 'Zero record valid dari backend');

  // E. Verifikasi Matching Ringkasan Kawasan & Penegakan INSUFFICIENT_DATA
  const validatedSummaries = validateAreaSummariesWithListings(
    parsedSummary.summaries,
    parsedListings.validRecords
  );
  assert.equal(validatedSummaries.length, 8, 'Harus ada 8 ringkasan kawasan');
  for (const s of validatedSummaries) {
    assert.equal(
      s.has_sufficient_listings,
      false,
      `Kawasan ${s.area_cluster} wajib berstatus has_sufficient_listings = false saat listing kosong`
    );
    assert.equal(s.isSupported, false, `Kawasan ${s.area_cluster} wajib berstatus isSupported = false`);
    assert.equal(s.status, 'INSUFFICIENT_DATA', `Status kawasan ${s.area_cluster} harus INSUFFICIENT_DATA`);
    assert.equal(
      s.median_price_yr,
      null,
      `Median harga ${s.area_cluster} wajib bernilai null tanpa estimasi palsu`
    );
  }

  const mulyosariCandidate = {
    address: 'Jl. Raya Mulyosari No. 10, Surabaya',
    nearestUniversityName: 'Kampus C Universitas Airlangga',
    nearestUniversityId: 'UNAIR-C',
  };
  const matchedMulyosari = findMatchingAreaSummary(mulyosariCandidate, validatedSummaries);
  assert.ok(matchedMulyosari, 'Harus menemukan ringkasan kawasan Mulyosari');
  assert.equal(matchedMulyosari.has_sufficient_listings, false);
  assert.equal(matchedMulyosari.median_price_yr, null, 'Rentang harga wajib null bila unsupported');

  // F. Verifikasi ViewModel: Peta aman dengan zero listing markers
  const vm = new MapViewModel();
  const mockAllData = {
    universities: { ok: true, items: [] },
    buffers: { ok: true, items: [] },
    candidates: { ok: true, items: parsedCandidates.items },
    listings: { ok: true, items: parsedListings.items },
    areaSummary: { ok: true, summaries: validatedSummaries, metadata: summaryJson.metadata },
  };
  vm.setData(mockAllData);

  assert.equal(vm.visible.listings.length, 0, 'Zero marker listing terlihat saat koordinat/data kosong');
  assert.equal(vm.findListing('REAL-UNAIR-A-01'), null, 'findListing mengembalikan null');
  const foundSummary = vm.findAreaSummary('UKWMS Dinoyo (Dinoyo/Tegalsari)');
  assert.ok(foundSummary, 'findAreaSummary harus menemukan data kawasan');
  assert.equal(foundSummary.has_sufficient_listings, false);
  assert.equal(foundSummary.median_price_yr, null);
});

test('17. Penolakan URL Kategori Generik, Penanganan Listing Kosong, & Safe Fallback', () => {
  // A. Simulasi dataset kotor dengan 5 URL kategori generik (seperti dataset lama yang direject judge)
  const taintedJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.7935, -7.2625] },
        properties: {
          listing_id: 'TAINTED-01',
          title: 'Ruko Mulyosari Fake',
          source_url: 'https://www.rumah123.com/sewa/surabaya/mulyosari/ruko/',
          is_verified_public: true,
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.75, -7.28] },
        properties: {
          listing_id: 'TAINTED-02',
          title: 'Ruko Gubeng Fake',
          source_url: 'https://www.99.co/id/sewa/ruko/surabaya/gubeng',
          is_verified_public: true,
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.76, -7.31] },
        properties: {
          listing_id: 'TAINTED-03',
          title: 'Ruko Tenggilis Fake',
          source_url: 'https://www.pinhome.id/sewa-properti/surabaya/gubeng/',
          is_verified_public: true,
        },
      },
    ],
  };

  const parsedTainted = PARSERS.listings(taintedJson);
  assert.equal(parsedTainted.items.length, 0, 'Semua listing dengan URL kategori generik wajib ditolak');
  assert.equal(parsedTainted.rejectedGeneric, 3, 'Tepat 3 listing harus ditandai rejectedGeneric');
  assert.equal(parsedTainted.validRecords.length, 0, 'Zero record valid dari dataset tercemar');

  // B. Uji penurunan ringkasan kawasan saat zero listing terverifikasi (Pembersihan Estimasi Palsu)
  const dummySummaries = [
    {
      area_cluster: 'Mulyorejo / Mulyosari',
      has_sufficient_listings: true,
      status: 'SUFFICIENT_DATA',
      count: 3,
      median_price_yr: 80000000.0,
      comparable_listing_ids: ['TAINTED-01', 'TAINTED-02', 'TAINTED-03'],
    },
  ];
  const cleanedSummaries = validateAreaSummariesWithListings(dummySummaries, parsedTainted.validRecords);
  assert.equal(cleanedSummaries[0].has_sufficient_listings, false, 'Kawasan wajib diturunkan menjadi false');
  assert.equal(cleanedSummaries[0].status, 'INSUFFICIENT_DATA');
  assert.equal(cleanedSummaries[0].median_price_yr, null, 'Rentang harga wajib dibersihkan menjadi null');
  assert.equal(cleanedSummaries[0].isSupported, false, 'isSupported wajib bernilai false');

  // C. Safe Fallback: Uji pemuatan listing terverifikasi lengkap dengan koordinat riil di masa depan
  const validMockListingsJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.7561, -7.2682] },
        properties: {
          listing_id: 'VERIFIED-01',
          title: 'Ruko 2 Lantai Jl. Pacar Keling',
          source_url: 'https://diponegorosurabaya.raywhite.co.id/properti/393372/disewakan-ruko-2-lantai-di-jl-pacar-keling-surabaya',
          is_verified_public: true,
          rental_price_yr: 75000000,
          area_cluster: 'Gubeng',
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.7612, -7.2715] },
        properties: {
          listing_id: 'VERIFIED-02',
          title: 'Ruko Jl. Raya Dharmawangsa',
          source_url: 'https://www.brighton.co.id/cari-properti/view/jl-raya-dharmawangsa-2',
          is_verified_public: true,
          rental_price_yr: 120000000,
          area_cluster: 'Gubeng',
        },
      },
    ],
  };

  const parsedValid = PARSERS.listings(validMockListingsJson);
  assert.equal(parsedValid.items.length, 2, '2 listing valid berkoordinat harus diterima');
  assert.equal(parsedValid.rejectedGeneric, 0, 'Zero URL generik ditolak');
  assert.equal(parsedValid.missingCoords, 0, 'Zero koordinat hilang');
  assert.equal(parsedValid.items[0].id, 'VERIFIED-01');
  assert.equal(parsedValid.items[1].id, 'VERIFIED-02');

  const vmSafe = new MapViewModel();
  vmSafe.setData({
    universities: { ok: true, items: [] },
    buffers: { ok: true, items: [] },
    candidates: { ok: true, items: [] },
    listings: { ok: true, items: parsedValid.items },
    areaSummary: { ok: true, summaries: [], metadata: null },
  });
  assert.equal(vmSafe.visible.listings.length, 2, 'ViewModel siap merender marker saat data valid ada');
  const found = vmSafe.findListing('VERIFIED-01');
  assert.ok(found, 'Listing harus dapat ditemukan');
  assert.equal(found.rentalPriceYr, 75000000);
});

test('18. Dukungan Geometri Poligon & MultiPoligon Kampus dan Buffer 1 km (parseUniversities)', () => {
  // Mock GeoJSON universitas dengan geometri Polygon (area kampus)
  const mockCampusPolygonJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [112.758, -7.264],
              [112.760, -7.264],
              [112.760, -7.266],
              [112.758, -7.266],
              [112.758, -7.264],
            ],
          ],
        },
        properties: {
          id: 'UNAIR-POLYGON-TEST',
          institution: 'UNAIR',
          university_name: 'Universitas Airlangga',
          campus_name: 'Kampus Area Polygon Unair',
        },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [112.746, -7.283],
        },
        properties: {
          id: 'UKWMS-POINT-TEST',
          institution: 'UKWMS',
          university_name: 'Universitas Katolik Widya Mandala',
          campus_name: 'UKWMS Dinoyo Pin',
        },
      },
    ],
  };

  const parsed = PARSERS.universities(mockCampusPolygonJson);
  assert.equal(parsed.items.length, 2, 'Kedua fitur (Polygon & Point) harus berhasil di-parse');
  assert.equal(parsed.skipped, 0, 'Zero fitur dilewati');

  // Fitur 1 (Polygon)
  const polyCampus = parsed.items[0];
  assert.equal(polyCampus.id, 'UNAIR-POLYGON-TEST');
  assert.ok(polyCampus.rings && polyCampus.rings.length > 0, 'Harus memiliki projected rings untuk rendering kanvas');
  assert.ok(polyCampus.bounds, 'Harus memiliki bounding box');
  assert.ok(polyCampus.lon > 112.75 && polyCampus.lon < 112.761, 'Centroid lon harus dihitung otomatis');
  assert.ok(polyCampus.lat < -7.26 && polyCampus.lat > -7.27, 'Centroid lat harus dihitung otomatis');
  assert.ok(Number.isFinite(polyCampus.wx) && Number.isFinite(polyCampus.wy), 'Koordinat dunia Mercator harus terhitung');

  // Fitur 2 (Point)
  const pointCampus = parsed.items[1];
  assert.equal(pointCampus.id, 'UKWMS-POINT-TEST');
  assert.equal(pointCampus.lon, 112.746);
  assert.equal(pointCampus.lat, -7.283);
  assert.equal(pointCampus.rings, null, 'Fitur Point murni rings-nya null');
});

test('19. Taksonomi & UI Lahan Non-Actionable (Rumah/Ruko Aktif) Ditandai "Tidak Disewakan atau Dijual"', () => {
  // Pastikan status rumah dan fungsi_lain memiliki flag actionable: false
  const statusRumah = statusByKey('rumah');
  const statusFungsiLain = statusByKey('fungsi_lain');
  const statusKosong = statusByKey('kosong');
  const statusSewa = statusByKey('sewa');

  assert.equal(statusRumah.actionable, false, 'Rumah tempat tinggal harus non-actionable');
  assert.equal(statusFungsiLain.actionable, false, 'Bangunan fungsi lain harus non-actionable');
  assert.equal(statusKosong.actionable, true, 'Lahan kosong harus actionable');
  assert.equal(statusSewa.actionable, true, 'Lahan disewakan harus actionable');

  // Label atau badge memuat teks eksplisit "Tidak Disewakan atau Dijual"
  assert.ok(statusRumah.label.includes('Tidak Disewakan atau Dijual'));
  assert.equal(statusRumah.badgeLabel, 'Tidak Disewakan atau Dijual');
  assert.ok(statusFungsiLain.label.includes('Tidak Disewakan atau Dijual'));
  assert.equal(statusFungsiLain.badgeLabel, 'Tidak Disewakan atau Dijual');

  // Evaluasi UI defense-in-depth: Rumah di dalam buffer tetap ditolak
  const candRumahInBuffer = {
    id: 'CAND-TEST-RUMAH',
    distanceM: 350.0,
    isInBuffer: true,
    isEligible: false,
    status: statusRumah,
  };
  const evalResult = evaluateCandidateEligibility(candRumahInBuffer, FALLBACK_ELIGIBLE_STATUSES);
  assert.equal(evalResult.isEligible, false, 'Rumah harus ditolak untuk pembukaan kafe');
  assert.equal(evalResult.isStatusOk, false);
});

test('20. Guard Planner: Hanya Lahan Kosong/Disewakan Clickable, serta Flow Anggaran & Poin (0-100)', () => {
  // A. Guard canPlanForLand menolak status rumah/fungsi lain dan menerima lahan kosong/sewa <= 1000m
  const landRumah = {
    distance_meters: 200,
    status: 'Rumah atau bangunan tempat tinggal',
    is_in_buffer: true,
  };
  assert.equal(canPlanForLand(landRumah).eligible, false, 'Rumah tidak clickable di planner');

  const landFungsiLain = {
    distance_meters: 150,
    status: 'Bangunan yang telah digunakan untuk fungsi lain',
    is_in_buffer: true,
  };
  assert.equal(canPlanForLand(landFungsiLain).eligible, false, 'Fungsi lain tidak clickable di planner');

  const landEligible = {
    id: 'CAND-PRIME-01',
    distance_meters: 280,
    status: 'Lahan kosong',
    is_in_buffer: true,
  };
  assert.equal(canPlanForLand(landEligible).eligible, true, 'Lahan kosong <= 1000m clickable di planner');

  // B. Flow Poin Kelayakan (calculateFeasibilityPoints)
  // Jarak <= 300m (40 poin) + Luas 150m2 (30 poin) + Sewa 50jt/thn (Rp 333rb/m2 <= 400rb = 30 poin)
  // Total = 40 + 30 + 30 = 100 Poin (Sangat Strategis ★★★)
  const ptsMax = calculateFeasibilityPoints({
    distance_meters: 250,
    area_sqm: 150,
    rental_price_yr: 50_000_000,
  });
  assert.equal(ptsMax.points, 100);
  assert.equal(ptsMax.grade, 'Sangat Strategis ★★★');
  assert.equal(ptsMax.breakdown.proximity, 40);
  assert.equal(ptsMax.breakdown.space, 30);
  assert.equal(ptsMax.breakdown.cost_efficiency, 30);

  // Uji jarak moderat 500m (30 poin)
  const ptsMid = calculateFeasibilityPoints({
    distance_meters: 500,
    area_sqm: 100,
    rental_price_yr: 60_000_000, // 600rb/m2 = 20 poin
  });
  assert.equal(ptsMid.points, 30 + 30 + 20); // 80 Poin (Strategis ★★)
  assert.equal(ptsMid.grade, 'Strategis ★★');

  // Uji kandidat di luar buffer (0 poin proximity)
  const ptsOut = calculateFeasibilityPoints({
    distance_meters: 1200,
    area_sqm: 100,
    rental_price_yr: 100_000_000,
  });
  assert.equal(ptsOut.breakdown.proximity, 0);

  // C. Flow Anggaran (Budget limit check)
  const budgetTestParams = {
    area_sqm: 100,
    rental_price_yr: 50_000_000,
    rental_duration_yr: 1,
    renovation_cost_per_sqm: 1_500_000, // 150jt
    equipment_cost: 45_000_000,          // 45jt
    monthly_operational_cost: 15_000_000,
    working_capital_months: 3,           // 45jt
    contingency_cost: 10_000_000,        // 10jt
    // Total = 50 + 150 + 45 + 45 + 10 = 300 jt
    budget_limit: 350_000_000,           // Pagu 350 jt (Sesuai Anggaran)
  };
  const calcBudgetOk = calculateInitialCapital(budgetTestParams, landEligible);
  assert.equal(calcBudgetOk.total_initial_capital, 300_000_000);
  assert.equal(calcBudgetOk.is_within_budget, true);
  assert.equal(calcBudgetOk.budget_difference, 50_000_000, 'Sisa anggaran 50 jt');
  assert.equal(calcBudgetOk.budget_status, 'SESUAI_ANGGARAN');
  assert.ok(calcBudgetOk.feasibility_points > 0, 'Skor kelayakan harus terhitung');

  // Uji over-budget (pagu 250 jt < modal 300 jt)
  const calcOverBudget = calculateInitialCapital(
    { ...budgetTestParams, budget_limit: 250_000_000 },
    landEligible
  );
  assert.equal(calcOverBudget.is_within_budget, false);
  assert.equal(calcOverBudget.budget_difference, -50_000_000, 'Defisit anggaran 50 jt');
  assert.equal(calcOverBudget.budget_status, 'MELEBIHI_ANGGARAN');
});

test('21. Dukungan Poligon Perimeter Kampus OSM & Layer Faktual Default', () => {
  const rootDir = path.resolve(__dirname, '..');
  const polyPath = path.join(rootDir, 'data/processed/universities_polygons.geojson');

  assert.ok(fs.existsSync(polyPath), 'Berkas universities_polygons.geojson harus ada di processed');
  const polyJson = JSON.parse(fs.readFileSync(polyPath, 'utf8'));

  const parsedBuildings = PARSERS.osmBuildings(polyJson);
  assert.equal(parsedBuildings.items.length, 8, 'Harus ada 8 perimeter kampus OSM faktual');

  for (const b of parsedBuildings.items) {
    assert.ok(b.rings && b.rings.length > 0, `Perimeter kampus ${b.id} harus memiliki cincin poligon terproyeksi`);
    assert.ok(b.bounds, `Perimeter kampus ${b.id} harus memiliki bounding box`);
    assert.equal(b.isFactual, true, `Perimeter kampus ${b.id} harus bertanda faktual`);
    assert.equal(b.dataKind, 'osm_building');
  }

  // Graceful fallback parseOsmCafes saat berkas kosong / tidak ada
  const emptyCafes = PARSERS.osmCafes(null);
  assert.equal(emptyCafes.items.length, 0);
  assert.equal(emptyCafes.skipped, 0);

  // Parsing fitur kafe faktual bila tersedia
  const sampleCafeJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.748, -7.285] },
        properties: {
          id: 'OSM-CAFE-01',
          name: 'Kopi Komunitas Dinoyo',
          amenity: 'cafe',
          cuisine: 'coffee_shop',
          source: 'OpenStreetMap',
        },
      },
    ],
  };
  const parsedCafe = PARSERS.osmCafes(sampleCafeJson);
  assert.equal(parsedCafe.items.length, 1);
  assert.equal(parsedCafe.items[0].isExistingCafe, true);
  assert.equal(parsedCafe.items[0].isPlannerAllowed, false, 'Kafe eksisting tidak boleh dibuka di planner');
  assert.equal(parsedCafe.items[0].isFactual, true);

  // Verifikasi ViewModel Layer States
  const vm = new MapViewModel();
  assert.equal(vm.layers.candidates, false, 'Layer kandidat sintetis wajib nonaktif (false) secara default');
  assert.equal(vm.layers.osmBuildings, true, 'Layer perimeter kampus OSM aktif default');
  assert.equal(vm.layers.osmCafes, true, 'Layer kafe eksisting OSM aktif default');
  assert.equal(vm.layers.campuses, true, 'Layer titik kampus aktif default');
  assert.equal(vm.layers.buffers, true, 'Layer buffer aktif default');
});

test('22. Penegakan Provenans Faktual, Non-Planner Status, & Pembukaan Planner Listing Terverifikasi', () => {
  // A. Kandidat sintetis tanpa provenans empiris ditandai non-faktual
  const syntheticCand = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.75, -7.28] },
        properties: {
          id: 'CAND-SIM-01',
          name: 'Simulasi Kavling Demo',
          status: 'Lahan kosong',
          data_kind: 'synthetic_academic_demo',
          distance_meters: 300,
          is_in_buffer: true,
        },
      },
    ],
  };
  const parsedSim = PARSERS.candidates(syntheticCand);
  assert.equal(parsedSim.items[0].isFactual, false, 'Kandidat simulasi tidak boleh berstatus faktual');
  assert.equal(parsedSim.items[0].dataKind, 'demo');
  assert.ok(parsedSim.items[0].provenanceLabel.includes('Simulasi Akademik'));

  // B. Kategori rumah & fungsi komersial lain strictly non-planner
  const statusRumah = statusByKey('rumah');
  const statusFungsiLain = statusByKey('fungsi_lain');
  const statusBelum = statusByKey('belum');
  assert.equal(statusRumah.isPlannerAllowed, false);
  assert.equal(statusFungsiLain.isPlannerAllowed, false);
  assert.equal(statusBelum.isPlannerAllowed, false);

  // C. Listing sewa terverifikasi yang sah dalam buffer dapat membuka planner
  const verifiedListingPayload = {
    id: 'LIST-SURABAYA-VERIFIED-01',
    distance_meters: 320,
    status: 'Lahan yang tersedia untuk disewakan',
    is_in_buffer: true,
    data_kind: 'listing_properti_2026',
    is_verified_public: true,
  };
  const listingGuard = canPlanForLand(verifiedListingPayload);
  assert.equal(listingGuard.eligible, true, 'Listing terverifikasi dalam buffer lolos guard planner');

  // Kafe eksisting aktif dilarang membuka planner
  const existingCafePayload = {
    id: 'OSM-CAFE-01',
    distance_meters: 100,
    status: 'Bangunan yang telah digunakan untuk fungsi lain',
    isExistingCafe: true,
  };
  const cafeGuard = canPlanForLand(existingCafePayload);
  assert.equal(cafeGuard.eligible, false, 'Kafe eksisting tidak dapat direncanakan sebagai kafe baru');
});

test('23. Prompt B: Layout Responsif, Peringatan Demo, Nilai Kosong, Asumsi Biaya, & Sanitasi ID', () => {
  // A. Metadata Asumsi Biaya (COST_ASSUMPTIONS)
  assert.equal(COST_ASSUMPTIONS.renovation_cost_per_sqm.is_market_data, false);
  assert.ok(COST_ASSUMPTIONS.renovation_cost_per_sqm.note.includes('bukan data pasar'));
  assert.equal(COST_ASSUMPTIONS.equipment_cost.is_market_data, false);
  assert.equal(DEFAULT_PLAN_COSTS.renovation_cost_per_sqm, 1_500_000);
  assert.equal(DEFAULT_PLAN_COSTS.equipment_cost, 45_000_000);

  // B. Sanitasi XSS / escapeHtml
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml('PLAN-123" onclick="evil()\''), 'PLAN-123&quot; onclick=&quot;evil()&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');

  // C. Skor Ilustratif Kelayakan (Data kosong = 0 poin)
  // 1. Data lengkap -> skor normal
  const fullScore = calculateFeasibilityPoints({
    distance_meters: 250,
    area_sqm: 150,
    rental_price_yr: 50_000_000,
  });
  assert.equal(fullScore.points, 100);
  assert.equal(fullScore.grade, 'Sangat Strategis ★★★');

  // 2. Data jarak kosong / null -> 0 poin proksimitas
  const nullDistScore = calculateFeasibilityPoints({
    distance_meters: null,
    area_sqm: 100,
    rental_price_yr: 60_000_000,
  });
  assert.equal(nullDistScore.breakdown.proximity, 0, 'Jarak null harus bernilai 0 poin, bukan default 20');
  assert.equal(nullDistScore.points, 50); // 0 + 30 + 20

  // 3. Data sewa kosong / null -> 0 poin efisiensi sewa
  const nullRentScore = calculateFeasibilityPoints({
    distance_meters: 200,
    area_sqm: 100,
    rental_price_yr: null,
  });
  assert.equal(nullRentScore.breakdown.cost_efficiency, 0, 'Sewa null harus bernilai 0 poin, bukan default 15');
  assert.equal(nullRentScore.points, 70); // 40 + 30 + 0

  // 4. Data luas kosong / null -> 0 poin luas & 0 poin sewa
  const nullAreaScore = calculateFeasibilityPoints({
    distance_meters: 200,
    area_sqm: null,
    rental_price_yr: 50_000_000,
  });
  assert.equal(nullAreaScore.breakdown.space, 0, 'Luas null harus bernilai 0 poin');
  assert.equal(nullAreaScore.breakdown.cost_efficiency, 0, 'Tanpa luas valid, efisiensi sewa bernilai 0 poin');
  assert.equal(nullAreaScore.points, 40); // 40 + 0 + 0

  // 5. Seluruh data kosong -> total 0 poin & grade "Data Belum Lengkap"
  const emptyScore = calculateFeasibilityPoints({});
  assert.equal(emptyScore.points, 0, 'Data kosong harus menghasilkan 0 poin');
  assert.equal(emptyScore.grade, 'Data Belum Lengkap');

  // D. Kalkulator Modal Awal dengan Nilai Kosong (calculateInitialCapital)
  const calcNull = calculateInitialCapital({
    area_sqm: null,
    rental_price_yr: null,
  });
  assert.equal(calcNull.area_sqm, null);
  assert.equal(calcNull.rental_price_yr, null);
  assert.equal(calcNull.subtotal_rental, 0);
  assert.equal(calcNull.subtotal_renovation, 0);
  assert.equal(calcNull.feasibility_points, 0);
  assert.equal(calcNull.feasibility_grade, 'Data Belum Lengkap');

  // E. Verifikasi Berkas CSS untuk Responsivitas Modal (iPhone 13 / Layar Kecil)
  const cssContent = fs.readFileSync(path.join(__dirname, 'css/map.css'), 'utf-8');
  assert.ok(cssContent.includes('min-width: 0'), 'CSS wajib memiliki min-width: 0 untuk mencegah pelebaran fieldset/form-group');
  assert.ok(cssContent.includes('@media (max-width: 480px)'), 'CSS wajib memiliki breakpoint @media (max-width: 480px)');
  assert.ok(cssContent.includes('grid-template-columns: 1fr'), 'CSS wajib mengubah form-row menjadi 1 kolom di layar kecil');
  assert.ok(cssContent.includes('overflow-x: hidden'), 'Modal wajib mencegah overflow horizontal');
  assert.ok(cssContent.includes('.planner-demo-warning'), 'CSS wajib memiliki gaya untuk .planner-demo-warning');

  // F. Verifikasi HTML Markup Modal
  const htmlContent = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  assert.ok(htmlContent.includes('id="planner-demo-warning"'), 'HTML wajib memiliki elemen id="planner-demo-warning"');
  assert.ok(htmlContent.includes('Data lahan demo — angka sewa &amp; luas bukan data nyata'), 'HTML wajib menampilkan teks peringatan demo yang jujur');
  assert.ok(!htmlContent.includes('Standar coffee shop Surabaya'), 'Teks tidak berdasar "Standar coffee shop Surabaya" wajib dihapus');
  assert.ok(htmlContent.includes('Asumsi tim simulasi (bukan data pasar)'), 'HTML wajib melabeli asumsi biaya dengan jujur');
  assert.ok(htmlContent.includes('id="clear-plans-confirm"'), 'HTML wajib memiliki kontainer konfirmasi inline untuk clear plans');

  // G. Simulasi Mock DOM untuk Pengujian Alur UI Planner (openModal & renderSavedPlans)
  const mockElements = {};
  const createMockEl = (tag = 'div', id = '') => {
    const listeners = {};
    const el = {
      tagName: tag.toUpperCase(),
      id,
      className: '',
      hidden: false,
      value: '',
      placeholder: '',
      textContent: '',
      innerHTML: '',
      children: [],
      style: {},
      attributes: {},
      setAttribute(k, v) {
        el.attributes[k] = v;
        if (k === 'id') el.id = v;
      },
      removeAttribute(k) { delete el.attributes[k]; },
      getAttribute(k) { return el.attributes[k]; },
      addEventListener(evt, fn) {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(fn);
      },
      trigger(evt, eventObj = {}) {
        (listeners[evt] || []).forEach(fn => fn(eventObj));
      },
      focus() { el.isFocused = true; },
      showModal() { el.open = true; },
      close() { el.open = false; },
      open: false,
    };
    if (id) mockElements[id] = el;
    return el;
  };

  // Mock global document
  const origDoc = global.document;
  const origWindow = global.window;
  const mockStorageInstance = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };

  try {
    global.document = {
      getElementById: (id) => mockElements[id] || createMockEl('div', id),
      createElement: (tag) => createMockEl(tag),
      activeElement: null,
    };
    global.window = {
      handleLandMarkerClick: null,
      handleLandClick: null,
    };

    // Siapkan elemen-elemen DOM
    createMockEl('dialog', 'planner-modal');
    createMockEl('div', 'planner-demo-warning');
    createMockEl('input', 'input-area-sqm');
    createMockEl('input', 'input-rental-price');
    createMockEl('ul', 'saved-plans-list');
    const clearBtnEl = createMockEl('button', 'btn-clear-plans');
    const clearConfirmEl = createMockEl('div', 'clear-plans-confirm');
    const confirmNoEl = createMockEl('button', 'btn-confirm-clear-no');

    const ui = new PlannerUI({ storage: new PlanStorage(mockStorageInstance) });

    // 1. Uji Kandidat Demo -> Banner Demo Muncul
    const demoLand = {
      id: 'CAND-DEMO-01',
      name: 'Kavling Demo',
      status: 'Lahan kosong',
      distance_meters: 300,
      data_kind: 'synthetic_academic_demo',
      is_in_buffer: true,
      area_sqm: 120,
      rental_price_yr: 40_000_000,
    };
    ui.openModal(demoLand);
    assert.equal(ui.els.demoWarning.hidden, false, 'Banner data demo wajib tampil jika lahan demo');

    // 2. Uji Kandidat Faktual Terverifikasi -> Banner Demo Tersembunyi
    const factualLand = {
      id: 'CAND-FACTUAL-01',
      name: 'Kavling Survei',
      status: 'Lahan yang tersedia untuk disewakan',
      distance_meters: 250,
      data_kind: 'verified_listing',
      is_verified_public: true,
      is_factual: true,
      is_in_buffer: true,
      area_sqm: 100,
      rental_price_yr: 30_000_000,
    };
    ui.openModal(factualLand);
    assert.equal(ui.els.demoWarning.hidden, true, 'Banner data demo wajib disembunyikan jika lahan terverifikasi');

    // 3. Uji Nilai Kosong (area_sqm & rental_price_yr null) -> Field input dikosongkan (bukan 0)
    const emptyLand = {
      id: 'CAND-EMPTY-01',
      name: 'Kavling Tanpa Data Sewa',
      status: 'Lahan kosong',
      distance_meters: 400,
      data_kind: 'synthetic_academic_demo',
      is_in_buffer: true,
      area_sqm: null,
      rental_price_yr: null,
    };
    ui.openModal(emptyLand);
    assert.equal(ui.els.areaInput.value, '', 'Input luas wajib kosong jika area_sqm null (tidak boleh diisi 0 atau fallback dummy)');
    assert.equal(ui.els.rentalPriceInput.value, '', 'Input sewa wajib kosong jika rental_price_yr null (tidak boleh diisi 0 atau fallback dummy)');

    // 4. Uji Konfirmasi Inline Clear Plans (tanpa confirm())
    clearBtnEl.trigger('click');
    assert.equal(clearConfirmEl.hidden, false, 'Klik clear-plans harus memunculkan dialog konfirmasi inline');
    confirmNoEl.trigger('click');
    assert.equal(clearConfirmEl.hidden, true, 'Klik batal harus menutup dialog konfirmasi inline');
  } finally {
    global.document = origDoc;
    global.window = origWindow;
  }
});

test('24. Provenans Sintetis vs Faktual, Pelabelan Harga Estimasi vs Riil, & Status Survei Kosong', () => {
  // A. Verifikasi Parser: Kandidat Sintetis vs Survei Empiris
  const mockGeoJson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.78, -7.26] },
        properties: {
          id: 'CAND-DEMO-SIM',
          name: 'Kavling Demo Akademik',
          status: 'Lahan kosong',
          data_kind: 'synthetic_academic_demo',
          area_sqm: 200,
          rental_price_yr: 70_000_000,
          distance_meters: 350,
          is_in_buffer: true,
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.75, -7.28] },
        properties: {
          id: 'CAND-SURVEY-01',
          name: 'Kavling Survei Street View',
          status: 'Lahan yang tersedia untuk disewakan',
          data_kind: 'survey_google_maps',
          survey_method: 'street_view',
          evidence_url: 'https://maps.google.com/?cbll=-7.28,112.75',
          observed_at: '2026-11-01',
          surveyed_by: 'Tim Mahasiswa AFL 2',
          area_sqm: null,
          rental_price_yr: null,
          distance_meters: 450,
          is_in_buffer: true,
        },
      },
    ],
  };

  const parsed = PARSERS.candidates(mockGeoJson);
  assert.equal(parsed.items.length, 2);

  const demoItem = parsed.items[0];
  assert.equal(demoItem.isFactual, false);
  assert.equal(demoItem.isSurvey, false);
  assert.equal(demoItem.dataKind, 'demo');
  assert.equal(demoItem.provenanceLabel, 'Simulasi Akademik (Tanpa Provenans Faktual)');

  const surveyItem = parsed.items[1];
  assert.equal(surveyItem.isFactual, true);
  assert.equal(surveyItem.isSurvey, true);
  assert.equal(surveyItem.surveyMethod, 'street_view');
  assert.equal(surveyItem.observedAt, '2026-11-01');
  assert.equal(surveyItem.evidenceUrl, 'https://maps.google.com/?cbll=-7.28,112.75');
  assert.equal(surveyItem.provenanceLabel, 'Survei Lapangan Empiris (street_view)');

  // B. Simulasi Mock DOM untuk Pengujian UI Inspector & Pelabelan Harga Jujur
  const mockElements = {};
  const createMockEl = (tag = 'div', id = '') => {
    const listeners = {};
    const childrenList = [];
    const el = {
      tagName: tag.toUpperCase(),
      id,
      className: '',
      hidden: false,
      value: '',
      placeholder: '',
      textContent: '',
      _innerHTML: '',
      get innerHTML() { return this._innerHTML; },
      set innerHTML(val) {
        this._innerHTML = val;
        this.textContent = String(val).replace(/<[^>]*>/g, ' ');
      },
      dataset: {},
      style: {},
      attributes: {},
      children: childrenList,
      setAttribute(k, v) {
        el.attributes[k] = v;
        if (k === 'id') el.id = v;
      },
      removeAttribute(k) { delete el.attributes[k]; },
      getAttribute(k) { return el.attributes[k]; },
      addEventListener(evt, fn) {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(fn);
      },
      trigger(evt, eventObj = {}) {
        (listeners[evt] || []).forEach((fn) => fn(eventObj));
      },
      append(...nodes) {
        for (const n of nodes.flat(Infinity)) {
          if (n != null && n !== false) {
            childrenList.push(n);
            if (typeof n === 'string') el.textContent += n;
            else if (n.textContent) el.textContent += ' ' + n.textContent;
          }
        }
      },
      replaceChildren(...nodes) {
        childrenList.length = 0;
        el.textContent = '';
        el.append(...nodes);
      },
      focus() { el.isFocused = true; },
      getContext() {
        return new Proxy({}, {
          get: (target, prop) => {
            if (prop in target) return target[prop];
            return () => {};
          },
          set: (target, prop, value) => {
            target[prop] = value;
            return true;
          },
        });
      },
      classList: {
        add(c) { el.className = (el.className + ' ' + c).trim(); },
        remove(c) { el.className = el.className.replace(c, '').trim(); },
        toggle(c, force) { if (force) el.classList.add(c); else el.classList.remove(c); },
      },
    };
    if (id) mockElements[id] = el;
    return el;
  };

  const origDoc = global.document;
  const origWindow = global.window;

  try {
    global.document = {
      getElementById: (id) => mockElements[id] || createMockEl('div', id),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => createMockEl(tag),
      activeElement: null,
    };
    global.window = {
      handleLandMarkerClick: null,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };

    createMockEl('section', 'inspector');
    createMockEl('h2', 'inspector-title');
    const inspBody = createMockEl('div', 'inspector-body');
    const candList = createMockEl('ul', 'candidate-list');
    const candCount = createMockEl('span', 'candidate-count');

    const vm = new MapViewModel();
    vm.data.candidates = { ok: true, items: parsed.items, metadata: null };
    vm.visible.candidates = [...parsed.items];

    const ui = new MapUI(vm, {
      selectCandidate: () => {},
      resetFilters: () => {},
    });

    // 1. Uji Status Survei Kosong saat layer kandidat nonaktif (default state)
    vm.layers.candidates = false;
    ui.renderCandidateList();
    assert.ok(
      candList.textContent.includes('Status Survei Lahan Faktual: Belum ada data survei lapangan empiris'),
      'Wajib menampilkan status survei kosong yang jujur saat layer kandidat nonaktif'
    );
    assert.ok(
      candCount.textContent.includes('0 survei faktual'),
      'Count kandidat wajib menjelaskan 0 survei faktual'
    );

    // 2. Uji Daftar Kandidat saat layer kandidat aktif
    vm.layers.candidates = true;
    ui.renderCandidateList();
    assert.ok(
      candList.textContent.includes('Estimasi Demo'),
      'Metadata kandidat demo wajib memuat label Estimasi Demo'
    );
    assert.ok(
      candList.textContent.includes('(est. demo)'),
      'Harga sewa kandidat demo wajib diberi label (est. demo)'
    );

    // 3. Uji Inspector untuk Kandidat Demo -> Harga Tidak Boleh Ditampilkan sebagai Fakta
    ui.showLandInspector(demoItem);
    assert.ok(
      inspBody.textContent.includes('Estimasi sewa / thn'),
      'Label sewa untuk kandidat demo wajib berlabel Estimasi sewa / thn'
    );
    assert.ok(
      inspBody.textContent.includes('(asumsi demo, bukan data pasar)'),
      'Harga sewa kandidat demo wajib diberi anotasi asumsi demo, bukan data pasar'
    );
    assert.ok(
      inspBody.textContent.includes('Simulasi Akademik Demo (Tanpa Provenans Faktual)'),
      'Callout peringatan demo wajib ada di inspector'
    );

    // 4. Uji Inspector untuk Kandidat Survei dengan Harga Kosong (null) -> Tidak Boleh Mengarang Harga
    ui.showLandInspector(surveyItem);
    assert.ok(
      inspBody.textContent.includes('Belum ada data sewa (tidak ada papan sewa terverifikasi)'),
      'Harga sewa kosong pada survei wajib dinyatakan jujur belum ada data sewa'
    );
    assert.ok(
      inspBody.textContent.includes('street_view'),
      'Metode survei wajib ditampilkan'
    );

    // 5. Uji Inspector Listing Riil & Pencegahan Fallback Fiktif
    let dispatchedLandData = null;
    global.window.handleLandMarkerClick = (data) => {
      dispatchedLandData = data;
    };

    const realListing = {
      id: 'LST-REAL-01',
      title: 'Ruko Disewakan Kertajaya',
      address: 'Jl. Kertajaya No. 88, Surabaya',
      areaCluster: 'Gubeng',
      propertyType: 'ruko',
      buildingAreaSqm: 150,
      landAreaSqm: null,
      rentalPriceYr: null, // Harga null / hubungi kontak
      priceSqmYr: null,
      nearestUniversityName: 'Kampus B Unair',
      distanceM: 350,
      isInBuffer: true,
      sourcePortal: 'OLX Surabaya',
      sourceUrl: 'https://olx.co.id/item/ruko-kertajaya-12345',
      lon: 112.755,
      lat: -7.275,
    };

    ui.showListingInspector(realListing);
    assert.ok(
      inspBody.textContent.includes('Harga sewa tidak tercantum di listing'),
      'Listing tanpa harga wajib menyatakan tidak tercantum'
    );

    // Klik tombol perencana dari listing riil
    const planListingBtn = inspBody.children.find((c) => c.id === 'inspector-listing-plan-btn');
    assert.ok(planListingBtn, 'Tombol perencanaan listing terverifikasi wajib tersedia');
    planListingBtn.trigger('click');

    assert.ok(dispatchedLandData, 'Payload landData harus terkirim');
    assert.equal(
      dispatchedLandData.rental_price_yr,
      null,
      'Listing dengan rentalPriceYr null TIDAK BOLEH fallback ke 60jt atau nilai fiktif apapun'
    );
    assert.equal(
      dispatchedLandData.distance_meters,
      350,
      'Jarak spasial metrik aktual wajib dipertahankan'
    );
  } finally {
    global.document = origDoc;
    global.window = origWindow;
  }
});

test('25. Skenario Sintetis & Penempatan Acak: Pembedaan UI Mutlak, Penolakan Listing Riil, & Peringatan Perencana', () => {
  // A. Koordinasi Skema Backend: data_kind=synthetic_scenario, simulated=true, random_placement=true
  const scenarioFeatures = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.785, -7.265] },
        properties: {
          id: 'SCENARIO-RANDOM-01',
          name: 'Plot Acak Skenario Mulyorejo',
          address: 'Jl. Mulyorejo Simulasi No. 99, Surabaya',
          status: 'Lahan kosong',
          area_sqm: 180,
          rental_price_yr: 55_000_000,
          nearest_university_id: 'UNAIR-KAMPUS-C',
          nearest_university_name: 'Kampus C Unair',
          distance_meters: 320,
          is_in_buffer: true,
          is_eligible: true,
          data_kind: 'synthetic_scenario',
          simulated: true,
          random_placement: true,
          source: 'Generator Skenario Sintetis AFL 2 2026',
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.752, -7.288] },
        properties: {
          id: 'SCENARIO-FIXED-02',
          name: 'Plot Hipotetis Ngagel',
          address: 'Jl. Ngagel Simulasi No. 12, Surabaya',
          status: 'Lahan yang tersedia untuk disewakan',
          area_sqm: 210,
          rental_price_yr: 70_000_000,
          nearest_university_id: 'UBAYA-NGAGEL',
          nearest_university_name: 'Ubaya Ngagel',
          distance_meters: 450,
          is_in_buffer: true,
          is_eligible: true,
          data_kind: 'synthetic_scenario',
          simulated: true,
          random_placement: false,
          source: 'Generator Skenario Sintetis AFL 2 2026',
        },
      },
    ],
  };

  const parseCandFn = PARSERS.candidates;
  const parsed = parseCandFn(scenarioFeatures);
  assert.equal(parsed.items.length, 2);

  const [randItem, fixedItem] = parsed.items;

  // 1. Verifikasi klasifikasi skenario & non-faktual
  assert.equal(randItem.isScenario, true, 'Fitur wajib berstatus isScenario');
  assert.equal(randItem.simulated, true, 'Fitur wajib berstatus simulated=true');
  assert.equal(randItem.isRandomPlacement, true, 'Fitur acak wajib berstatus isRandomPlacement=true');
  assert.equal(randItem.dataKind, 'scenario', 'dataKind wajib diidentifikasi sebagai scenario');
  assert.equal(randItem.isFactual, false, 'Fitur skenario DILARANG berstatus isFactual=true');
  assert.equal(randItem.isSurvey, false, 'Fitur skenario DILARANG berstatus isSurvey=true');
  assert.ok(
    randItem.provenanceLabel.includes('Skenario Sintetis (Penempatan Spasial Acak)'),
    'Label provenans wajib mencantumkan penempatan acak'
  );

  assert.equal(fixedItem.isRandomPlacement, false);
  assert.ok(
    fixedItem.provenanceLabel.includes('Skenario Sintetis (Simulasi Hipotetis)'),
    'Label provenans skenario tetap mencantumkan simulasi hipotetis'
  );

  // 2. Verifikasi Penolakan Mutlak terhadap Listing Riil Publik (isValidEvidenceListing)
  assert.equal(
    isValidEvidenceListing({
      ...randItem.properties,
      is_verified_public: true,
      source_url: 'https://olx.co.id/item/ruko-valid-1234',
    }),
    false,
    'Fitur dengan data_kind=synthetic_scenario atau simulated=true WAJIB DITOLAK oleh isValidEvidenceListing'
  );

  // 3. Verifikasi payload buildLandData untuk modul perencana
  const landDataRand = buildLandData(randItem);
  assert.equal(landDataRand.data_kind, 'synthetic_scenario');
  assert.equal(landDataRand.simulated, true);
  assert.equal(landDataRand.is_scenario, true);
  assert.equal(landDataRand.is_random_placement, true);
  assert.equal(landDataRand.is_factual, false);

  // 4. Uji DOM & UI: Inspector, Candidate List, dan Modal Planner
  const mockElements = {};
  const createMockEl = (tag, id) => {
    const listeners = {};
    const childrenList = [];
    const el = {
      tagName: tag.toUpperCase(),
      id,
      className: '',
      hidden: false,
      value: '',
      placeholder: '',
      textContent: '',
      _innerHTML: '',
      get innerHTML() { return this._innerHTML; },
      set innerHTML(val) {
        this._innerHTML = val;
        this.textContent = String(val).replace(/<[^>]*>/g, ' ');
      },
      dataset: {},
      style: {},
      attributes: {},
      children: childrenList,
      setAttribute(k, v) {
        el.attributes[k] = v;
        if (k === 'id') el.id = v;
      },
      removeAttribute(k) { delete el.attributes[k]; },
      getAttribute(k) { return el.attributes[k]; },
      addEventListener(evt, fn) {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(fn);
      },
      trigger(evt, eventObj = {}) {
        (listeners[evt] || []).forEach((fn) => fn(eventObj));
      },
      append(...nodes) {
        for (const n of nodes.flat(Infinity)) {
          if (n != null && n !== false) {
            childrenList.push(n);
            if (typeof n === 'string') el.textContent += n;
            else if (n.textContent) el.textContent += ' ' + n.textContent;
          }
        }
      },
      replaceChildren(...nodes) {
        childrenList.length = 0;
        el.textContent = '';
        el.append(...nodes);
      },
      focus() { el.isFocused = true; },
      getContext() {
        return new Proxy({}, {
          get: (target, prop) => {
            if (prop in target) return target[prop];
            return () => {};
          },
          set: (target, prop, value) => {
            target[prop] = value;
            return true;
          },
        });
      },
      classList: {
        add(c) { el.className = (el.className + ' ' + c).trim(); },
        remove(c) { el.className = el.className.replace(c, '').trim(); },
        toggle(c, force) { if (force) el.classList.add(c); else el.classList.remove(c); },
      },
    };
    if (id) mockElements[id] = el;
    return el;
  };

  const origDoc = global.document;
  const origWindow = global.window;

  try {
    global.document = {
      getElementById: (id) => mockElements[id] || createMockEl('div', id),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => createMockEl(tag),
      activeElement: null,
    };
    global.window = {
      handleLandMarkerClick: null,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };

    createMockEl('section', 'inspector');
    createMockEl('h2', 'inspector-title');
    const inspBody = createMockEl('div', 'inspector-body');
    const candList = createMockEl('ul', 'candidate-list');
    const candCount = createMockEl('span', 'candidate-count');

    // UI Map
    const vm = new MapViewModel();
    vm.data.candidates = { ok: true, items: parsed.items, metadata: null };
    vm.visible.candidates = [...parsed.items];
    vm.layers.candidates = true;

    const mapUi = new MapUI(vm, {
      selectCandidate: () => {},
      resetFilters: () => {},
    });

    // 4.1 Uji Inspector Skenario Penempatan Acak
    mapUi.showLandInspector(randItem);
    assert.ok(
      inspBody.textContent.includes('Skenario Sintetis (Penempatan Acak)'),
      'Callout inspector wajib menjelaskan skenario dengan penempatan acak'
    );
    assert.ok(
      inspBody.textContent.includes('Estimasi sewa skenario'),
      'Harga sewa skenario wajib dilabeli estimasi sewa skenario'
    );
    assert.ok(
      inspBody.textContent.includes('(nilai skenario simulasi, bukan harga pasar)'),
      'Harga sewa skenario wajib menegaskan bukan harga pasar'
    );
    assert.ok(
      inspBody.textContent.includes('Koordinat acak (Random Placement untuk simulasi)'),
      'Penempatan spasial acak wajib dicatat eksplisit'
    );
    assert.ok(
      inspBody.textContent.includes('Rencanakan Modal Kafe (Skenario Sintetis)'),
      'Tombol perencana wajib melabeli skenario sintetis'
    );

    // 4.2 Uji Daftar Kandidat Skenario
    mapUi.renderCandidateList();
    assert.ok(
      candList.textContent.includes('Acak') || candList.textContent.includes('Skenario'),
      'Daftar kandidat wajib menampilkan tag skenario'
    );
    assert.ok(
      candList.textContent.includes('(harga skenario)'),
      'Harga di daftar kandidat wajib memuat anotasi (harga skenario)'
    );

    // 4.3 Uji Modal Perencana (PlannerUI) Memunculkan Banner Peringatan Skenario
    createMockEl('dialog', 'planner-modal');
    const scenarioWarnEl = createMockEl('div', 'planner-scenario-warning');
    const scenarioWarnTextEl = createMockEl('span', 'planner-scenario-warning-text');
    const demoWarnEl = createMockEl('div', 'planner-demo-warning');
    const statusBadgeEl = createMockEl('span', 'planner-status-badge');
    createMockEl('input', 'input-area-sqm');
    createMockEl('input', 'input-rental-price');

    const mockStorage = {
      getItem: () => '[]',
      setItem: () => {},
      removeItem: () => {},
    };
    const plannerUi = new PlannerUI({ storage: new PlanStorage(mockStorage) });

    plannerUi.openModal(landDataRand);
    assert.equal(
      plannerUi.els.scenarioWarning.hidden,
      false,
      'Modal planner WAJIB menampilkan banner peringatan skenario sintetis'
    );
    assert.equal(
      plannerUi.els.demoWarning.hidden,
      true,
      'Banner demo biasa harus disembunyikan agar tidak tumpang tindih'
    );
    assert.ok(
      plannerUi.els.scenarioWarningText.textContent.includes('Peringatan Skenario Sintetis'),
      'Teks peringatan skenario wajib memuat judul peringatan skenario'
    );
    assert.ok(
      plannerUi.els.statusBadge.textContent.includes('Skenario (Penempatan Acak)'),
      'Badge status planner wajib mencantumkan penempatan acak'
    );
    assert.ok(
      plannerUi.els.statusBadge.className.includes('badge-scenario'),
      'Badge status wajib memiliki kelas styling khusus badge-scenario'
    );

    // 5. Verifikasi Pemisahan Dataset OSM: Bangunan & Kafe OSM tidak terkontaminasi skenario
    const osmCafeFn = PARSERS.osmCafes;
    const osmCafeData = osmCafeFn({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [112.79, -7.27] },
          properties: { id: 'CAFE-01', name: 'Kafe Riil Faktual', data_kind: 'osm_factual_open_data' },
        },
      ],
    });
    assert.equal(osmCafeData.items[0].dataKind, 'osm_cafe');
    assert.equal(osmCafeData.items[0].isScenario, undefined);
    assert.equal(osmCafeData.items[0].simulated, undefined);
  } finally {
    global.document = origDoc;
    global.window = origWindow;
  }
});

test('26. Integrasi Opt-in Skenario Sintetis: Checkbox Default-Off, Hit-Test, Hidden Selection, & Schema Coordination', () => {
  // 1. Verifikasi Checkbox Layer Skenario Default-Off
  const vm = new MapViewModel();
  assert.equal(
    vm.layers.scenarios,
    false,
    'Layer skenario sintetis WAJIB bernilai false (default-off) demi kejujuran data'
  );

  // 2. Pemuatan Fixture Skenario Sintetis Nyata dari Disk (data/fixtures/synthetic_scenario_candidates.geojson)
  const fixturePath = path.join(__dirname, '../data/fixtures/synthetic_scenario_candidates.geojson');
  assert.ok(fs.existsSync(fixturePath), 'Berkas fixture skenario sintetis wajib ada di disk');
  const fixtureJson = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const parsed = PARSERS.scenarios(fixtureJson);

  assert.equal(parsed.items.length, 8, 'Fixture skenario wajib memuat 8 situs kafe simulasi');
  for (const item of parsed.items) {
    assert.equal(item.isScenario, true, 'Setiap item skenario wajib berstatus isScenario=true');
    assert.equal(item.simulated, true, 'Setiap item skenario wajib berstatus simulated=true');
    assert.equal(item.isFactual, false, 'Skenario tidak boleh berstatus faktual');
    assert.equal(item.isSurvey, false, 'Skenario tidak boleh berstatus survei');
    assert.equal(item.dataKind, 'scenario', 'dataKind wajib berupa scenario');
    assert.equal(item.properties.is_price_estimate, true, 'Harga wajib bertipe estimasi');
    assert.equal(item.properties.is_transaction_price, false, 'Harga bukan transaksi riil');
  }

  // 3. Koordinasi Skema Backend: target_campus_id -> nearest_university_id
  const sampleScenario = parsed.items[0];
  assert.equal(sampleScenario.nearestUniversityId, 'UNAIR-KAMPUS-A');
  assert.equal(sampleScenario.nearestUniversityName, 'Kampus A Universitas Airlangga');

  // Uji fallback mutual jika properti backend hanya memuat target_campus_id / target_campus_name
  const backendFeaturePayload = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [112.75, -7.27] },
        properties: {
          id: 'TEST-BACKEND-SCHEMA-01',
          name: 'Situs Hipotetis Dinoyo',
          status: 'Lahan yang tersedia untuk disewakan',
          target_campus_id: 'UKWMS-DINOYO',
          target_campus_name: 'Kampus Dinoyo UKWMS',
          data_kind: 'synthetic_scenario',
          simulated: true,
          distance_meters: 350,
          is_in_buffer: true,
          rental_price_yr: 120_000_000,
          rental_price_label: 'Rp 120,000,000 / tahun (Estimasi Simulasi Hipotetis)',
          is_price_estimate: true,
        },
      },
    ],
  };
  const parsedBackendFeature = PARSERS.scenarios(backendFeaturePayload);
  const parsedBackendItem = parsedBackendFeature.items[0];
  assert.equal(parsedBackendItem.nearestUniversityId, 'UKWMS-DINOYO');
  assert.equal(parsedBackendItem.nearestUniversityName, 'Kampus Dinoyo UKWMS');

  const landData = buildLandData(parsedBackendItem);
  assert.equal(landData.nearest_university_id, 'UKWMS-DINOYO', 'buildLandData wajib memetakan target_campus_id ke nearest_university_id');
  assert.equal(landData.nearest_university_name, 'Kampus Dinoyo UKWMS', 'buildLandData wajib memetakan target_campus_name ke nearest_university_name');
  assert.equal(landData.data_kind, 'synthetic_scenario');
  assert.equal(landData.simulated, true);
  assert.equal(landData.is_scenario, true);

  // 4. Hit-Test Kanvas & Gambar Marker Skenario (Halo Ungu Putus-Putus)
  const vp = new Viewport();
  vp.setSize(800, 600);
  vp.cx = sampleScenario.wx;
  vp.cy = sampleScenario.wy;
  vp.zoom = 15;
  const [screenX, screenY] = vp.worldToScreen(sampleScenario.wx, sampleScenario.wy);

  let drawnHalo = false;
  let drawnStrokeStyle = null;
  const mockCtx = new Proxy(
    {
      arc(x, y, r) {
        if (r > 12) drawnHalo = true;
      },
      setLineDash(dash) {
        if (Array.isArray(dash) && dash.length === 2 && dash[0] === 3 && dash[1] === 3) {
          drawnHalo = true;
        }
      },
      set strokeStyle(val) {
        drawnStrokeStyle = val;
      },
      get strokeStyle() {
        return drawnStrokeStyle;
      },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => {};
      },
    }
  );

  // Uji pemanggilan drawStatusMarker dengan isScenario: true
  drawStatusMarker(mockCtx, sampleScenario.status, screenX, screenY, 10, { isScenario: true });
  assert.equal(drawnHalo, true, 'Marker skenario wajib menggambar halo putus-putus');
  assert.equal(drawnStrokeStyle, '#9333EA', 'Warna halo skenario wajib ungu #9333EA');

  // Uji Hit-Test melalui MapRenderer
  const mockCanvas = {
    getContext: () => mockCtx,
  };
  const renderer = new MapRenderer(mockCanvas, vp, vm);
  vm.data.scenarios = { ok: true, items: parsed.items };
  vm.data.candidates = { ok: true, items: [] };

  // 4.1 Saat layer skenario default OFF -> hitTest mengembalikan null
  assert.equal(vm.layers.scenarios, false);
  const hitOff = renderer.hitTest(screenX, screenY);
  assert.equal(hitOff, null, 'Saat layer skenario OFF, marker skenario tidak boleh merespons hit-test');

  // 4.2 Saat layer skenario dihidupkan (ON) -> hitTest mendeteksi skenario
  vm.setLayer('scenarios', true);
  const hitOn = renderer.hitTest(screenX, screenY);
  assert.ok(hitOn, 'Saat layer skenario ON, hit-test wajib mendeteksi marker skenario');
  assert.equal(hitOn.kind, 'land');
  assert.equal(hitOn.item.id, sampleScenario.id);

  // 5. Perilaku Hidden-Selection (Selection Terbuang Saat Layer Dimatikan)
  // 5.1 Pilih marker skenario
  vm.select({ kind: 'land', id: sampleScenario.id });
  assert.equal(vm.selection?.id, sampleScenario.id, 'Seleksi aktif pada skenario');

  // 5.2 Matikan layer skenario -> seleksi harus otomatis di-drop (null)
  vm.setLayer('scenarios', false);
  assert.equal(
    vm.selection,
    null,
    'Mematikan layer skenario WAJIB menghapus seleksi skenario aktif (hidden-selection behavior)'
  );

  // 5.3 Nyalakan kembali layer skenario & pilih lagi
  vm.setLayer('scenarios', true);
  vm.select({ kind: 'land', id: sampleScenario.id });
  assert.equal(vm.selection?.id, sampleScenario.id);

  // 5.4 Matikan filter status lahan skenario terkait -> dropHiddenSelection wajib membuang seleksi
  vm.setStatus(sampleScenario.status.key, false);
  assert.equal(
    vm.selection,
    null,
    'Menonaktifkan status filter yang menyembunyikan skenario terpilih WAJIB mengosongkan seleksi'
  );
});

