"""Ekspor tabel & ringkasan laporan dari hasil pipeline (jalankan setelah gis_pipeline.py).

Menghasilkan di data/processed/:
- hasil_per_kampus.csv     : perbandingan baseline 500 m vs skenario 1 km per kampus
- peringkat_kandidat.csv   : kandidat lahan diurutkan dari skor baseline 500 m
- ringkasan_untuk_laporan.txt : ringkasan siap salin ke laporan
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


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else PROC)
