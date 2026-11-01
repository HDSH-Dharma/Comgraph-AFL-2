/**
 * Buka Kafe — Modul Perencanaan Modal Kafe (Prompt 2 Planner)
 * 
 * Modul ini mengelola:
 * 1. Guard & Defense-in-Depth: Memastikan hanya lahan yang berada dalam radius buffer <= 1000m
 *    dan berstatus "Lahan kosong" atau "Lahan yang tersedia untuk disewakan" yang dapat direncanakan.
 * 2. Kalkulator Modal Awal: Menghitung estimasi modal awal berdasarkan luas lahan, harga sewa,
 *    durasi sewa, biaya renovasi interior, peralatan mesin, cadangan operasional, dan kontingensi.
 * 3. Modal Perencanaan Kafe: Antarmuka dialog interaktif aksesibel untuk memasukkan parameter dan kalkulasi real-time.
 * 4. LocalStorage & Saved Plans: Menyimpan, memuat, menghapus, dan mengunduh rencana kafe secara persisten di browser.
 * 5. Kontrak Interop: Menerima payload dari window.handleLandMarkerClick(landData).
 */

export const ELIGIBLE_LAND_STATUSES = Object.freeze([
  'Lahan kosong',
  'Lahan yang tersedia untuk disewakan',
]);

/**
 * Asumsi Biaya Perencanaan Kafe
 * Catatan Metodologis (Prompt B):
 * Seluruh komponen biaya di bawah merupakan ASUMSI INTERNAL TIM SIMULASI AFL 2 (2026),
 * BUKAN data survei pasar komersial aktual Surabaya.
 * Digunakan sebagai nilai dasar ilustratif dalam simulasi kalkulator modal kafe mahasiswa.
 */
export const COST_ASSUMPTIONS = Object.freeze({
  renovation_cost_per_sqm: Object.freeze({
    value: 1_500_000,
    label: 'Renovasi & Desain Interior (Rp / m²)',
    is_market_data: false,
    note: 'Asumsi tim simulasi (bukan data pasar): Estimasi fit-out interior kafe minimalis',
  }),
  equipment_cost: Object.freeze({
    value: 45_000_000,
    label: 'Peralatan & Mesin Kopi (Rp)',
    is_market_data: false,
    note: 'Asumsi tim simulasi: Paket komersial dasar (mesin espresso, grinder, chiller, POS)',
  }),
  monthly_operational_cost: Object.freeze({
    value: 15_000_000,
    label: 'Operasional Bulanan (Rp)',
    is_market_data: false,
    note: 'Asumsi tim simulasi: Estimasi gaji barista paruh waktu, bahan baku awal, listrik, & WiFi',
  }),
  working_capital_months: Object.freeze({
    value: 3,
    label: 'Cadangan Operasional (Bulan)',
    is_market_data: false,
    note: 'Asumsi tim simulasi: Runway cadangan dana operasional 3 bulan pertama',
  }),
  contingency_cost: Object.freeze({
    value: 10_000_000,
    label: 'Perizinan & Kontingensi (Rp)',
    is_market_data: false,
    note: 'Asumsi tim simulasi: Biaya izin usaha mikro (NIB/PIRT) dan cadangan tak terduga',
  }),
  rental_duration_yr: Object.freeze({
    value: 1,
    label: 'Durasi Sewa Lahan (Tahun)',
    is_market_data: false,
    note: 'Asumsi tim simulasi: Kontrak sewa tahunan standar',
  }),
});

export const DEFAULT_PLAN_COSTS = Object.freeze({
  renovation_cost_per_sqm: COST_ASSUMPTIONS.renovation_cost_per_sqm.value,
  equipment_cost: COST_ASSUMPTIONS.equipment_cost.value,
  monthly_operational_cost: COST_ASSUMPTIONS.monthly_operational_cost.value,
  working_capital_months: COST_ASSUMPTIONS.working_capital_months.value,
  contingency_cost: COST_ASSUMPTIONS.contingency_cost.value,
  rental_duration_yr: COST_ASSUMPTIONS.rental_duration_yr.value,
});

export const rupiah = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0,
});

export function formatRupiah(value) {
  const num = typeof value === 'number' && !Number.isNaN(value) ? value : 0;
  return rupiah.format(Math.round(num));
}

/**
 * Memicu unduhan berkas teks / JSON di sisi klien browser atau lingkungan headless
 * @param {string} filename Nama berkas yang diunduh
 * @param {string|Object} content Isi berkas (string teks atau objek yang akan di-stringify)
 * @param {string} [mimeType='application/json'] Jenis MIME
 * @returns {string} Konten JSON string
 */
export function triggerFileDownload(filename, content, mimeType = 'application/json') {
  const textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  if (typeof document === 'undefined') {
    return textContent;
  }
  try {
    const blob = new Blob([textContent], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch (_) {}
    }, 1000);
    return textContent;
  } catch (err) {
    console.error('[planner] Gagal mengunduh berkas:', err);
    throw new Error(`Gagal mengunduh berkas: ${err.message}`);
  }
}

export const downloadJsonFile = triggerFileDownload;

/**
 * Mengunduh objek rencana kafe sebagai berkas JSON
 * @param {Object} plan Data rencana kafe
 * @returns {boolean}
 */
export function downloadPlanAsJson(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Data rencana tidak valid untuk diunduh.');
  }
  const safeName = (plan.cafe_name || 'rencana-kafe')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  const idStr = plan.id ? `-${plan.id}` : '';
  const filename = `${safeName || 'rencana-kafe'}${idStr}.json`;
  return triggerFileDownload(filename, JSON.stringify(plan, null, 2));
}

/**
 * Evaluasi Guard Defense-in-Depth:
 * Memverifikasi syarat geospasial (jarak <= 1000m) dan syarat atribut lahan.
 * Menolak masukan null, rusak, bernilai jarak negatif, atau tanpa bukti spasial.
 * 
 * @param {Object} landData Objek data kandidat lahan
 * @param {string[]} [eligibleStatuses] Daftar status lahan yang diizinkan
 * @returns {{ eligible: boolean, inRadius: boolean, isStatusOk: boolean, reasons: string[] }}
 */
export function canPlanForLand(landData, eligibleStatuses = ELIGIBLE_LAND_STATUSES) {
  if (!landData || typeof landData !== 'object' || Array.isArray(landData)) {
    return {
      eligible: false,
      inRadius: false,
      isStatusOk: false,
      reasons: ['Data kandidat lahan tidak valid atau kosong.'],
    };
  }

  // Validasi nilai jarak metrik (mendukung number atau string numerik terhingga)
  const rawDistance = landData.distance_meters ?? landData.distanceM ?? null;
  let distance = null;
  let isDistanceInvalid = false;

  if (rawDistance != null) {
    if (typeof rawDistance === 'number') {
      if (Number.isFinite(rawDistance)) {
        distance = rawDistance;
      } else {
        isDistanceInvalid = true; // NaN atau Infinity
      }
    } else if (typeof rawDistance === 'string' && rawDistance.trim() !== '') {
      const parsed = Number(rawDistance);
      if (Number.isFinite(parsed)) {
        distance = parsed;
      } else {
        isDistanceInvalid = true;
      }
    } else {
      isDistanceInvalid = true;
    }
  }

  let inRadius = false;
  let isDistanceNegative = false;
  if (isDistanceInvalid) {
    inRadius = false;
  } else if (distance != null) {
    if (distance < 0) {
      isDistanceNegative = true;
      inRadius = false;
    } else {
      inRadius = distance <= 1000.0;
    }
  } else {
    // Jika jarak metrik tidak disertakan, verifikasi atribut boolean is_in_buffer
    inRadius = landData.is_in_buffer === true;
  }

  // Validasi status lahan
  const statusVal =
    typeof landData.status === 'object' && landData.status !== null
      ? landData.status.value || ''
      : typeof landData.status === 'string'
        ? landData.status
        : '';

  // Planner Guard: Validasi status lahan (hanya 'Lahan kosong' atau 'Lahan yang tersedia untuk disewakan' yang dapat membuka planner; rumah/ruko/fungsi lain ditolak keras).
  const isStatusOk = Array.isArray(eligibleStatuses) && eligibleStatuses.includes(statusVal);
  const notExplicitlyOutOfBuffer = landData.is_in_buffer !== false;

  const eligible =
    inRadius && isStatusOk && notExplicitlyOutOfBuffer && !isDistanceNegative && !isDistanceInvalid;
  const reasons = [];

  if (isDistanceInvalid) {
    reasons.push('Nilai jarak tidak valid (bukan angka metrik terhingga).');
  } else if (isDistanceNegative) {
    reasons.push('Nilai jarak tidak valid (jarak tidak boleh bernilai negatif).');
  } else if (!inRadius || !notExplicitlyOutOfBuffer) {
    reasons.push(
      distance != null
        ? `Jarak ${distance.toFixed(1)} m melebihi batas radius buffer 1.000 m.`
        : 'Lokasi berada di luar radius buffer 1.000 m dari kampus atau tidak memiliki data spasial valid.'
    );
  }

  if (!isStatusOk) {
    reasons.push(
      `Status lahan "${statusVal || 'Tidak diketahui'}" tidak dapat dipilih untuk pembukaan kafe. Hanya status "Lahan kosong" atau "Lahan yang tersedia untuk disewakan" yang memenuhi syarat.`
    );
  }

  return {
    eligible,
    inRadius,
    isStatusOk,
    reasons,
  };
}

/**
 * Kalkulator Poin Kelayakan / Skor Potensi Bisnis Kafe (0 - 100 Poin)
 * Menilai aspek strategis dalam lingkup game "Buka Kafe" sebagai SKOR ILUSTRATIF:
 * 1. Proksimitas kampus (jarak metrik <= 1000m): maks 40 poin (data kosong = 0 poin)
 * 2. Kesesuaian luas lahan (80 - 250 m² optimal): maks 30 poin (data kosong = 0 poin)
 * 3. Efisiensi harga sewa per m²: maks 30 poin (data sewa/luas kosong = 0 poin)
 *
 * @param {Object} params
 * @returns {{ points: number, grade: string, breakdown: { proximity: number, space: number, cost_efficiency: number } }}
 */
export function calculateFeasibilityPoints({ distance_meters = null, area_sqm = null, rental_price_yr = null } = {}) {
  let proximityScore = 0;
  const dist = typeof distance_meters === 'number' && Number.isFinite(distance_meters) && distance_meters >= 0
    ? distance_meters
    : null;
  if (dist != null) {
    if (dist <= 300) proximityScore = 40;
    else if (dist <= 600) proximityScore = 30;
    else if (dist <= 1000) proximityScore = 20;
    else proximityScore = 0;
  }

  let spaceScore = 0;
  const area = typeof area_sqm === 'number' && Number.isFinite(area_sqm) && area_sqm > 0
    ? area_sqm
    : null;
  if (area != null) {
    if (area >= 80 && area <= 250) spaceScore = 30;
    else if ((area >= 50 && area < 80) || (area > 250 && area <= 400)) spaceScore = 20;
    else spaceScore = 10;
  }

  let costScore = 0;
  const rent = typeof rental_price_yr === 'number' && Number.isFinite(rental_price_yr) && rental_price_yr > 0
    ? rental_price_yr
    : null;
  if (area != null && rent != null) {
    const costPerSqm = rent / area;
    if (costPerSqm <= 400_000) costScore = 30;
    else if (costPerSqm <= 700_000) costScore = 20;
    else costScore = 10;
  }

  const totalPoints = proximityScore + spaceScore + costScore;
  let grade = 'Kurang Layak';
  if (totalPoints >= 85) grade = 'Sangat Strategis ★★★';
  else if (totalPoints >= 70) grade = 'Strategis ★★';
  else if (totalPoints >= 50) grade = 'Cukup Layak ★';
  else if (totalPoints === 0) grade = 'Data Belum Lengkap';

  return {
    points: totalPoints,
    grade,
    breakdown: {
      proximity: proximityScore,
      space: spaceScore,
      cost_efficiency: costScore,
    },
  };
}

/**
 * Kalkulator Estimasi Modal Awal Kafe
 * Menghitung rincian biaya:
 * - Sewa = rental_price_yr * rental_duration_yr
 * - Renovasi = area_sqm * renovation_cost_per_sqm
 * - Peralatan = equipment_cost
 * - Cadangan Operasional = monthly_operational_cost * working_capital_months
 * - Kontingensi / Perizinan = contingency_cost
 * Serta mengevaluasi poin kelayakan kafe dan kesesuaian target anggaran.
 * 
 * @param {Object} params Parameter finansial
 * @param {Object} [landData] Objek data kandidat lahan
 * @returns {Object} Rincian biaya, total estimasi modal awal, dan skor kelayakan
 */
export function calculateInitialCapital(params = {}, landData = null) {
  const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const parsed = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const num = (v, def = 0) => {
    const parsed = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : def;
  };

  const area_sqm = numOrNull(params.area_sqm);
  const rental_price_yr = numOrNull(params.rental_price_yr);
  const rental_duration_yr = Math.max(1, Math.round(num(params.rental_duration_yr, DEFAULT_PLAN_COSTS.rental_duration_yr)));
  const renovation_cost_per_sqm = num(params.renovation_cost_per_sqm, DEFAULT_PLAN_COSTS.renovation_cost_per_sqm);
  const equipment_cost = num(params.equipment_cost, DEFAULT_PLAN_COSTS.equipment_cost);
  const monthly_operational_cost = num(params.monthly_operational_cost, DEFAULT_PLAN_COSTS.monthly_operational_cost);
  const working_capital_months = Math.max(0, Math.round(num(params.working_capital_months, DEFAULT_PLAN_COSTS.working_capital_months)));
  const contingency_cost = num(params.contingency_cost, DEFAULT_PLAN_COSTS.contingency_cost);
  const budget_limit = num(params.budget_limit, 0);

  const subtotal_rental = rental_price_yr != null ? Math.round(rental_price_yr * rental_duration_yr) : 0;
  const subtotal_renovation = area_sqm != null ? Math.round(area_sqm * renovation_cost_per_sqm) : 0;
  const subtotal_equipment = Math.round(equipment_cost);
  const subtotal_operational = Math.round(monthly_operational_cost * working_capital_months);
  const subtotal_contingency = Math.round(contingency_cost);

  const total_initial_capital =
    subtotal_rental + subtotal_renovation + subtotal_equipment + subtotal_operational + subtotal_contingency;

  const rawDist = params.distance_meters ?? landData?.distance_meters ?? landData?.distanceM ?? null;
  const distance_meters = typeof rawDist === 'number' && Number.isFinite(rawDist)
    ? rawDist
    : (rawDist != null && !Number.isNaN(Number(rawDist)) ? Number(rawDist) : null);

  const feasibility = calculateFeasibilityPoints({
    distance_meters,
    area_sqm,
    rental_price_yr,
  });

  const is_within_budget = budget_limit > 0 ? total_initial_capital <= budget_limit : true;
  const budget_difference = budget_limit > 0 ? budget_limit - total_initial_capital : 0;
  const budget_status = budget_limit > 0
    ? (total_initial_capital <= budget_limit ? 'SESUAI_ANGGARAN' : 'MELEBIHI_ANGGARAN')
    : 'TIDAK_DIBATASI';

  return {
    area_sqm,
    rental_price_yr,
    rental_duration_yr,
    renovation_cost_per_sqm,
    equipment_cost,
    monthly_operational_cost,
    working_capital_months,
    contingency_cost,
    subtotal_rental,
    subtotal_renovation,
    subtotal_equipment,
    subtotal_operational,
    subtotal_contingency,
    total_initial_capital,
    budget_limit,
    is_within_budget,
    budget_difference,
    budget_status,
    feasibility_points: feasibility.points,
    feasibility_grade: feasibility.grade,
    feasibility_breakdown: feasibility.breakdown,
  };
}

/**
 * Pengelola Penyimpanan Rencana (LocalStorage Manager)
 * Mendukung simpan, muat, hapus, dan unduh (ekspor berkas JSON).
 */
export class PlanStorage {
  constructor(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storage;
    this.key = 'bukakafe_saved_plans';
    this.memoryFallback = [];
  }

  loadPlans() {
    if (!this.storage) return [...this.memoryFallback];
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.warn('[planner] Gagal mem-parse rencana tersimpan dari localStorage:', err);
      return [];
    }
  }

  savePlan(plan) {
    if (!plan || typeof plan !== 'object') {
      throw new Error('Data rencana tidak valid.');
    }
    if (!plan.land || typeof plan.land !== 'object') {
      throw new Error('Data rencana tidak valid: data lahan (land) wajib disertakan.');
    }

    // Defense-in-depth: Re-check guard sebelum menyimpan ke media persisten
    const guard = canPlanForLand(plan.land);
    if (!guard.eligible) {
      throw new Error(`Rencana tidak dapat disimpan: ${guard.reasons.join(' ')}`);
    }

    const plans = this.loadPlans();
    const id = plan.id || `PLAN-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const timestamp = plan.created_at || new Date().toISOString();

    const record = {
      ...plan,
      id,
      created_at: timestamp,
      updated_at: new Date().toISOString(),
    };

    const existingIndex = plans.findIndex((p) => p.id === id);
    if (existingIndex >= 0) {
      plans[existingIndex] = record;
    } else {
      plans.unshift(record);
    }

    if (this.storage) {
      try {
        this.storage.setItem(this.key, JSON.stringify(plans));
      } catch (err) {
        console.error('[planner] Gagal menyimpan ke localStorage:', err);
        throw new Error('Gagal menyimpan rencana ke penyimpanan browser: kuota penyimpanan penuh atau akses ditolak.');
      }
    } else {
      this.memoryFallback = plans;
    }

    return record;
  }

  deletePlan(id) {
    const plans = this.loadPlans().filter((p) => p.id !== id);
    if (this.storage) {
      try {
        this.storage.setItem(this.key, JSON.stringify(plans));
      } catch (err) {
        console.error('[planner] Gagal menghapus dari localStorage:', err);
      }
    } else {
      this.memoryFallback = plans;
    }
    return true;
  }

  clearPlans() {
    if (this.storage) {
      try {
        this.storage.removeItem(this.key);
      } catch (err) {
        console.error('[planner] Gagal membersihkan localStorage:', err);
      }
    } else {
      this.memoryFallback = [];
    }
    return true;
  }

  getPlan(id) {
    return this.loadPlans().find((p) => p.id === id) || null;
  }

  exportPlansJson() {
    const plans = this.loadPlans();
    return JSON.stringify(plans, null, 2);
  }

  exportPlanAsJson(id, { triggerDownload = true } = {}) {
    const plan = this.getPlan(id);
    if (!plan) {
      throw new Error(`Rencana dengan ID "${id}" tidak ditemukan.`);
    }

    const payload = {
      schema_version: '1.0',
      project: 'Buka Kafe — Perencanaan Modal Kafe Surabaya',
      exported_at: new Date().toISOString(),
      plan,
    };

    const safeName = (plan.cafe_name || 'rencana-kafe')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '');
    const filename = `rencana-kafe-${safeName || 'rencana'}-${plan.id}.json`;
    const json = JSON.stringify(payload, null, 2);

    if (triggerDownload) {
      triggerFileDownload(filename, json);
    }

    return { ok: true, filename, payload, json };
  }

  exportAllPlansAsJson({ triggerDownload = true } = {}) {
    const plans = this.loadPlans();
    if (!plans.length) {
      throw new Error('Belum ada rencana tersimpan untuk diunduh.');
    }

    const payload = {
      schema_version: '1.0',
      project: 'Buka Kafe — Perencanaan Modal Kafe Surabaya',
      exported_at: new Date().toISOString(),
      total_plans: plans.length,
      plans,
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `semua-rencana-kafe-surabaya-${dateStr}.json`;
    const json = JSON.stringify(payload, null, 2);

    if (triggerDownload) {
      triggerFileDownload(filename, json);
    }

    return { ok: true, filename, count: plans.length, payload, json };
  }

  downloadPlan(id) {
    return this.exportPlanAsJson(id, { triggerDownload: true });
  }

  downloadAllPlans() {
    return this.exportAllPlansAsJson({ triggerDownload: true });
  }
}

/**
 * Controller Antarmuka Modal & Rencana Tersimpan (Aksesibel & Responsif)
 */
export class PlannerUI {
  constructor({ storage, onPlanSaved, onPlanDeleted } = {}) {
    this.storage = storage || new PlanStorage();
    this.onPlanSaved = onPlanSaved;
    this.onPlanDeleted = onPlanDeleted;
    this.currentLand = null;
    this.currentPlanId = null;
    this.previousActiveElement = null;

    // Cache elemen DOM jika ada di halaman
    this.els = {
      modal: document.getElementById('planner-modal'),
      closeBtn: document.getElementById('modal-close-btn'),
      cancelBtn: document.getElementById('modal-cancel-btn'),
      saveBtn: document.getElementById('modal-save-btn'),
      modalDownloadBtn: document.getElementById('modal-download-btn'),
      form: document.getElementById('planner-form'),
      guardAlert: document.getElementById('planner-guard-alert'),
      scenarioWarning: document.getElementById('planner-scenario-warning'),
      scenarioWarningText: document.getElementById('planner-scenario-warning-text'),
      demoWarning: document.getElementById('planner-demo-warning'),
      statusBadge: document.getElementById('planner-status-badge'),
      landName: document.getElementById('planner-land-name'),
      landAddress: document.getElementById('planner-land-address'),
      landCampus: document.getElementById('planner-land-campus'),
      landDistance: document.getElementById('planner-land-distance'),
      cafeNameInput: document.getElementById('input-cafe-name'),
      targetCustInput: document.getElementById('input-target-customer'),
      areaInput: document.getElementById('input-area-sqm'),
      rentalPriceInput: document.getElementById('input-rental-price'),
      rentalDurationInput: document.getElementById('input-rental-duration'),
      renovationRateInput: document.getElementById('input-renovation-rate'),
      equipmentInput: document.getElementById('input-equipment-cost'),
      monthlyOpsInput: document.getElementById('input-monthly-ops'),
      workingMonthsInput: document.getElementById('input-working-months'),
      contingencyInput: document.getElementById('input-contingency-cost'),
      budgetLimitInput: document.getElementById('input-budget-limit'),
      // Breakdown output elemen
      outSubtotalRental: document.getElementById('calc-subtotal-rental'),
      outSubtotalRenovation: document.getElementById('calc-subtotal-renovation'),
      outSubtotalEquipment: document.getElementById('calc-subtotal-equipment'),
      outSubtotalOperational: document.getElementById('calc-subtotal-operational'),
      outSubtotalContingency: document.getElementById('calc-subtotal-contingency'),
      outTotalCapital: document.getElementById('calc-total-capital'),
      outFeasibilityPoints: document.getElementById('calc-feasibility-points'),
      outFeasibilityGrade: document.getElementById('calc-feasibility-grade'),
      outBudgetStatus: document.getElementById('calc-budget-status'),
      // Saved plans list di sidebar
      savedPlansList: document.getElementById('saved-plans-list'),
      savedPlansCount: document.getElementById('saved-plans-count'),
      clearPlansBtn: document.getElementById('btn-clear-plans'),
      clearPlansConfirm: document.getElementById('clear-plans-confirm'),
      confirmClearYesBtn: document.getElementById('btn-confirm-clear-yes'),
      confirmClearNoBtn: document.getElementById('btn-confirm-clear-no'),
      downloadAllBtn: document.getElementById('btn-download-all-plans'),
      liveRegion: document.getElementById('live-region'),
    };

    this.bindEvents();
    this.renderSavedPlans();
  }

  bindEvents() {
    if (this.els.closeBtn) {
      this.els.closeBtn.addEventListener('click', () => this.closeModal());
    }
    if (this.els.cancelBtn) {
      this.els.cancelBtn.addEventListener('click', () => this.closeModal());
    }

    if (this.els.form) {
      this.els.form.addEventListener('input', () => this.updateCalculator());
      this.els.form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.saveCurrentPlan();
      });
    }

    if (this.els.saveBtn) {
      this.els.saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.saveCurrentPlan();
      });
    }

    if (this.els.modalDownloadBtn) {
      this.els.modalDownloadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.downloadCurrentModalPlan();
      });
    }

    if (this.els.downloadAllBtn) {
      this.els.downloadAllBtn.addEventListener('click', () => {
        try {
          this.storage.downloadAllPlans();
          this.announce('Semua rencana kafe berhasil diunduh sebagai JSON.');
        } catch (err) {
          this.announce(`Gagal mengunduh: ${err.message}`);
        }
      });
    }

    // Konfirmasi inline keyboard-accessible untuk hapus semua rencana (tanpa window.confirm)
    if (this.els.clearPlansBtn && this.els.clearPlansConfirm) {
      this.els.clearPlansBtn.addEventListener('click', () => {
        this.els.clearPlansConfirm.hidden = false;
        if (this.els.confirmClearYesBtn) {
          this.els.confirmClearYesBtn.focus();
        }
      });

      if (this.els.confirmClearYesBtn) {
        this.els.confirmClearYesBtn.addEventListener('click', () => {
          this.storage.clearPlans();
          this.renderSavedPlans();
          this.announce('Seluruh rencana kafe tersimpan telah dihapus.');
          this.els.clearPlansConfirm.hidden = true;
          this.els.clearPlansBtn?.focus();
        });
      }

      if (this.els.confirmClearNoBtn) {
        this.els.confirmClearNoBtn.addEventListener('click', () => {
          this.els.clearPlansConfirm.hidden = true;
          this.els.clearPlansBtn?.focus();
        });
      }

      this.els.clearPlansConfirm.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          this.els.clearPlansConfirm.hidden = true;
          this.els.clearPlansBtn?.focus();
        }
      });
    }

    // Tangani escape dan backdrop klik pada dialog modal HTML5
    if (this.els.modal && this.els.modal.tagName === 'DIALOG') {
      this.els.modal.addEventListener('cancel', () => {
        this.currentLand = null;
        this.currentPlanId = null;
        if (this.previousActiveElement && typeof this.previousActiveElement.focus === 'function') {
          this.previousActiveElement.focus();
          this.previousActiveElement = null;
        }
      });

      this.els.modal.addEventListener('click', (e) => {
        if (e.target === this.els.modal) {
          const rect = this.els.modal.getBoundingClientRect();
          const isInDialog =
            rect.top <= e.clientY &&
            e.clientY <= rect.top + rect.height &&
            rect.left <= e.clientX &&
            e.clientX <= rect.left + rect.width;
          if (!isInDialog) {
            this.closeModal();
          }
        }
      });
    }
  }

  announce(msg) {
    if (this.els.liveRegion) {
      this.els.liveRegion.textContent = msg;
    }
  }

  showModalError(msg) {
    if (this.els.guardAlert) {
      this.els.guardAlert.hidden = false;
      this.els.guardAlert.textContent = msg;
    }
    this.announce(msg);
  }

  /**
   * Buka modal untuk merencanakan kafe pada kandidat lahan tertentu
   * @param {Object} landData Objek kandidat lahan
   * @param {Object} [existingPlan] Data rencana yang ingin dimuat kembali
   * @returns {{ opened: boolean, reasons?: string[] }}
   */
  openModal(landData, existingPlan = null) {
    if (!this.els.modal) return { opened: false, reasons: ['Elemen modal tidak ditemukan di DOM.'] };

    // Simpan referensi elemen aktif sebelumnya untuk pengembalian fokus (WCAG 2.1)
    if (typeof document !== 'undefined') {
      this.previousActiveElement = document.activeElement;
    }

    // Evaluasi Guard
    const guard = canPlanForLand(landData);
    if (!guard.eligible) {
      console.warn('[planner] Guard memblokir perencanaan untuk lahan:', landData?.id, guard.reasons);
      if (this.els.guardAlert) {
        this.els.guardAlert.hidden = false;
        this.els.guardAlert.textContent = `Lahan tidak memenuhi syarat: ${guard.reasons.join(' ')}`;
      }
      return { opened: false, reasons: guard.reasons };
    }

    if (this.els.guardAlert) {
      this.els.guardAlert.hidden = true;
    }

    // Evaluasi Banner Peringatan Skenario Sintetis & Data Demo
    const rawKind = String(landData?.data_kind || landData?.source || '').toLowerCase();
    const isScenario =
      landData?.data_kind === 'synthetic_scenario' ||
      landData?.simulated === true ||
      landData?.is_scenario === true ||
      /(scenario|skenario)/.test(rawKind);

    // Klasifikasi Data: Memastikan observasi Street View empiris tidak dianggap sebagai data demo sintetis.
    const isSurveyObservation = /^survey/.test(rawKind);
    const isDemo =
      !isScenario &&
      !isSurveyObservation &&
      (landData?.is_synthetic_demo === true ||
      landData?.is_factual === false ||
      /(demo|synthetic|simulasi|dummy|sample)/.test(rawKind) ||
      !landData?.is_verified_public);

    if (this.els.scenarioWarning) {
      this.els.scenarioWarning.hidden = !isScenario;
      if (isScenario && this.els.scenarioWarningText) {
        if (landData?.random_placement || landData?.is_random_placement) {
          this.els.scenarioWarningText.innerHTML =
            '<strong>Peringatan Skenario Sintetis (Penempatan Spasial Acak):</strong> Lokasi ini ditempatkan secara acak untuk keperluan simulasi skenario (bukan listing properti faktual maupun survei riil). Angka sewa dan luas adalah nilai hipotetis yang wajib disesuaikan pada formulir di bawah.';
        } else {
          this.els.scenarioWarningText.innerHTML =
            '<strong>Peringatan Skenario Sintetis (Simulasi Hipotetis):</strong> Lokasi ini merupakan titik simulasi skenario (bukan listing properti faktual maupun survei riil). Angka sewa dan luas adalah nilai hipotetis yang wajib disesuaikan pada formulir di bawah.';
        }
      }
    }

    if (this.els.demoWarning) {
      this.els.demoWarning.hidden = !isDemo;
    }

    this.currentLand = landData;
    this.currentPlanId = existingPlan ? existingPlan.id : null;

    // Isi informasi lahan
    if (this.els.landName) this.els.landName.textContent = landData.name || landData.id;
    if (this.els.landAddress) this.els.landAddress.textContent = landData.address || '—';
    if (this.els.landCampus) {
      this.els.landCampus.textContent =
        landData.nearest_university_name || landData.nearest_university_id || landData.institution || '—';
    }
    if (this.els.landDistance) {
      const d = landData.distance_meters != null ? Math.round(landData.distance_meters) : null;
      this.els.landDistance.textContent = d != null ? `${d} meter dari kampus` : 'Dalam radius buffer 1 km';
    }
    if (this.els.statusBadge) {
      if (isScenario) {
        this.els.statusBadge.textContent = landData?.is_random_placement
          ? 'Skenario (Penempatan Acak)'
          : 'Skenario Sintetis (Simulasi)';
        this.els.statusBadge.className = 'badge-eligible badge-scenario';
      } else {
        this.els.statusBadge.textContent = landData.status?.label || landData.status || 'Memenuhi Syarat';
        this.els.statusBadge.className = 'badge-eligible';
      }
    }

    // Isi form default atau dari existingPlan
    const defaultCafeName = existingPlan?.cafe_name || `Kafe Baru ${landData.name || ''}`.trim();
    if (this.els.cafeNameInput) this.els.cafeNameInput.value = defaultCafeName;
    if (this.els.targetCustInput) {
      this.els.targetCustInput.value =
        existingPlan?.target_customer || `Mahasiswa ${landData.institution || 'Kampus Sekitar'}`;
    }

    // Penanganan Nilai Kosong (Prompt B):
    // Jika rental_price_yr atau area_sqm null/undefined, kosongkan field dan minta pengguna mengisi; jangan isi 0
    if (this.els.areaInput) {
      const areaVal = existingPlan?.params?.area_sqm ?? landData.area_sqm ?? null;
      if (areaVal != null && areaVal !== '' && Number(areaVal) > 0) {
        this.els.areaInput.value = areaVal;
        this.els.areaInput.placeholder = 'Contoh: 150';
      } else {
        this.els.areaInput.value = '';
        this.els.areaInput.placeholder = 'Wajib diisi: masukkan luas lahan (m²)';
      }
    }

    if (this.els.rentalPriceInput) {
      const rentVal = existingPlan?.params?.rental_price_yr ?? landData.rental_price_yr ?? null;
      if (rentVal != null && rentVal !== '' && Number(rentVal) > 0) {
        this.els.rentalPriceInput.value = rentVal;
        this.els.rentalPriceInput.placeholder = 'Contoh: 60000000';
      } else {
        this.els.rentalPriceInput.value = '';
        this.els.rentalPriceInput.placeholder = 'Wajib diisi: masukkan harga sewa per tahun (Rp)';
      }
    }

    if (this.els.rentalDurationInput) {
      this.els.rentalDurationInput.value =
        existingPlan?.params?.rental_duration_yr ?? DEFAULT_PLAN_COSTS.rental_duration_yr;
    }
    if (this.els.renovationRateInput) {
      this.els.renovationRateInput.value =
        existingPlan?.params?.renovation_cost_per_sqm ?? DEFAULT_PLAN_COSTS.renovation_cost_per_sqm;
    }
    if (this.els.equipmentInput) {
      this.els.equipmentInput.value =
        existingPlan?.params?.equipment_cost ?? DEFAULT_PLAN_COSTS.equipment_cost;
    }
    if (this.els.monthlyOpsInput) {
      this.els.monthlyOpsInput.value =
        existingPlan?.params?.monthly_operational_cost ?? DEFAULT_PLAN_COSTS.monthly_operational_cost;
    }
    if (this.els.workingMonthsInput) {
      this.els.workingMonthsInput.value =
        existingPlan?.params?.working_capital_months ?? DEFAULT_PLAN_COSTS.working_capital_months;
    }
    if (this.els.contingencyInput) {
      this.els.contingencyInput.value =
        existingPlan?.params?.contingency_cost ?? DEFAULT_PLAN_COSTS.contingency_cost;
    }
    if (this.els.budgetLimitInput) {
      this.els.budgetLimitInput.value = existingPlan?.params?.budget_limit || '';
    }

    // Jalankan rekalkulasi awal
    this.updateCalculator();

    // Tampilkan modal
    if (typeof this.els.modal.showModal === 'function') {
      if (!this.els.modal.open) {
        this.els.modal.showModal();
      }
    } else {
      this.els.modal.setAttribute('open', '');
      this.els.modal.hidden = false;
    }

    // Focus ke input pertama untuk alur keyboard yang intuitif
    setTimeout(() => {
      if (this.els.cafeNameInput) this.els.cafeNameInput.focus();
    }, 50);

    return { opened: true };
  }

  closeModal() {
    if (!this.els.modal) return;
    if (this.els.modal.open) {
      if (typeof this.els.modal.close === 'function') {
        this.els.modal.close();
      } else {
        this.els.modal.removeAttribute('open');
        this.els.modal.hidden = true;
      }
    }
    this.currentLand = null;
    this.currentPlanId = null;

    // Kembalikan fokus ke pemicu sebelumnya
    if (this.previousActiveElement && typeof this.previousActiveElement.focus === 'function') {
      this.previousActiveElement.focus();
      this.previousActiveElement = null;
    }
  }

  getFormParams() {
    const parseNumOrNull = (val) => {
      if (val == null) return null;
      const s = String(val).trim();
      if (s === '') return null;
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : null;
    };

    return {
      area_sqm: parseNumOrNull(this.els.areaInput?.value),
      rental_price_yr: parseNumOrNull(this.els.rentalPriceInput?.value),
      rental_duration_yr: Number(this.els.rentalDurationInput?.value || 1),
      renovation_cost_per_sqm: Number(this.els.renovationRateInput?.value || DEFAULT_PLAN_COSTS.renovation_cost_per_sqm),
      equipment_cost: Number(this.els.equipmentInput?.value || DEFAULT_PLAN_COSTS.equipment_cost),
      monthly_operational_cost: Number(this.els.monthlyOpsInput?.value || DEFAULT_PLAN_COSTS.monthly_operational_cost),
      working_capital_months: Number(this.els.workingMonthsInput?.value || DEFAULT_PLAN_COSTS.working_capital_months),
      contingency_cost: Number(this.els.contingencyInput?.value || DEFAULT_PLAN_COSTS.contingency_cost),
      budget_limit: Number(this.els.budgetLimitInput?.value || 0),
    };
  }

  updateCalculator() {
    const params = this.getFormParams();
    const result = calculateInitialCapital(params, this.currentLand);

    if (this.els.outSubtotalRental) {
      this.els.outSubtotalRental.textContent = formatRupiah(result.subtotal_rental);
    }
    if (this.els.outSubtotalRenovation) {
      this.els.outSubtotalRenovation.textContent = formatRupiah(result.subtotal_renovation);
    }
    if (this.els.outSubtotalEquipment) {
      this.els.outSubtotalEquipment.textContent = formatRupiah(result.subtotal_equipment);
    }
    if (this.els.outSubtotalOperational) {
      this.els.outSubtotalOperational.textContent = formatRupiah(result.subtotal_operational);
    }
    if (this.els.outSubtotalContingency) {
      this.els.outSubtotalContingency.textContent = formatRupiah(result.subtotal_contingency);
    }
    if (this.els.outTotalCapital) {
      this.els.outTotalCapital.textContent = formatRupiah(result.total_initial_capital);
    }
    if (this.els.outFeasibilityPoints) {
      this.els.outFeasibilityPoints.textContent = `${result.feasibility_points} / 100 Poin`;
    }
    if (this.els.outFeasibilityGrade) {
      this.els.outFeasibilityGrade.textContent = result.feasibility_grade;
    }
    if (this.els.outBudgetStatus) {
      if (result.budget_limit > 0) {
        if (result.is_within_budget) {
          this.els.outBudgetStatus.className = 'budget-status status-ok';
          this.els.outBudgetStatus.textContent = `✓ Sesuai Anggaran (Sisa: ${formatRupiah(result.budget_difference)})`;
        } else {
          this.els.outBudgetStatus.className = 'budget-status status-over';
          this.els.outBudgetStatus.textContent = `✕ Melebihi Anggaran (+${formatRupiah(Math.abs(result.budget_difference))})`;
        }
        this.els.outBudgetStatus.hidden = false;
      } else {
        this.els.outBudgetStatus.hidden = true;
      }
    }

    return result;
  }

  downloadCurrentModalPlan() {
    if (!this.currentLand) {
      this.showModalError('Tidak ada data lahan yang dipilih.');
      return;
    }

    const cafeName = (this.els.cafeNameInput?.value || '').trim() || 'Rencana Kafe Baru';
    const targetCustomer = (this.els.targetCustInput?.value || '').trim();
    const params = this.getFormParams();
    const calculation = calculateInitialCapital(params, this.currentLand);

    const planPayload = {
      id: this.currentPlanId || `PLAN-${Date.now()}`,
      cafe_name: cafeName,
      target_customer: targetCustomer,
      land: {
        id: this.currentLand.id,
        name: this.currentLand.name,
        address: this.currentLand.address,
        status: this.currentLand.status?.value || this.currentLand.status,
        nearest_university_id: this.currentLand.nearest_university_id,
        nearest_university_name: this.currentLand.nearest_university_name,
        distance_meters: this.currentLand.distance_meters,
        is_in_buffer: this.currentLand.is_in_buffer,
        institution: this.currentLand.institution,
        coordinates: this.currentLand.coordinates,
        data_kind: this.currentLand.data_kind || null,
        simulated: this.currentLand.simulated === true,
        is_scenario: Boolean(this.currentLand.is_scenario),
        is_random_placement: Boolean(this.currentLand.is_random_placement),
      },
      params,
      calculation,
    };

    try {
      downloadPlanAsJson(planPayload);
      this.announce(`Rencana "${cafeName}" berhasil diunduh sebagai JSON.`);
    } catch (err) {
      this.showModalError(`Gagal mengunduh rencana: ${err.message}`);
    }
  }

  saveCurrentPlan() {
    if (!this.currentLand) {
      this.showModalError('Tidak ada data lahan yang dipilih.');
      return;
    }

    const cafeName = (this.els.cafeNameInput?.value || '').trim() || 'Rencana Kafe Baru';
    const targetCustomer = (this.els.targetCustInput?.value || '').trim();
    const params = this.getFormParams();
    const calculation = calculateInitialCapital(params, this.currentLand);

    const planPayload = {
      id: this.currentPlanId,
      cafe_name: cafeName,
      target_customer: targetCustomer,
      land: {
        id: this.currentLand.id,
        name: this.currentLand.name,
        address: this.currentLand.address,
        status: this.currentLand.status?.value || this.currentLand.status,
        nearest_university_id: this.currentLand.nearest_university_id,
        nearest_university_name: this.currentLand.nearest_university_name,
        distance_meters: this.currentLand.distance_meters,
        is_in_buffer: this.currentLand.is_in_buffer,
        institution: this.currentLand.institution,
        coordinates: this.currentLand.coordinates,
        data_kind: this.currentLand.data_kind || null,
        simulated: this.currentLand.simulated === true,
        is_scenario: Boolean(this.currentLand.is_scenario),
        is_random_placement: Boolean(this.currentLand.is_random_placement),
      },
      params,
      calculation,
    };

    try {
      const savedRecord = this.storage.savePlan(planPayload);
      this.renderSavedPlans();
      if (typeof this.onPlanSaved === 'function') {
        this.onPlanSaved(savedRecord);
      }
      this.closeModal();
      this.announce(`Rencana kafe "${cafeName}" berhasil disimpan ke browser.`);
    } catch (err) {
      this.showModalError(`Gagal menyimpan: ${err.message}`);
    }
  }

  renderSavedPlans() {
    if (!this.els.savedPlansList) return;
    const plans = this.storage.loadPlans();

    if (this.els.savedPlansCount) {
      this.els.savedPlansCount.textContent = `(${plans.length})`;
    }
    if (this.els.clearPlansBtn) {
      this.els.clearPlansBtn.hidden = plans.length === 0;
    }
    if (this.els.clearPlansConfirm) {
      this.els.clearPlansConfirm.hidden = true;
    }
    if (this.els.downloadAllBtn) {
      this.els.downloadAllBtn.hidden = plans.length === 0;
    }

    if (!plans.length) {
      this.els.savedPlansList.innerHTML = `
        <li class="muted saved-plans-empty">
          Belum ada rencana tersimpan. Klik marker lahan yang memenuhi syarat di peta atau tombol "Rencanakan Modal Kafe" untuk memulai.
        </li>
      `;
      return;
    }

    this.els.savedPlansList.innerHTML = '';
    for (const p of plans) {
      const li = document.createElement('li');
      li.className = 'saved-plan-card';

      const dateStr = p.created_at ? new Date(p.created_at).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }) : '—';

      const isScenarioPlan = Boolean(
        p.land?.is_scenario ||
        p.land?.simulated === true ||
        p.land?.data_kind === 'synthetic_scenario'
      );
      const scenarioTag = isScenarioPlan
        ? `<span class="tag-scenario">${p.land?.is_random_placement ? '🎲 Acak' : '🧪 Skenario'}</span>`
        : '';

      li.innerHTML = `
        <div class="saved-plan-header">
          <strong class="saved-plan-title">${escapeHtml(p.cafe_name)}${scenarioTag}</strong>
          <span class="saved-plan-date">${dateStr}</span>
        </div>
        <div class="saved-plan-meta">
          <span>${escapeHtml(p.land?.name || 'Lahan')}</span> · 
          <span>${escapeHtml(p.land?.institution || p.land?.nearest_university_name || 'Kampus')}</span>
        </div>
        <div class="saved-plan-capital">
          Total: <strong>${formatRupiah(p.calculation?.total_initial_capital)}</strong>
          ${p.calculation?.feasibility_points != null ? `<span class="saved-plan-score"> · Skor: <strong>${p.calculation.feasibility_points}/100</strong> (${escapeHtml(p.calculation.feasibility_grade || '')})</span>` : ''}
        </div>
        <div class="saved-plan-actions">
          <button type="button" class="btn-sm btn-open-plan" data-id="${escapeHtml(p.id)}">Buka &amp; Edit</button>
          <button type="button" class="btn-sm btn-download-plan" data-id="${escapeHtml(p.id)}" aria-label="Unduh berkas JSON rencana ${escapeHtml(p.cafe_name)}">Unduh JSON</button>
          <button type="button" class="btn-sm btn-delete-plan" data-id="${escapeHtml(p.id)}" aria-label="Hapus rencana ${escapeHtml(p.cafe_name)}">Hapus</button>
        </div>
        <div class="inline-confirm-box" role="alertdialog" aria-labelledby="confirm-del-${escapeHtml(p.id)}" hidden>
          <span id="confirm-del-${escapeHtml(p.id)}">Hapus rencana <strong>${escapeHtml(p.cafe_name)}</strong>?</span>
          <div class="inline-confirm-actions">
            <button type="button" class="btn-sm btn-danger btn-confirm-delete-yes" data-id="${escapeHtml(p.id)}">Ya, Hapus</button>
            <button type="button" class="btn-sm btn-confirm-delete-no">Batal</button>
          </div>
        </div>
      `;

      const actionsDiv = li.querySelector('.saved-plan-actions');
      const confirmDiv = li.querySelector('.inline-confirm-box');
      const deleteBtn = li.querySelector('.btn-delete-plan');
      const confirmYesBtn = li.querySelector('.btn-confirm-delete-yes');
      const confirmNoBtn = li.querySelector('.btn-confirm-delete-no');

      // Event listener tombol buka
      li.querySelector('.btn-open-plan').addEventListener('click', () => {
        this.openModal(p.land, p);
      });

      // Event listener tombol unduh JSON per rencana
      li.querySelector('.btn-download-plan').addEventListener('click', () => {
        try {
          this.storage.downloadPlan(p.id);
          this.announce(`Rencana "${p.cafe_name}" berhasil diunduh sebagai JSON.`);
        } catch (err) {
          this.announce(`Gagal mengunduh: ${err.message}`);
        }
      });

      // Event listener tombol hapus: Tampilkan konfirmasi inline aksesibel (tanpa window.confirm)
      deleteBtn.addEventListener('click', () => {
        actionsDiv.hidden = true;
        confirmDiv.hidden = false;
        confirmYesBtn.focus();
      });

      confirmNoBtn.addEventListener('click', () => {
        confirmDiv.hidden = true;
        actionsDiv.hidden = false;
        deleteBtn.focus();
      });

      confirmYesBtn.addEventListener('click', () => {
        this.storage.deletePlan(p.id);
        this.renderSavedPlans();
        this.announce(`Rencana "${p.cafe_name}" telah dihapus.`);
        if (typeof this.onPlanDeleted === 'function') {
          this.onPlanDeleted(p.id);
        }
      });

      confirmDiv.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          confirmDiv.hidden = true;
          actionsDiv.hidden = false;
          deleteBtn.focus();
        }
      });

      this.els.savedPlansList.appendChild(li);
    }
  }
}

export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inisialisasi Modul Planner & Pendaftaran Kontrak Global
 */
export function initPlanner() {
  const storage = new PlanStorage();
  let ui = null;

  if (typeof document !== 'undefined') {
    ui = new PlannerUI({ storage });
  }

  // Daftarkan window.handleLandMarkerClick sesuai kontrak integrasi GIS
  const handleMarkerClick = function (landData) {
    if (!landData) return false;

    const guard = canPlanForLand(landData);
    if (!guard.eligible) {
      console.info('[planner] Lahan tidak memenuhi syarat perencanaan kafe:', guard.reasons.join(' '));
      return false;
    }

    if (ui) {
      ui.openModal(landData);
    }
    return true;
  };

  if (typeof window !== 'undefined') {
    window.handleLandMarkerClick = handleMarkerClick;
    // Daftarkan juga fallback alias window.handleLandClick
    window.handleLandClick = handleMarkerClick;
    window.bukaKafePlanner = {
      storage,
      ui,
      canPlanForLand,
      calculateInitialCapital,
      calculateFeasibilityPoints,
      formatRupiah,
      downloadPlanAsJson,
      triggerFileDownload,
      openPlannerModal: (landData, existingPlan) => ui?.openModal(landData, existingPlan),
    };
  }

  return { storage, ui, handleMarkerClick };
}

// Inisialisasi otomatis jika berjalan di peramban
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initPlanner());
  } else {
    initPlanner();
  }
}
