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
} from './js/data.js';
import { evaluateCandidateEligibility } from './js/ui.js';
import {
  canPlanForLand,
  calculateInitialCapital,
  formatRupiah,
  downloadJsonFile,
  ELIGIBLE_LAND_STATUSES,
  DEFAULT_PLAN_COSTS,
  PlanStorage,
  initPlanner,
} from './js/planner.js';

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

test('13. Verifikasi Komprehensif Seluruh 20 Kandidat Dataset Terproses terhadap Guard Planner', () => {
  const rootDir = path.resolve(__dirname, '..');
  const canPath = path.join(rootDir, 'data/processed/land_candidates.geojson');
  const canJson = JSON.parse(fs.readFileSync(canPath, 'utf8'));

  assert.equal(canJson.features.length, 20, 'Harus ada tepat 20 fitur kandidat lahan');

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

  // Tepat 8 kandidat eligible dan 12 ineligible sesuai hasil pipeline GIS backend
  assert.equal(eligibleCount, 8, 'Tepat 8 kandidat lahan harus memenuhi syarat perencanaan');
  assert.equal(ineligibleCount, 12, 'Tepat 12 kandidat lahan harus ditolak perencanaan');

  // Verifikasi 8 kandidat yang lolos mencakup ketiga universitas sasaran (Unair, UKWMS, Ubaya)
  assert.ok(passedIds.includes('CAND-UNAIR-C-01'), 'CAND-UNAIR-C-01 harus lolos');
  assert.ok(passedIds.includes('CAND-UNAIR-C-02'), 'CAND-UNAIR-C-02 harus lolos');
  assert.ok(passedIds.includes('CAND-UKWMS-DIN-01'), 'CAND-UKWMS-DIN-01 harus lolos (UKWMS Dinoyo)');
  assert.ok(passedIds.includes('CAND-UKWMS-DIN-02'), 'CAND-UKWMS-DIN-02 harus lolos (UKWMS Dinoyo)');
  assert.ok(passedIds.includes('CAND-UKWMS-KAL-01'), 'CAND-UKWMS-KAL-01 harus lolos (UKWMS Kalijudan)');
  assert.ok(passedIds.includes('CAND-UBAYA-NGA-01'), 'CAND-UBAYA-NGA-01 harus lolos (UBAYA Ngagel)');
  assert.ok(passedIds.includes('CAND-UBAYA-TENG-01'), 'CAND-UBAYA-TENG-01 harus lolos (UBAYA Tenggilis)');
  assert.ok(passedIds.includes('CAND-EDGE-IN-01'), 'CAND-EDGE-IN-01 harus lolos (Ambang batas 985m)');

  // Verifikasi kandidat UKWMS Pakuwon perumahan dan kandidat di luar buffer ditolak
  assert.ok(rejectedIds.includes('CAND-UKWMS-PAK-01'), 'CAND-UKWMS-PAK-01 (Rumah tinggal) harus ditolak');
  assert.ok(rejectedIds.includes('CAND-OUT-01'), 'CAND-OUT-01 (1082m) harus ditolak');
  assert.ok(rejectedIds.includes('CAND-OUT-02'), 'CAND-OUT-02 (5478m) harus ditolak');
  assert.ok(rejectedIds.includes('CAND-EDGE-OUT-01'), 'CAND-EDGE-OUT-01 (1025m) harus ditolak');
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


