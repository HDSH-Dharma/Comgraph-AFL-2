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

export const DEFAULT_PLAN_COSTS = Object.freeze({
  renovation_cost_per_sqm: 1_500_000,     // Rp 1.500.000 / m²
  equipment_cost: 45_000_000,             // Rp 45.000.000 (mesin espresso, grinder, POS, dsb)
  monthly_operational_cost: 15_000_000,   // Rp 15.000.000 / bulan (gaji, bahan baku, listrik/WiFi)
  working_capital_months: 3,              // 3 bulan cadangan operasional
  contingency_cost: 10_000_000,           // Rp 10.000.000 (perizinan, kontingensi)
  rental_duration_yr: 1,                  // 1 tahun durasi sewa default
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
 * Menilai aspek strategis dalam lingkup game "Buka Kafe":
 * 1. Proksimitas kampus (jarak metrik <= 1000m): maks 40 poin
 * 2. Kesesuaian luas lahan (80 - 250 m² optimal untuk kafe mahasiswa): maks 30 poin
 * 3. Efisiensi harga sewa per m²: maks 30 poin
 *
 * @param {Object} params
 * @returns {{ points: number, grade: string, breakdown: { proximity: number, space: number, cost_efficiency: number } }}
 */
export function calculateFeasibilityPoints({ distance_meters = null, area_sqm = 0, rental_price_yr = 0 } = {}) {
  let proximityScore = 20; // default dalam buffer 1km
  const dist = typeof distance_meters === 'number' && Number.isFinite(distance_meters) ? distance_meters : null;
  if (dist != null) {
    if (dist <= 300) proximityScore = 40;
    else if (dist <= 600) proximityScore = 30;
    else if (dist <= 1000) proximityScore = 20;
    else proximityScore = 0;
  }

  let spaceScore = 15;
  const area = typeof area_sqm === 'number' && Number.isFinite(area_sqm) ? area_sqm : 0;
  if (area >= 80 && area <= 250) spaceScore = 30;
  else if ((area >= 50 && area < 80) || (area > 250 && area <= 400)) spaceScore = 20;
  else if (area > 0) spaceScore = 10;
  else spaceScore = 0;

  let costScore = 15;
  const rent = typeof rental_price_yr === 'number' && Number.isFinite(rental_price_yr) ? rental_price_yr : 0;
  if (area > 0 && rent > 0) {
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
  const num = (v, def = 0) => {
    const parsed = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : def;
  };

  const area_sqm = num(params.area_sqm, 0);
  const rental_price_yr = num(params.rental_price_yr, 0);
  const rental_duration_yr = Math.max(1, Math.round(num(params.rental_duration_yr, DEFAULT_PLAN_COSTS.rental_duration_yr)));
  const renovation_cost_per_sqm = num(params.renovation_cost_per_sqm, DEFAULT_PLAN_COSTS.renovation_cost_per_sqm);
  const equipment_cost = num(params.equipment_cost, DEFAULT_PLAN_COSTS.equipment_cost);
  const monthly_operational_cost = num(params.monthly_operational_cost, DEFAULT_PLAN_COSTS.monthly_operational_cost);
  const working_capital_months = Math.max(0, Math.round(num(params.working_capital_months, DEFAULT_PLAN_COSTS.working_capital_months)));
  const contingency_cost = num(params.contingency_cost, DEFAULT_PLAN_COSTS.contingency_cost);
  const budget_limit = num(params.budget_limit, 0);

  const subtotal_rental = Math.round(rental_price_yr * rental_duration_yr);
  const subtotal_renovation = Math.round(area_sqm * renovation_cost_per_sqm);
  const subtotal_equipment = Math.round(equipment_cost);
  const subtotal_operational = Math.round(monthly_operational_cost * working_capital_months);
  const subtotal_contingency = Math.round(contingency_cost);

  const total_initial_capital =
    subtotal_rental + subtotal_renovation + subtotal_equipment + subtotal_operational + subtotal_contingency;

  const rawDist = params.distance_meters ?? landData?.distance_meters ?? landData?.distanceM ?? null;
  const distance_meters = typeof rawDist === 'number' && Number.isFinite(rawDist) ? rawDist : (Number(rawDist) || null);
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
          alert(`Gagal mengunduh: ${err.message}`);
        }
      });
    }

    if (this.els.clearPlansBtn) {
      this.els.clearPlansBtn.addEventListener('click', () => {
        if (confirm('Hapus seluruh rencana kafe tersimpan?')) {
          this.storage.clearPlans();
          this.renderSavedPlans();
          this.announce('Seluruh rencana kafe tersimpan telah dihapus.');
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
      this.els.statusBadge.textContent = landData.status?.label || landData.status || 'Memenuhi Syarat';
    }

    // Isi form default atau dari existingPlan
    const defaultCafeName = existingPlan?.cafe_name || `Kafe Baru ${landData.name || ''}`.trim();
    if (this.els.cafeNameInput) this.els.cafeNameInput.value = defaultCafeName;
    if (this.els.targetCustInput) {
      this.els.targetCustInput.value =
        existingPlan?.target_customer || `Mahasiswa ${landData.institution || 'Kampus Sekitar'}`;
    }

    if (this.els.areaInput) {
      this.els.areaInput.value = existingPlan?.params?.area_sqm ?? landData.area_sqm ?? 200;
    }
    if (this.els.rentalPriceInput) {
      this.els.rentalPriceInput.value =
        existingPlan?.params?.rental_price_yr ?? landData.rental_price_yr ?? 60_000_000;
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
    return {
      area_sqm: Number(this.els.areaInput?.value || 0),
      rental_price_yr: Number(this.els.rentalPriceInput?.value || 0),
      rental_duration_yr: Number(this.els.rentalDurationInput?.value || 1),
      renovation_cost_per_sqm: Number(this.els.renovationRateInput?.value || 0),
      equipment_cost: Number(this.els.equipmentInput?.value || 0),
      monthly_operational_cost: Number(this.els.monthlyOpsInput?.value || 0),
      working_capital_months: Number(this.els.workingMonthsInput?.value || 0),
      contingency_cost: Number(this.els.contingencyInput?.value || 0),
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
      alert('Tidak ada data lahan yang dipilih.');
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
      },
      params,
      calculation,
    };

    try {
      downloadPlanAsJson(planPayload);
      this.announce(`Rencana "${cafeName}" berhasil diunduh sebagai JSON.`);
    } catch (err) {
      alert(`Gagal mengunduh rencana: ${err.message}`);
    }
  }

  saveCurrentPlan() {
    if (!this.currentLand) {
      alert('Tidak ada data lahan yang dipilih.');
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
      alert(`Gagal menyimpan: ${err.message}`);
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

      li.innerHTML = `
        <div class="saved-plan-header">
          <strong class="saved-plan-title">${escapeHtml(p.cafe_name)}</strong>
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
          <button type="button" class="btn-sm btn-open-plan" data-id="${p.id}">Buka &amp; Edit</button>
          <button type="button" class="btn-sm btn-download-plan" data-id="${p.id}" aria-label="Unduh berkas JSON rencana ${escapeHtml(p.cafe_name)}">Unduh JSON</button>
          <button type="button" class="btn-sm btn-delete-plan" data-id="${p.id}" aria-label="Hapus rencana ${escapeHtml(p.cafe_name)}">Hapus</button>
        </div>
      `;

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
          alert(`Gagal mengunduh: ${err.message}`);
        }
      });

      // Event listener tombol hapus
      li.querySelector('.btn-delete-plan').addEventListener('click', () => {
        if (confirm(`Hapus rencana "${p.cafe_name}"?`)) {
          this.storage.deletePlan(p.id);
          this.renderSavedPlans();
          this.announce(`Rencana "${p.cafe_name}" telah dihapus.`);
          if (typeof this.onPlanDeleted === 'function') {
            this.onPlanDeleted(p.id);
          }
        }
      });

      this.els.savedPlansList.appendChild(li);
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
