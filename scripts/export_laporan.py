"""Ekspor tabel & ringkasan laporan dari hasil pipeline (jalankan setelah gis_pipeline.py).

Menghasilkan di data/processed/:
- hasil_per_kampus.csv     : perbandingan baseline 500 m vs skenario 1 km per kampus
- peringkat_kandidat.csv   : kandidat lahan diurutkan dari skor baseline 500 m
- ringkasan_untuk_laporan.txt : ringkasan siap salin ke laporan
- valid_observed_candidates.csv : semua kandidat observasi Street View
dan notebooks/analisis_summary.txt (ringkasan transparan notebook).
"""
import csv
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PROC = os.path.join(ROOT, "data", "processed")


def load(name):
    with open(os.path.join(PROC, name), "r", encoding="utf-8") as f:
        return json.load(f)


def score(p, key):
    s = p.get(key) or {}
    return s.get("score_normalized"), s.get("coverage")


def main(proc_dir=PROC):
    global PROC
    PROC = proc_dir
    unis = [f["properties"] for f in load("universities.geojson")["features"]]
    cands = [f["properties"] for f in load("land_candidates.geojson")["features"]]
    cafes = [f["properties"] for f in load("osm_cafes.geojson")["features"]]

    rows = []
    for u in unis:
        uid = u["id"]
        uc = [c for c in cands if c.get("nearest_university_id") == uid]
        kc = [c for c in cafes if c.get("nearest_university_id") == uid]
        rows.append({
            "kampus_id": uid,
            "nama_kampus": u.get("campus_name"),
            "kafe_osm_500m": sum(1 for c in kc if c.get("is_in_buffer_500m")),
            "kafe_osm_1000m": sum(1 for c in kc if c.get("is_in_buffer_1000m")),
            "kandidat_teramati": len(uc),
            "kandidat_dalam_500m": sum(1 for c in uc if c.get("is_in_buffer_500m")),
            "kandidat_dalam_1000m": sum(1 for c in uc if c.get("is_in_buffer_1000m")),
            "layak_500m": sum(1 for c in uc if c.get("is_eligible_500m")),
            "layak_1000m": sum(1 for c in uc if c.get("is_eligible_1000m")),
            "di_jalan_utama": sum(1 for c in uc if c.get("road_type") in ("utama", "arteri", "primary", "secondary")),
        })
    with open(os.path.join(PROC, "hasil_per_kampus.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    rank = []
    for c in cands:
        s500, cov = score(c, "feasibility_scoring_baseline_500m")
        s1k, _ = score(c, "feasibility_scoring")
        rank.append({
            "id": c.get("id"),
            "nama": c.get("name"),
            "alamat": c.get("address"),
            "kampus_terdekat": c.get("nearest_university_id"),
            "jarak_ke_kampus_m": round(c["distance_meters"], 1) if c.get("distance_meters") is not None else "",
            "status_lahan": c.get("status"),
            "tipe_jalan": c.get("road_type") or "",
            "kafe_osm_sekitar_500m": c.get("nearby_cafes_count"),
            "layak_500m": c.get("is_eligible_500m"),
            "layak_1000m": c.get("is_eligible_1000m"),
            "skor_500m": s500,
            "skor_1000m": s1k,
            "cakupan_data_pct": cov,
            "bukti_street_view": c.get("evidence_url") or "",
        })
    rank.sort(key=lambda r: (not r["layak_500m"], not r["layak_1000m"], -(r["skor_500m"] or 0)))
    for i, r in enumerate(rank, 1):
        r["peringkat"] = i
    fields = ["peringkat"] + [k for k in rank[0].keys() if k != "peringkat"]
    with open(os.path.join(PROC, "peringkat_kandidat.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rank)

    tot = lambda k: sum(r[k] for r in rows)
    layak = [r for r in rank if r["layak_500m"] or r["layak_1000m"]]
    lines = [
        "RINGKASAN HASIL ANALISIS SPASIAL - BUKA KAFE DEKAT KAMPUS SURABAYA",
        "",
        "Data dan CRS",
        "- Kampus: 8 kampus (Unair A/B/C, UKWMS Dinoyo/Kalijudan/Pakuwon, Ubaya Ngagel/Tenggilis), poligon dari OpenStreetMap.",
        f"- Kafe eksisting: {len(cafes)} titik kafe OpenStreetMap (Overpass API, ODbL).",
        f"- Kandidat lahan: {len(cands)} titik observasi Google Street View (1-2 Nov 2026), wajib ditinjau tim.",
        "- Penyimpanan EPSG:4326 (WGS84); perhitungan jarak dan buffer di EPSG:32749 (UTM 49S, meter).",
        "",
        "Operasi GIS",
        "- Buffer 500 m (baseline) dan 1 km (skenario) dari poligon kampus.",
        "- Spatial join: kandidat lahan dan kafe OSM ke kampus terdekat (point-in-polygon + jarak terdekat).",
        "",
        "Baseline 500 m vs skenario 1 km",
        f"- Kafe OSM dalam buffer: {tot('kafe_osm_500m')} (500 m) vs {tot('kafe_osm_1000m')} (1 km).",
        f"- Kandidat dalam buffer: {tot('kandidat_dalam_500m')} (500 m) vs {tot('kandidat_dalam_1000m')} (1 km).",
        f"- Kandidat layak (lahan kosong/disewakan): {tot('layak_500m')} (500 m) vs {tot('layak_1000m')} (1 km).",
        "",
        "Kandidat layak (urut skor baseline 500 m):",
    ]
    for r in layak:
        lines.append(f"- {r['id']} {r['nama']} ({r['kampus_terdekat']}, {r['jarak_ke_kampus_m']} m, jalan: {r['tipe_jalan'] or 'belum diamati'}, skor 500 m: {r['skor_500m']}, cakupan {r['cakupan_data_pct']}%)")
    if not layak:
        lines.append("- Tidak ada.")
    lines += [
        "",
        "Keterbatasan",
        "- Observasi lahan memakai Google Street View; tanggal citra bervariasi (2024-2026) sehingga kondisi terkini bisa berbeda.",
        "- Harga sewa dan luas lahan belum diketahui untuk sebagian besar kandidat, jadi cakupan skor < 60% dan bintang tidak ditampilkan.",
        "- Lokasi gerbang kampus belum teramati; jarak ke gerbang bernilai null.",
        "- Indikator keramaian mahasiswa belum disurvei; tipe jalan hanya diisi bila terlihat jelas di Street View.",
        "- Data kafe OSM bisa tidak lengkap (kafe baru/tutup belum tercatat).",
    ]
    with open(os.path.join(PROC, "ringkasan_untuk_laporan.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))

    tulis_kandidat_teramati(cands)
    tulis_ringkasan_notebook(cands, cafes)


KOLOM_KANDIDAT = [
    "id", "name", "address", "status", "nearest_university_id", "nearest_university_name",
    "distance_meters", "distance_to_polygon_meters", "is_in_buffer", "is_eligible",
    "is_rentable_or_sale", "survey_method", "observed_at", "imagery_date", "pano_id",
    "heading_deg", "road_type", "location_method", "evidence_url", "notes",
]


def tulis_kandidat_teramati(cands):
    """Semua kandidat observasi Street View dalam satu CSV (selalu sinkron dengan pipeline)."""
    with open(os.path.join(PROC, "valid_observed_candidates.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=KOLOM_KANDIDAT, extrasaction="ignore")
        w.writeheader()
        for c in cands:
            w.writerow({k: c.get(k) for k in KOLOM_KANDIDAT})


def tulis_ringkasan_notebook(cands, cafes):
    """Ringkasan transparan di notebooks/analisis_summary.txt, dihitung ulang dari data."""
    total = len(cands)
    layak = [c for c in cands if c.get("is_eligible")]
    per_status = {}
    for c in cands:
        per_status[c.get("status")] = per_status.get(c.get("status"), 0) + 1
    tanggal = sorted({c.get("observed_at") for c in cands if c.get("observed_at")})
    citra = sorted({c.get("imagery_date") for c in cands if c.get("imagery_date")})
    jalan = sum(1 for c in cands if c.get("road_type"))
    garis = "-" * 80
    out = [
        "RINGKASAN TRANSPARAN ANALISIS SPASIAL & DATASET BUKA KAFE SURABAYA",
        "=" * 80,
        "Mata Kuliah : Computer Graphics (AFL 2) - Universitas Ciputra Surabaya",
        "",
        "1. SUMBER DATA KANDIDAT LAHAN",
        garis,
        "- Sumber Observasi      : Google Street View (posisi kamera panorama, pano_id, arah pandang)",
        f"- Tanggal Observasi     : {', '.join(tanggal)}",
        f"- Tanggal Citra         : {citra[0] if citra else '-'} s.d. {citra[-1] if citra else '-'}",
        "- Status Keabsahan      : Wajib ditinjau ulang oleh seluruh anggota tim.",
        "- Catatan Penting       : Bukan survei lapangan fisik.",
        f"- Total Titik Observasi : {total} titik",
        f"- Titik Dalam Buffer 1km: {sum(1 for c in cands if c.get('is_in_buffer_1000m'))} titik",
        f"- Titik Dalam Buffer 500m: {sum(1 for c in cands if c.get('is_in_buffer_500m'))} titik",
        f"- Titik Memenuhi Syarat : {len(layak)} titik (Lahan kosong / Tersedia disewakan, dalam 1 km)",
        f"- Titik Tidak Memenuhi  : {total - len(layak)} titik",
        f"- Tipe Jalan Teramati   : {jalan} titik (sisanya null)",
        "",
        "Rincian Status Lahan:",
    ]
    for status, n in sorted(per_status.items(), key=lambda kv: -kv[1]):
        out.append(f"- {status:<48}: {n} titik")
    out += ["", f"2. KANDIDAT YANG MEMENUHI SYARAT ({len(layak)})", garis]
    for i, c in enumerate(sorted(layak, key=lambda c: c.get("distance_meters") or 0), 1):
        out.append(f"{i}. {c.get('id')} ({c.get('name')})")
        out.append(f"   Jarak Kampus : {c.get('distance_meters', 0):.1f} m ke {c.get('nearest_university_name')} | Jalan: {c.get('road_type') or 'belum diamati'} | Pano ID: {c.get('pano_id')}")
    out += [
        "",
        "3. DATA PEMBANDING DAN KETERBATASAN",
        garis,
        f"- Kafe OSM              : {len(cafes)} titik (OpenStreetMap, ODbL)",
        "- Luas dan harga sewa   : null pada observasi Street View (tidak tertera di citra)",
        "- Listing sewa publik   : data/raw/rental_listing_evidence.csv (bukti URL per listing)",
        "- Gerbang kampus        : belum teramati jelas di Street View, jarak gerbang = null",
        "- Indikator mahasiswa   : belum disurvei, bernilai null",
        "- Skenario simulasi     : data/fixtures/synthetic_scenario_candidates.geojson (hipotetis, bukan data nyata)",
        "=" * 80,
    ]
    with open(os.path.join(ROOT, "notebooks", "analisis_summary.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else PROC)
