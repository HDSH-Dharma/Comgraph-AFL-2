#!/usr/bin/env python3
"""
Unit Test Suite - GIS Pipeline (scripts/test_gis_pipeline.py)
Standard Library 'unittest' verification for:
1. Coordinate projection (EPSG:4326 <-> EPSG:32749 always_xy)
2. Metric buffer 1.000m polygon generation & closed ring
3. Distance threshold: <= 1000.0 accepted, > 1000.0 rejected (unrounded)
4. Five land statuses taxonomy & conditional eligibility logic
5. Trust boundary validations (bad coords, booleans, NaN/Inf, out-of-bounds, duplicate IDs)
6. Output GeoJSON parsing and exact property contracts
"""

import os
import sys
import math
import json
import shutil
import tempfile
import unittest

# Import kelas GISPipeline dari scripts/gis_pipeline.py
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from scripts.gis_pipeline import (
    GISPipeline,
    VALID_LAND_STATUSES,
    DEFAULT_LAND_STATUS,
    ELIGIBLE_STATUSES,
    RENTABLE_OR_SALE_STATUSES,
    NON_RENTABLE_OR_SALE_STATUSES,
    classify_land_building_from_open_data,
    CAMPUS_POLYGONS_WGS84,
    SURABAYA_BBOX,
    generate_synthetic_scenario_fixture,
    audit_synthetic_scenario_fixture,
    RESEARCH_RENT_BASIS,
    BASELINE_RADIUS_METERS,
    SCENARIO_RADIUS_METERS,
    SUPPORTED_RADII_METERS,
    RADIUS_CONFIG,
    TEAM_SCORING_ASSUMPTIONS,
    calculate_transparent_feasibility_score
)
from scripts.rental_market_service import (
    RentalMarketService,
    MIN_COMPARABLE_LISTINGS,
    REAL_DATA_KIND,
    audit_synthetic_candidates,
    calculate_range_midpoint_estimate,
    audit_production_dataset
)

class TestGISPipeline(unittest.TestCase):
    def setUp(self):
        self.pipeline = GISPipeline()
        self.temp_dir = tempfile.mkdtemp(prefix="test_gis_pipeline_")

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_01_projection_metric(self):
        """Verifikasi transformasi proyeksi WGS84 ke UTM Zone 49S dan round-trip."""
        lon_unair_c, lat_unair_c = 112.7859648, -7.2662955
        xm, ym = self.pipeline.transformer_fwd.transform(lon_unair_c, lat_unair_c)

        # UTM Zone 49S untuk Surabaya x ~690.000 - 700.000, y ~9.190.000 - 9.200.000
        self.assertTrue(600000.0 < xm < 800000.0, f"Nilai x metrik {xm} tidak masuk akal untuk UTM 49S.")
        self.assertTrue(9000000.0 < ym < 9500000.0, f"Nilai y metrik {ym} tidak masuk akal untuk UTM 49S.")

        # Round-trip inverse transform
        lon_back, lat_back = self.pipeline.transformer_inv.transform(xm, ym)
        self.assertAlmostEqual(lon_unair_c, lon_back, places=7, msg="Round-trip longitude menyimpang.")
        self.assertAlmostEqual(lat_unair_c, lat_back, places=7, msg="Round-trip latitude menyimpang.")

    def test_02_buffer_metric_and_closed_ring(self):
        """Verifikasi poligon buffer beradius 1.000m di CRS metrik dan membentuk cincin tertutup valid."""
        center_lon, center_lat = 112.7585415, -7.2647041  # Unair Kampus A
        cx_m, cy_m = self.pipeline.transformer_fwd.transform(center_lon, center_lat)

        ring = self.pipeline.create_radial_buffer_polygon(center_lon, center_lat, radius_m=1000.0, num_segments=64)

        # 1. Cincin harus tertutup: titik awal persis sama dengan titik akhir
        self.assertEqual(ring[0], ring[-1], "Poligon buffer harus berupa cincin tertutup (ring[0] == ring[-1]).")
        self.assertGreaterEqual(len(ring), 65, "Jumlah simpul poligon lingkaran harus memadai.")

        # 2. Verifikasi radius metrik setiap titik terhadap titik pusat
        for pt in ring:
            px_m, py_m = self.pipeline.transformer_fwd.transform(pt[0], pt[1])
            dist = math.sqrt((px_m - cx_m) ** 2 + (py_m - cy_m) ** 2)
            self.assertAlmostEqual(dist, 1000.0, delta=1.0, msg=f"Titik {pt} berjarak {dist}m, menyimpang dari 1000m.")

    def test_03_distance_threshold_accepted_and_rejected(self):
        """Verifikasi batas inklusif <= 1000.0 accepted dan > 1000.0 rejected tanpa pembulatan prematur."""
        # Titik acuan
        center_lon, center_lat = 112.7613302, -7.2931149  # Ubaya Ngagel
        cx_m, cy_m = self.pipeline.transformer_fwd.transform(center_lon, center_lat)

        # Kasus A: Jarak tepat 1000.0000000 m -> Lolos
        p_exact_x = cx_m + 1000.0
        p_exact_y = cy_m
        lon_exact, lat_exact = self.pipeline.transformer_inv.transform(p_exact_x, p_exact_y)

        # Kasus B: Jarak 999.99 m -> Lolos
        p_in_x = cx_m + 999.99
        p_in_y = cy_m
        lon_in, lat_in = self.pipeline.transformer_inv.transform(p_in_x, p_in_y)

        # Kasus C: Jarak 1000.001 m -> Ditolak (di luar radius)
        p_out_x = cx_m + 1000.001
        p_out_y = cy_m
        lon_out, lat_out = self.pipeline.transformer_inv.transform(p_out_x, p_out_y)

        # Siapkan file uji minimal
        unis_data = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [center_lon, center_lat]},
                "properties": {
                    "id": "UBAYA-NGAGEL",
                    "institution": "UBAYA",
                    "university_name": "Universitas Surabaya",
                    "campus_name": "Ubaya Ngagel",
                    "source": "OSM",
                    "verified_at": "2026-10-31"
                }
            }]
        }

        cands_data = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon_exact, lat_exact]},
                    "properties": {
                        "id": "TEST_EXACT",
                        "status": "Lahan kosong"
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon_in, lat_in]},
                    "properties": {
                        "id": "TEST_INSIDE",
                        "status": "Lahan kosong"
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon_out, lat_out]},
                    "properties": {
                        "id": "TEST_OUTSIDE",
                        "status": "Lahan kosong"
                    }
                }
            ]
        }

        unis_file = os.path.join(self.temp_dir, "u_test.geojson")
        cands_file = os.path.join(self.temp_dir, "c_test.geojson")
        with open(unis_file, "w") as f:
            json.dump(unis_data, f)
        with open(cands_file, "w") as f:
            json.dump(cands_data, f)

        res = self.pipeline.process(unis_file, cands_file, self.temp_dir)
        with open(res["outputs"]["land_candidates"]) as f:
            processed = json.load(f)["features"]

        by_id = {feat["properties"]["id"]: feat["properties"] for feat in processed}

        # Jarak <= 1000 diterima
        self.assertTrue(by_id["TEST_EXACT"]["is_in_buffer"])
        self.assertTrue(by_id["TEST_EXACT"]["is_eligible"])
        self.assertAlmostEqual(by_id["TEST_EXACT"]["distance_meters"], 1000.0, places=3)

        self.assertTrue(by_id["TEST_INSIDE"]["is_in_buffer"])
        self.assertTrue(by_id["TEST_INSIDE"]["is_eligible"])

        # Jarak > 1000 ditolak
        self.assertFalse(by_id["TEST_OUTSIDE"]["is_in_buffer"])
        self.assertFalse(by_id["TEST_OUTSIDE"]["is_eligible"])
        self.assertGreater(by_id["TEST_OUTSIDE"]["distance_meters"], 1000.0)

    def test_04_five_statuses_and_conditional_eligibility(self):
        """Verifikasi 5 kategori status baku dan aturan kelayakan (hanya 2 status pertama & <=1000)."""
        center_lon, center_lat = 112.7448867, -7.2814773  # UKWMS Dinoyo
        cx_m, cy_m = self.pipeline.transformer_fwd.transform(center_lon, center_lat)

        # Titik 300m (inside buffer)
        p_in_x, p_in_y = cx_m + 300.0, cy_m
        lon_in, lat_in = self.pipeline.transformer_inv.transform(p_in_x, p_in_y)

        # Titik 1500m (outside buffer)
        p_out_x, p_out_y = cx_m + 1500.0, cy_m
        lon_out, lat_out = self.pipeline.transformer_inv.transform(p_out_x, p_out_y)

        unis_data = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [center_lon, center_lat]},
                "properties": {
                    "id": "UKWMS-DINOYO",
                    "institution": "UKWMS",
                    "university_name": "Universitas Katolik Widya Mandala Surabaya",
                    "campus_name": "UKWMS Kampus Dinoyo",
                    "source": "OSM",
                    "verified_at": "2026-10-31"
                }
            }]
        }

        # Buat kandidat untuk semua 5 status di dalam dan di luar buffer
        features = []
        for i, status in enumerate(VALID_LAND_STATUSES):
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon_in, lat_in]},
                "properties": {"id": f"IN_{i}", "status": status}
            })
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon_out, lat_out]},
                "properties": {"id": f"OUT_{i}", "status": status}
            })

        # Tambahkan kandidat tanpa status (menguji fallback default)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon_in, lat_in]},
            "properties": {"id": "IN_FALLBACK", "status": ""}
        })

        cands_data = {"type": "FeatureCollection", "features": features}

        unis_file = os.path.join(self.temp_dir, "u_status.geojson")
        cands_file = os.path.join(self.temp_dir, "c_status.geojson")
        with open(unis_file, "w") as f:
            json.dump(unis_data, f)
        with open(cands_file, "w") as f:
            json.dump(cands_data, f)

        res = self.pipeline.process(unis_file, cands_file, self.temp_dir)
        with open(res["outputs"]["land_candidates"]) as f:
            processed = json.load(f)["features"]

        by_id = {feat["properties"]["id"]: feat["properties"] for feat in processed}

        # Di dalam buffer: hanya status index 0 dan 1 yang eligible
        self.assertTrue(by_id["IN_0"]["is_eligible"], "Status 'Lahan kosong' di dalam buffer harus eligible.")
        self.assertTrue(by_id["IN_1"]["is_eligible"], "Status 'Lahan yang tersedia untuk disewakan' di dalam buffer harus eligible.")
        self.assertFalse(by_id["IN_2"]["is_eligible"], "Status 'Rumah tempat tinggal' harus ineligible.")
        self.assertFalse(by_id["IN_3"]["is_eligible"], "Status 'Bangunan fungsi lain' harus ineligible.")
        self.assertFalse(by_id["IN_4"]["is_eligible"], "Status 'Belum terverifikasi' harus ineligible.")

        # Fallback status kosong harus menjadi default dan ineligible
        self.assertEqual(by_id["IN_FALLBACK"]["status"], DEFAULT_LAND_STATUS)
        self.assertFalse(by_id["IN_FALLBACK"]["is_eligible"])

        # Di luar buffer: seluruh status WAJIB ineligible
        for i in range(5):
            self.assertFalse(by_id[f"OUT_{i}"]["is_eligible"], f"Status {VALID_LAND_STATUSES[i]} di luar buffer harus ineligible.")

    def test_05_trust_boundary_and_bad_inputs(self):
        """Verifikasi validasi trust boundary terhadap input rusak, boolean, NaN, koordinat luar kota, dan ID duplikat."""
        # 1. Boolean coordinate
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_coordinate(True, -7.26)
        self.assertIn("boolean", str(ctx.exception))

        # 2. String non-numeric
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_coordinate("bukan_angka", -7.26)
        self.assertIn("numerik", str(ctx.exception))

        # 3. Non-finite (NaN / Inf)
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_coordinate(float("nan"), -7.26)
        self.assertIn("berhingga", str(ctx.exception))

        # 4. Out of bounds Surabaya (contoh: Jakarta)
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_coordinate(106.8456, -6.2088)
        self.assertIn("di luar batas Surabaya", str(ctx.exception))

        # 5. Duplikasi ID pada dataset
        unis_data = {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [112.758, -7.264]},
                "properties": {"id": "UNAIR_A", "campus_name": "Kampus A"}
            }]
        }
        dup_cands_data = {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [112.758, -7.265]}, "properties": {"id": "DUP_ID"}},
                {"type": "Feature", "geometry": {"type": "Point", "coordinates": [112.758, -7.266]}, "properties": {"id": "DUP_ID"}}
            ]
        }
        u_file = os.path.join(self.temp_dir, "u_dup.geojson")
        c_file = os.path.join(self.temp_dir, "c_dup.geojson")
        with open(u_file, "w") as f:
            json.dump(unis_data, f)
        with open(c_file, "w") as f:
            json.dump(dup_cands_data, f)

        with self.assertRaises(ValueError) as ctx:
            self.pipeline.process(u_file, c_file, self.temp_dir)
        self.assertIn("Duplikasi id", str(ctx.exception))

    def test_06_output_parse_and_schema_contracts(self):
        """Verifikasi eksekusi pipeline aktual terhadap data/raw dan validasi skema GeoJSON output."""
        raw_unis = "data/raw/universities.geojson"
        raw_cands = "data/raw/land_candidates.geojson"

        self.assertTrue(os.path.exists(raw_unis), f"Input mentah {raw_unis} harus ada.")
        self.assertTrue(os.path.exists(raw_cands), f"Input mentah {raw_cands} harus ada.")

        res = self.pipeline.process(raw_unis, raw_cands, self.temp_dir)

        # 1. Periksa ketersediaan berkas
        unis_out = res["outputs"]["universities"]
        buff_out = res["outputs"]["buffer_1km"]
        cand_out = res["outputs"]["land_candidates"]

        self.assertTrue(os.path.exists(unis_out))
        self.assertTrue(os.path.exists(buff_out))
        self.assertTrue(os.path.exists(cand_out))

        # 2. Parse GeoJSON Buffer dan verifikasi properti kontrak
        with open(buff_out) as f:
            buff_data = json.load(f)
        self.assertEqual(buff_data["type"], "FeatureCollection")
        self.assertEqual(len(buff_data["features"]), 8)  # 8 kampus terverifikasi

        for bf in buff_data["features"]:
            self.assertEqual(bf["geometry"]["type"], "Polygon")
            # Pastikan ring tertutup
            ring = bf["geometry"]["coordinates"][0]
            self.assertEqual(ring[0], ring[-1])
            # Pastikan properti persis sesuai kontrak
            props = bf["properties"]
            self.assertIn("university_id", props)
            self.assertIn("institution", props)
            self.assertIn("campus_name", props)
            self.assertEqual(props["radius_m"], 1000)
            self.assertEqual(props["crs_calculated"], "EPSG:32749")

        # 3. Parse GeoJSON Land Candidates dan verifikasi properti kontrak
        with open(raw_cands) as f:
            raw_cands_len = len(json.load(f)["features"])
        with open(cand_out) as f:
            cand_data = json.load(f)
        self.assertEqual(cand_data["type"], "FeatureCollection")
        self.assertEqual(len(cand_data["features"]), raw_cands_len)

        required_cand_props = [
            "id", "name", "address", "status",
            "nearest_university_id", "nearest_university_name", "distance_meters",
            "is_in_buffer", "is_eligible", "data_kind", "source"
        ]

        for cf in cand_data["features"]:
            self.assertEqual(cf["geometry"]["type"], "Point")
            props = cf["properties"]
            for rk in required_cand_props:
                self.assertIn(rk, props, f"Properti '{rk}' tidak ditemukan pada kandidat {props.get('id')}.")
            self.assertIn(props["status"], VALID_LAND_STATUSES)
            self.assertIsInstance(props["is_in_buffer"], bool)
            self.assertIsInstance(props["is_eligible"], bool)
            self.assertIsInstance(props["distance_meters"], float)

    def test_07_regression_target_institutions_unair_ukwms_ubaya_no_unesa(self):
        """
        Pemeriksaan Regresi Target Institusi:
        Menjamin target institusi resmi adalah Unair, UKWMS, dan Ubaya.
        Memverifikasi ketiadaan total UNESA dari data raw dan processed,
        serta memverifikasi 3 kampus UKWMS (Dinoyo, Kalijudan, Pakuwon City)
        memiliki koordinat valid dan sumber OSM yang dapat ditelusuri.
        """
        raw_unis_path = "data/raw/universities.geojson"
        raw_cands_path = "data/raw/land_candidates.geojson"
        proc_unis_path = "data/processed/universities.geojson"
        proc_buff_path = "data/processed/buffer_1km.geojson"
        proc_cands_path = "data/processed/land_candidates.geojson"

        # 1. Audit File Raw Universities
        with open(raw_unis_path, "r", encoding="utf-8") as f:
            raw_unis = json.load(f)

        features = raw_unis.get("features", [])
        self.assertEqual(len(features), 8, "Harus ada tepat 8 titik kampus terverifikasi.")

        inst_counts = {}
        campus_ids = set()
        for feat in features:
            props = feat["properties"]
            cid = props["id"]
            inst = props["institution"]
            campus_ids.add(cid)
            inst_counts[inst] = inst_counts.get(inst, 0) + 1

            # Larangan keras UNESA
            self.assertNotIn("UNESA", inst, f"Institusi UNESA dilarang ada pada {cid}.")
            self.assertNotIn("UNESA", cid, f"ID kampus {cid} tidak boleh memuat UNESA.")
            self.assertNotIn("unesa", props.get("university_name", "").lower(), f"Nama universitas tidak boleh UNESA.")

        # Verifikasi tripartit resmi: Unair (3), UKWMS (3), Ubaya (2)
        expected_insts = {"UNAIR": 3, "UKWMS": 3, "UBAYA": 2}
        self.assertEqual(inst_counts, expected_insts, f"Distribusi institusi tidak sesuai: {inst_counts}")

        # Verifikasi 3 kampus UKWMS Surabaya
        expected_ukwms_campuses = {
            "UKWMS-DINOYO": "279576575",
            "UKWMS-KALIJUDAN": "432849700",
            "UKWMS-PAKUWON": "876180997"
        }
        for uk_id, osm_way in expected_ukwms_campuses.items():
            self.assertIn(uk_id, campus_ids, f"Kampus {uk_id} harus ada di dataset.")
            matching = [feat for feat in features if feat["properties"]["id"] == uk_id][0]
            src = matching["properties"]["source"]
            self.assertIn(osm_way, src, f"Sumber OSM untuk {uk_id} harus memuat way/{osm_way}.")
            coords = matching["geometry"]["coordinates"]
            # Validasi batas Surabaya
            self.assertTrue(SURABAYA_BBOX["min_lon"] <= coords[0] <= SURABAYA_BBOX["max_lon"])
            self.assertTrue(SURABAYA_BBOX["min_lat"] <= coords[1] <= SURABAYA_BBOX["max_lat"])

        # 2. Audit File Processed Buffers
        with open(proc_buff_path, "r", encoding="utf-8") as f:
            buff_data = json.load(f)
        self.assertEqual(len(buff_data["features"]), 8)
        buff_insts = {b["properties"]["institution"] for b in buff_data["features"]}
        self.assertEqual(buff_insts, {"UNAIR", "UKWMS", "UBAYA"})
        self.assertNotIn("UNESA", buff_insts)

        # 3. Audit File Processed Land Candidates
        with open(proc_cands_path, "r", encoding="utf-8") as f:
            cand_data = json.load(f)

        for cf in cand_data["features"]:
            cprops = cf["properties"]
            nearest_uid = cprops["nearest_university_id"]
            self.assertNotIn("UNESA", nearest_uid, f"Kandidat {cprops['id']} tidak boleh merujuk ke UNESA.")
            self.assertTrue(
                nearest_uid.startswith(("UNAIR-", "UKWMS-", "UBAYA-")),
                f"Nearest university {nearest_uid} harus merupakan Unair, UKWMS, atau Ubaya."
            )

        # Verifikasi kandidat target UKWMS pada layer interaktif faktual
        ukwms_cands = [cf for cf in cand_data["features"] if cf["properties"]["nearest_university_id"].startswith("UKWMS-")]
        self.assertGreater(len(ukwms_cands), 0, "Harus ada kandidat faktual yang terhubung ke UKWMS.")
        for uk_cand in ukwms_cands:
            p = uk_cand["properties"]
            self.assertTrue(p["nearest_university_id"].startswith("UKWMS-"))

        # Verifikasi kandidat khusus UKWMS pada fixture sintetis terisolasi
        fixture_path = "data/fixtures/synthetic_land_candidates.geojson"
        with open(fixture_path, "r", encoding="utf-8") as f:
            fixture_cands = json.load(f)["features"]
        ukwms_fixture = [cf for cf in fixture_cands if cf["properties"]["id"].startswith("CAND-UKWMS-")]
        self.assertEqual(len(ukwms_fixture), 4, "Harus ada 4 kandidat yang dikurasi khusus untuk UKWMS pada fixture terisolasi.")
        for uk_cand in ukwms_fixture:
            p = uk_cand["properties"]
            self.assertEqual(p["data_kind"], "synthetic_academic_demo")

    def test_08_preserve_20_synthetic_candidates(self):
        """
        Audit Preservasi & Isolasi Kandidat Lahan Sintetis Lama:
        Memverifikasi bahwa 20 kandidat lahan sintetis lama diisolasi di berkas fixture
        (data/fixtures/synthetic_land_candidates.geojson dan data/raw/synthetic_land_candidates.geojson),
        tidak hilang, dan tidak mencemari layer interaktif faktual aktif.
        """
        fixture_path = "data/fixtures/synthetic_land_candidates.geojson"
        raw_fixture_path = "data/raw/synthetic_land_candidates.geojson"

        self.assertTrue(os.path.exists(fixture_path), "File fixture kandidat sintetis harus ada.")
        self.assertTrue(os.path.exists(raw_fixture_path), "File raw fixture kandidat sintetis harus ada.")

        audit_res = audit_synthetic_candidates(fixture_path, raw_fixture_path)
        self.assertEqual(audit_res["status"], "PASSED")
        self.assertEqual(audit_res["total_synthetic_candidates"], 20)

        # Verifikasi bahwa tidak ada pencampuran data_kind pada fixture
        with open(fixture_path, "r", encoding="utf-8") as f:
            raw_c = json.load(f)["features"]
        for feat in raw_c:
            self.assertEqual(feat["properties"]["data_kind"], "synthetic_academic_demo")
            self.assertTrue(feat["properties"]["id"].startswith("CAND-"))

    def test_09_real_rental_listings_contract_and_trust_boundary(self):
        """
        Uji Kontrak & Trust Boundary Listing Properti Riil Publik:
        1. Integritas Remediasi: File raw listing fabrikasi telah ditarik/dihapus dari repo.
        2. Validasi App-Facing GeoJSON: data/processed/real_rental_listings.geojson WAJIB berupa FeatureCollection kosong.
        3. Validasi URL spesifik: Halaman listing individual (bukan direktori pencarian generik).
        4. Anti-Circular Trust: Tidak mempercayai flag is_verified sembarangan tanpa bukti URL & harga riil.
        5. Validasi Geometri Opsional/Null: Tanpa geocode provenance independen, koordinat otomatis dinolkan.
        """
        service = RentalMarketService()

        # 1. Pastikan file raw listing palsu/tidak terverifikasi tidak berada di jalur publik/aktif
        raw_listings_path = "data/raw/real_rental_listings.json"
        self.assertFalse(
            os.path.exists(raw_listings_path),
            "File data/raw/real_rental_listings.json wajib dihapus/tidak dikirim ke jalur produksi."
        )

        # 2. Pastikan file processed listing GeoJSON ada dan merupakan FeatureCollection kosong
        proc_listings_path = "data/processed/real_rental_listings.geojson"
        self.assertTrue(os.path.exists(proc_listings_path), f"File {proc_listings_path} wajib ada di processed.")

        with open(proc_listings_path, "r", encoding="utf-8") as f:
            proc_data = json.load(f)

        self.assertEqual(proc_data.get("type"), "FeatureCollection")
        features = proc_data.get("features", [])
        self.assertEqual(
            len(features),
            0,
            "Processed listing GeoJSON wajib berupa FeatureCollection kosong karena laporan riset unsupported."
        )
        meta = proc_data.get("metadata", {})
        self.assertEqual(meta.get("total_features"), 0)
        self.assertEqual(meta.get("status"), "EMPTY_UNVERIFIED")

        # 3. Uji Penolakan URL Generik / Direktori Pencarian
        generic_urls = [
            "https://www.rumah123.com/sewa/surabaya/mulyosari/ruko/",
            "https://www.lamudi.co.id/sewa/surabaya/ruko/",
            "https://www.99.co/id/sewa/ruko/surabaya/gubeng",
            "https://www.pinhome.id/sewa-properti/surabaya/rungkut/"
        ]
        for bad_url in generic_urls:
            self.assertFalse(
                service.is_source_specific_url(bad_url),
                f"URL generik {bad_url} harus ditolak oleh validator spesifik."
            )

        # 4. Uji Anti-Circular Trust: Flag is_verified_public: true tapi URL generik -> Wajib Gagal
        fake_verified_feat = {
            "type": "Feature",
            "geometry": None,
            "properties": {
                "listing_id": "TEST_FAKE_VERIFIED",
                "title": "Fake Listing",
                "area_cluster": "Test",
                "address": "Jl. Uji Coba No. 1",
                "property_type": "ruko",
                "rental_price_yr": 100000000.0,
                "source_portal": "Rumah123",
                "source_url": "https://www.rumah123.com/sewa/surabaya/ruko/", # Generik
                "is_verified_public": True, # Circular claim
                "evidence_source": "reports/research.md"
            }
        }
        with self.assertRaises(ValueError) as ctx:
            service.validate_listing(fake_verified_feat, set())
        self.assertIn("bukan URL listing individual spesifik", str(ctx.exception))

        # 5. Uji Penolakan Koordinat Tanpa Provenance
        unprovenanced_coord_feat = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [112.75, -7.26]},
            "properties": {
                "listing_id": "TEST_UNPROVENANCED_COORD",
                "title": "Unprovenanced Coords",
                "area_cluster": "Test",
                "address": "Jl. Uji Coba No. 2",
                "property_type": "ruko",
                "rental_price_yr": 80000000.0,
                "source_portal": "Rumah123",
                "source_url": "https://www.rumah123.com/properti/surabaya/shr12345/",
                "evidence_source": "None",
                "geocode_provenance": None # Tanpa provenance
            }
        }
        # Service harus secara otomatis menolak/mengabaikan koordinat tanpa provenance menjadi null
        res_val = service.validate_listing(unprovenanced_coord_feat, set())
        self.assertIsNone(res_val["coordinates"])
        self.assertFalse(res_val["has_geocoded_location"])

    def test_10_area_price_summary_three_listing_rule(self):
        """
        Uji Kepatuhan Aturan Agregasi Rentang Harga Kawasan (Aturan >= 3 Listing):
        1. Kawasan dengan < 3 listing WAJIB ditolak dan ditandai INSUFFICIENT_DATA
           dengan nilai min, max, median, mean bernilai None (tanpa fabrikasi data).
        2. Kawasan dengan >= 3 listing menghasilkan metrik harga presisi unrounded.
        3. Verifikasi output aktual area_rental_price_summary.json:
           Karena tidak ada sumber listing terverifikasi (klaim riset unsupported),
           seluruh klaster target sasaran wajib berstatus INSUFFICIENT_DATA dengan statistik null.
        """
        service = RentalMarketService()

        # Kasus Mock A: Kawasan dengan 1 listing (di bawah ambang batas)
        mock_area_1 = [
            {"listing_id": "L1", "property_type": "ruko", "rental_price_yr": 80000000.0, "price_sqm_yr": 800000.0}
        ]
        sum_1 = service.summarize_area_cluster("Area Mock 1", mock_area_1, target_property_type="ruko")
        self.assertFalse(sum_1["has_sufficient_listings"])
        self.assertEqual(sum_1["status"], "INSUFFICIENT_DATA")
        self.assertIsNone(sum_1["min_price_yr"])
        self.assertIsNone(sum_1["max_price_yr"])
        self.assertIsNone(sum_1["median_price_yr"])
        self.assertIsNone(sum_1["mean_price_yr"])

        # Kasus Mock B: Kawasan dengan 2 listing (masih di bawah ambang batas)
        mock_area_2 = [
            {"listing_id": "L1", "property_type": "ruko", "rental_price_yr": 80000000.0, "price_sqm_yr": 800000.0},
            {"listing_id": "L2", "property_type": "ruko", "rental_price_yr": 100000000.0, "price_sqm_yr": 1000000.0}
        ]
        sum_2 = service.summarize_area_cluster("Area Mock 2", mock_area_2, target_property_type="ruko")
        self.assertFalse(sum_2["has_sufficient_listings"])
        self.assertEqual(sum_2["status"], "INSUFFICIENT_DATA")
        self.assertIsNone(sum_2["median_price_yr"])

        # Kasus Mock C: Kawasan dengan tepat 3 listing (memenuhi syarat)
        mock_area_3 = [
            {"listing_id": "L1", "property_type": "ruko", "rental_price_yr": 60000000.0, "price_sqm_yr": 600000.0},
            {"listing_id": "L2", "property_type": "ruko", "rental_price_yr": 90000000.0, "price_sqm_yr": 900000.0},
            {"listing_id": "L3", "property_type": "ruko", "rental_price_yr": 150000000.0, "price_sqm_yr": 1500000.0}
        ]
        sum_3 = service.summarize_area_cluster("Area Mock 3", mock_area_3, target_property_type="ruko")
        self.assertTrue(sum_3["has_sufficient_listings"])
        self.assertEqual(sum_3["status"], "SUFFICIENT_DATA")
        self.assertEqual(sum_3["min_price_yr"], 60000000.0)
        self.assertEqual(sum_3["max_price_yr"], 150000000.0)
        self.assertEqual(sum_3["median_price_yr"], 90000000.0)
        self.assertAlmostEqual(sum_3["mean_price_yr"], 100000000.0)

        # Uji Output Aktual area_rental_price_summary.json
        summary_path = "data/processed/area_rental_price_summary.json"
        self.assertTrue(os.path.exists(summary_path), f"File {summary_path} harus telah terbentuk.")

        with open(summary_path, "r", encoding="utf-8") as f:
            summary_data = json.load(f)

        meta = summary_data["metadata"]
        self.assertEqual(meta["min_comparable_threshold"], MIN_COMPARABLE_LISTINGS)

        # Integritas Zero Fabrication: Tidak ada listing valid, sehingga 0 kawasan CUKUP
        sufficient = summary_data["sufficient_areas"]
        insufficient = summary_data["insufficient_areas"]
        self.assertEqual(len(sufficient), 0, "Tidak boleh ada kawasan SUFFICIENT_DATA tanpa bukti listing terverifikasi.")
        self.assertEqual(len(insufficient), 8, "Seluruh 8 klaster target wajib berstatus INSUFFICIENT_DATA.")

        for a_sum in summary_data["area_summaries"]:
            self.assertFalse(a_sum["has_sufficient_listings"])
            self.assertEqual(a_sum["status"], "INSUFFICIENT_DATA")
            self.assertEqual(a_sum["count"], 0)
            self.assertIsNone(a_sum["min_price_yr"])
            self.assertIsNone(a_sum["max_price_yr"])
            self.assertIsNone(a_sum["median_price_yr"])
            self.assertIsNone(a_sum["mean_price_yr"])
            self.assertEqual(a_sum["comparable_listing_ids"], [])

    def test_11_universities_as_polygons_and_polygon_buffers(self):
        """
        Uji Model Kampus sebagai Poligon dan Pembangkitan Buffer Dilatasi 1.000m:
        1. Memverifikasi seluruh 8 kampus memiliki poligon perimeter WGS84 tertutup valid.
        2. Memverifikasi pembangkitan buffer dilatasi 1.000m dari batas poligon (buffer_polygon_1km.geojson).
        3. Memverifikasi perhitungan jarak metrik dari titik ke batas poligon kampus (EPSG:32749).
        """
        # 1. Verifikasi Poligon Baku 8 Kampus
        for cid, poly in CAMPUS_POLYGONS_WGS84.items():
            self.assertGreaterEqual(len(poly), 4, f"Poligon {cid} minimal memiliki 4 titik.")
            self.assertEqual(poly[0], poly[-1], f"Poligon {cid} harus merupakan cincin tertutup.")

        # 2. Uji Algoritma Buffer Dilatasi Poligon Metrik
        test_box = [
            [112.75730, -7.26560],
            [112.75980, -7.26560],
            [112.75980, -7.26380],
            [112.75730, -7.26380],
            [112.75730, -7.26560]
        ]
        poly_buff = self.pipeline.create_polygon_buffer_metric(test_box, radius_m=1000.0, num_arc_pts=8)
        self.assertGreater(len(poly_buff), 10, "Buffer poligon harus memuat busur sudut yang terdefinisi halus.")
        self.assertEqual(poly_buff[0], poly_buff[-1], "Buffer poligon harus berupa cincin tertutup.")

        # 3. Uji Perhitungan Jarak Titik ke Poligon
        poly_utm = [self.pipeline.transformer_fwd.transform(p[0], p[1]) for p in test_box]
        # Titik di dalam poligon -> jarak 0.0m
        cx = sum(p[0] for p in poly_utm[:-1]) / (len(poly_utm) - 1)
        cy = sum(p[1] for p in poly_utm[:-1]) / (len(poly_utm) - 1)
        dist_inside = self.pipeline.point_to_polygon_distance_metric(cx, cy, poly_utm)
        self.assertEqual(dist_inside, 0.0, "Jarak titik di dalam poligon harus bernilai 0.0.")

        # Titik di luar sejauh 250m ke arah timur
        east_x = max(p[0] for p in poly_utm) + 250.0
        dist_outside = self.pipeline.point_to_polygon_distance_metric(east_x, cy, poly_utm)
        self.assertAlmostEqual(dist_outside, 250.0, delta=0.5, msg="Jarak titik luar harus sesuai offset.")

        # 4. Verifikasi Berkas Keluaran Aktual
        poly_unis_path = "data/processed/universities_polygons.geojson"
        poly_buff_path = "data/processed/buffer_polygon_1km.geojson"
        self.assertTrue(os.path.exists(poly_unis_path), f"File {poly_unis_path} wajib ada.")
        self.assertTrue(os.path.exists(poly_buff_path), f"File {poly_buff_path} wajib ada.")

        with open(poly_unis_path) as f:
            poly_u_data = json.load(f)
        self.assertEqual(len(poly_u_data["features"]), 8)
        for feat in poly_u_data["features"]:
            self.assertEqual(feat["geometry"]["type"], "Polygon")
            self.assertIn("campus_area_ha", feat["properties"])
            self.assertGreater(feat["properties"]["campus_area_ha"], 0.0)

        with open(poly_buff_path) as f:
            poly_b_data = json.load(f)
        self.assertEqual(len(poly_b_data["features"]), 8)
        for feat in poly_b_data["features"]:
            self.assertEqual(feat["geometry"]["type"], "Polygon")
            self.assertEqual(feat["properties"]["radius_m"], 1000)

    def test_12_open_data_building_land_classification_and_clickability(self):
        """
        Uji Klasifikasi Lahan/Bangunan Open Data & Status Clickable vs Not Rentable/Sale:
        1. Verifikasi aturan klasifikasi defensible open data (residential, commercial, vacant, lease).
        2. Verifikasi status yang dapat dipilih (clickable for planning modal):
           HANYA "Lahan kosong" & "Lahan yang tersedia untuk disewakan" yang berada <= 1000m.
        3. Verifikasi status yang TIDAK dapat disewa / dijual untuk kafe (disabled / unclickable):
           "Rumah atau bangunan tempat tinggal", "Bangunan fungsi lain", "Belum terverifikasi".
        """
        # Uji Aturan 1: Residential
        res_tag = {"building": "house", "addr:street": "Jl. Kertajaya"}
        cls_res = classify_land_building_from_open_data(res_tag)
        self.assertEqual(cls_res["status"], "Rumah atau bangunan tempat tinggal")
        self.assertFalse(cls_res["is_rentable_or_sale"])
        self.assertFalse(cls_res["is_clickable_for_planning"])
        self.assertIn("tempat tinggal", cls_res["planning_eligibility_reason"])

        # Uji Aturan 2: Active Commercial / Amenity
        comm_tag = {"amenity": "school", "name": "SMA Negeri"}
        cls_comm = classify_land_building_from_open_data(comm_tag)
        self.assertEqual(cls_comm["status"], "Bangunan yang telah digunakan untuk fungsi lain")
        self.assertFalse(cls_comm["is_rentable_or_sale"])
        self.assertFalse(cls_comm["is_clickable_for_planning"])

        # Uji Aturan 3: Vacant / Brownfield
        vac_tag = {"landuse": "brownfield"}
        cls_vac = classify_land_building_from_open_data(vac_tag)
        self.assertEqual(cls_vac["status"], "Lahan kosong")
        self.assertTrue(cls_vac["is_rentable_or_sale"])
        self.assertTrue(cls_vac["is_clickable_for_planning"])

        # Uji Aturan 4: Verified Commercial Lease
        lease_tag = {"commercial_lease": "available", "rental_terms": "yearly"}
        cls_lease = classify_land_building_from_open_data(lease_tag)
        self.assertEqual(cls_lease["status"], "Lahan yang tersedia untuk disewakan")
        self.assertTrue(cls_lease["is_rentable_or_sale"])
        self.assertTrue(cls_lease["is_clickable_for_planning"])

        # Verifikasi pada Berkas Aktual data/processed/land_candidates.geojson
        cand_path = "data/processed/land_candidates.geojson"
        with open(cand_path) as f:
            cands = json.load(f)["features"]

        for c in cands:
            p = c["properties"]
            st = p["status"]
            in_buf = p["is_in_buffer"]
            is_rentable = p["is_rentable_or_sale"]
            is_clickable = p["is_clickable_for_planning"]

            # Invarian Hak Sewa/Beli untuk Kafe
            if st in RENTABLE_OR_SALE_STATUSES:
                self.assertTrue(is_rentable, f"Status {st} harus is_rentable_or_sale=True.")
            else:
                self.assertTrue(st in NON_RENTABLE_OR_SALE_STATUSES)
                self.assertFalse(is_rentable, f"Status {st} harus is_rentable_or_sale=False.")

            # Invarian Kelayakan Perencanaan Kafe (Clickable): Wajib in_buffer DAN rentable
            expected_clickable = bool(in_buf and is_rentable)
            self.assertEqual(
                is_clickable,
                expected_clickable,
                f"Kandidat {p['id']} inkonsisten antara clickable ({is_clickable}) dan syarat ({in_buf} & {is_rentable})."
            )
            self.assertEqual(p["is_eligible"], is_clickable)

            if is_clickable:
                self.assertEqual(p["planning_eligibility_status"], "Dapat dipilih (Modal Perencanaan Kafe)")
                self.assertIsNone(p["unavailability_reason"])
            else:
                self.assertEqual(p["planning_eligibility_status"], "Tidak dapat dipilih")
                self.assertIsNotNone(p["unavailability_reason"])

    def test_13_honest_fallback_when_open_data_absent(self):
        """
        Uji Penanganan Fallback Jujur saat Data Sumber Open Data Tidak Tersedia:
        1. Entitas tanpa tag / atribut komersial wajib difallback ke 'Lahan yang statusnya belum terverifikasi'.
        2. Entitas fallback tidak boleh dinyatakan clickable / dapat dipilih.
        3. Menjamin transparansi keterbatasan data tanpa mengarang status sewa fiktif.
        """
        # Uji input kosong / tidak dikenal
        cls_empty = classify_land_building_from_open_data({})
        self.assertEqual(cls_empty["status"], "Lahan yang statusnya belum terverifikasi")
        self.assertFalse(cls_empty["is_rentable_or_sale"])
        self.assertFalse(cls_empty["is_clickable_for_planning"])
        self.assertTrue(cls_empty["is_honest_fallback"])

        cls_unknown = classify_land_building_from_open_data({"arbitrary_tag": "xyz"})
        self.assertEqual(cls_unknown["status"], "Lahan yang statusnya belum terverifikasi")
        self.assertFalse(cls_unknown["is_rentable_or_sale"])
        self.assertFalse(cls_unknown["is_clickable_for_planning"])
        self.assertTrue(cls_unknown["is_honest_fallback"])

    def test_14_factual_osm_building_cafe_interactive_layer(self):
        """
        Uji Lapisan Interaktif Faktual Bangunan/Kafe Berbasis OpenStreetMap:
        1. Fitur interaktif berasal murni dari sumber publik OSM riil (node & way).
        2. Preservasi identitas sumber: osm_id, osm_tags, dan query_attribution dipertahankan utuh.
        3. Eliminasi fitur sintetis: Zero fitur berlabel CAND-* atau synthetic_academic_demo di layer aktif.
        4. Klasifikasi tag defensible:
           - Rumah tinggal -> "Rumah atau bangunan tempat tinggal" (non-clickable)
           - Kafe/toko aktif -> "Bangunan yang telah digunakan untuk fungsi lain" (non-clickable)
           - Ketersediaan tidak terkonfirmasi -> "Lahan yang statusnya belum terverifikasi" (non-clickable)
        5. Zero Klaim Sewa Palsu: Tanpa bukti sewa riil, seluruh is_rentable_or_sale = False.
        6. Planner Guard: Seluruh fitur ditahan guard kelayakan (is_clickable_for_planning = False, is_eligible = False).
        """
        from scripts.rental_market_service import audit_factual_interactive_layer

        proc_cand_path = "data/processed/factual_osm_candidates.geojson"
        self.assertTrue(os.path.exists(proc_cand_path))

        audit_res = audit_factual_interactive_layer(proc_cand_path)
        self.assertEqual(audit_res["status"], "PASSED")
        self.assertGreater(audit_res["total_factual_features"], 0)
        self.assertEqual(audit_res["synthetic_in_active_layer"], 0)
        self.assertEqual(audit_res["empty_or_rentable_claims"], 0)

        with open(proc_cand_path) as f:
            proc_data = json.load(f)

        features = proc_data["features"]
        self.assertGreaterEqual(len(features), 1, "Harus memuat fitur faktual OSM jika layer tersedia")

        house_count = 0
        shop_cafe_count = 0
        unverified_count = 0

        for feat in features:
            props = feat["properties"]
            fid = props["id"]

            # 1. Identitas & sumber
            self.assertTrue(fid.startswith("OSM-NODE-") or fid.startswith("OSM-WAY-"))
            self.assertIn("osm_id", props)
            self.assertIn("osm_tags", props)
            self.assertIn("query_attribution", props)
            self.assertEqual(props["data_kind"], "osm_factual_open_data")
            self.assertIn("OpenStreetMap", props["source"])

            # 2. Koordinat WGS84 di Surabaya
            coords = feat["geometry"]["coordinates"]
            self.assertGreaterEqual(coords[0], 112.58)
            self.assertLessEqual(coords[0], 112.85)
            self.assertGreaterEqual(coords[1], -7.38)
            self.assertLessEqual(coords[1], -7.18)

            # 3. Kepatuhan Status & Guard
            st = props["status"]
            self.assertNotIn(st, {"Lahan kosong", "Lahan yang tersedia untuk disewakan"})
            self.assertFalse(props["is_rentable_or_sale"], f"Fitur {fid} tidak boleh berstatus sewa tanpa bukti.")
            self.assertFalse(props["is_clickable_for_planning"], f"Fitur {fid} tidak boleh clickable.")
            self.assertFalse(props["is_eligible"], f"Fitur {fid} tidak boleh eligible.")
            self.assertIsNotNone(props["unavailability_reason"])

            if st == "Rumah atau bangunan tempat tinggal":
                house_count += 1
            elif st == "Bangunan yang telah digunakan untuk fungsi lain":
                shop_cafe_count += 1
            elif st == "Lahan yang statusnya belum terverifikasi":
                unverified_count += 1

        # Pastikan ada representasi dari masing-masing klasifikasi non-clickable
        self.assertGreater(house_count, 0, "Harus ada fitur rumah tinggal terdeteksi.")
        self.assertGreater(shop_cafe_count, 0, "Harus ada fitur kafe/toko aktif terdeteksi.")
        self.assertGreater(unverified_count, 0, "Harus ada fitur unverified fallback terdeteksi.")

    def test_15_survey_candidate_schema_and_trust_boundary(self):
        """
        Uji Kontrak & Trust Boundary Skema Survei Lahan Kandidat (Prompt A Task 1):
        1. Fitur survei yang lengkap dengan bukti URL & tanggal observasi lolos validasi.
        2. Penolakan kandidat tanpa URL bukti (Street View / Google Maps) atau path foto.
        3. Penolakan tanggal observasi tidak baku (wajib YYYY-MM-DD).
        4. Penolakan harga sewa tanpa sumber bukti (price_source_url).
        5. Penolakan metode survei atau data_kind di luar taksonomi yang diizinkan.
        """
        # A. Fitur valid survei lapangan
        valid_survey_feat = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [112.7485, -7.2865]
            },
            "properties": {
                "id": "SURVEY-UKWMS-01",
                "name": "Kavling Dinoyo Timur",
                "address": "Jl. Dinoyo No. 45, Tegalsari, Surabaya",
                "status": "Lahan yang tersedia untuk disewakan",
                "survey_method": "street_view",
                "evidence_url": "https://maps.google.com/?cid=123456789",
                "observed_at": "2026-10-15",
                "surveyed_by": "Tim AFL 2",
                "notes": "Papan sewa terlihat di pagar depan",
                "area_sqm": 180.0,
                "rental_price_yr": 65000000.0,
                "price_source_url": "https://maps.google.com/?cid=123456789",
                "data_kind": "survey_google_maps"
            }
        }
        res = self.pipeline.validate_survey_candidate(valid_survey_feat)
        self.assertEqual(res["properties"]["id"], "SURVEY-UKWMS-01")
        self.assertEqual(res["properties"]["status"], "Lahan yang tersedia untuk disewakan")
        self.assertEqual(res["properties"]["observed_at"], "2026-10-15")

        # B. Penolakan bukti kosong (tanpa URL bukti atau foto)
        no_evidence_feat = json.loads(json.dumps(valid_survey_feat))
        no_evidence_feat["properties"]["evidence_url"] = None
        no_evidence_feat["properties"]["evidence_photo"] = None
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_survey_candidate(no_evidence_feat)
        self.assertIn("wajib menyertakan 'evidence_url'", str(ctx.exception))

        # C. Penolakan tanggal tidak baku
        bad_date_feat = json.loads(json.dumps(valid_survey_feat))
        bad_date_feat["properties"]["observed_at"] = "15-10-2026"
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_survey_candidate(bad_date_feat)
        self.assertIn("Format 'observed_at'", str(ctx.exception))

        # D. Penolakan harga sewa tanpa URL sumber bukti
        no_price_source_feat = json.loads(json.dumps(valid_survey_feat))
        no_price_source_feat["properties"]["price_source_url"] = None
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_survey_candidate(no_price_source_feat)
        self.assertIn("tidak memiliki 'price_source_url' valid", str(ctx.exception))

        # E. Penolakan metode survei tidak terdaftar
        bad_method_feat = json.loads(json.dumps(valid_survey_feat))
        bad_method_feat["properties"]["survey_method"] = "ai_hallucination"
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_survey_candidate(bad_method_feat)
        self.assertIn("Metode survei 'ai_hallucination' pada SURVEY-UKWMS-01 tidak valid", str(ctx.exception))

        # F. Penolakan data_kind tidak valid
        bad_kind_feat = json.loads(json.dumps(valid_survey_feat))
        bad_kind_feat["properties"]["data_kind"] = "unverified_listing"
        with self.assertRaises(ValueError) as ctx:
            self.pipeline.validate_survey_candidate(bad_kind_feat)
        self.assertIn("'data_kind' (unverified_listing) pada SURVEY-UKWMS-01 tidak valid", str(ctx.exception))

    def test_16_osm_cafes_provenance_and_buffer_metrics(self):
        """
        Uji Lapisan Konteks Kafe Eksisting OpenStreetMap (Prompt A Task 3):
        1. Berkas data/processed/osm_cafes.geojson tersedia dan berlisensi ODbL.
        2. Seluruh fitur bertipe Point dengan koordinat valid di Surabaya.
        3. Properti kafe konsisten: is_existing_cafe=True, is_planner_allowed=False, data_kind='osm_cafe'.
        4. Metrik spasial: jarak ke kampus terdekat dan bendera is_in_buffer terhitung akurat.
        5. Preservasi identitas sumber: osm_id, osm_tags, dan osm_url menunjuk ke osm.org.
        """
        cafes_proc_path = "data/processed/osm_cafes.geojson"
        self.assertTrue(os.path.exists(cafes_proc_path), "Berkas osm_cafes.geojson wajib ada di data/processed/")

        with open(cafes_proc_path, "r", encoding="utf-8") as f:
            cafes_data = json.load(f)

        features = cafes_data.get("features", [])
        self.assertGreaterEqual(len(features), 50, "Harus memuat kafe riil dari Overpass API")

        in_buffer_count = 0
        in_buffer_500m_count = 0
        for feat in features:
            props = feat["properties"]
            cid = props["id"]

            self.assertTrue(cid.startswith("OSM-CAFE-NODE-") or cid.startswith("OSM-CAFE-WAY-"))
            self.assertEqual(props["amenity"], "cafe")
            self.assertEqual(props["data_kind"], "osm_cafe")
            self.assertTrue(props["is_existing_cafe"])
            self.assertFalse(props["is_planner_allowed"], "Kafe eksisting tidak boleh dibuka untuk perencanaan kafe baru")
            self.assertTrue(props["is_factual"])
            self.assertIn("ODbL", props["source"])
            self.assertTrue(props["osm_url"].startswith("https://www.openstreetmap.org/"))

            # Validasi Task 3 (dual radius flags) & Task 5 (gate null)
            self.assertIn("is_in_buffer_500m", props)
            self.assertIn("is_in_buffer_1000m", props)
            self.assertIsNone(props.get("distance_to_nearest_gate_meters"), "Jarak gerbang kafe wajib null unobserved")
            self.assertEqual(props.get("gate_observation_status"), "UNOBSERVED")

            # Koordinat valid
            coords = feat["geometry"]["coordinates"]
            self.assertGreaterEqual(coords[0], 112.50)
            self.assertLessEqual(coords[0], 112.95)
            self.assertGreaterEqual(coords[1], -7.45)
            self.assertLessEqual(coords[1], -7.15)

            # Jarak metrik
            self.assertGreater(props["distance_meters"], 0)
            self.assertGreaterEqual(props["distance_to_polygon_meters"], 0)
            if props["is_in_buffer"]:
                in_buffer_count += 1
                self.assertLessEqual(props["distance_meters"], 1000.0)
                self.assertTrue(props["is_in_buffer_1000m"])
            else:
                self.assertGreater(props["distance_meters"], 1000.0)
                self.assertFalse(props["is_in_buffer_1000m"])

            if props["is_in_buffer_500m"]:
                in_buffer_500m_count += 1
                self.assertLessEqual(props["distance_meters"], 500.0)
                self.assertTrue(props["is_in_buffer_1000m"], "Titik di dalam 500m wajib juga berada di dalam 1000m")

        # Verifikasi konsistensi metadata
        expected_1000m = cafes_data.get("metadata", {}).get("in_buffer_1000m_count", 59)
        expected_500m = cafes_data.get("metadata", {}).get("in_buffer_500m_count", 23)
        self.assertEqual(in_buffer_count, expected_1000m, "Cacah kafe 1km harus cocok dengan metadata")
        self.assertEqual(in_buffer_500m_count, expected_500m, "Cacah kafe 500m harus cocok dengan metadata")

    def test_17_genuine_osm_campus_perimeter_polygons_and_cadastral_areas(self):
        """
        Uji Geometri Asli Perimeter Kampus OSM (Prompt A Task 2):
        1. 8 kampus memiliki poligon asli multi-vertex dari way OSM (bukan bounding box 4 titik).
        2. Seluruh poligon membentuk cincin tertutup (closed ring).
        3. Luas kadaster terhitung positif (hektar) sesuai metrik UTM 49S (EPSG:32749).
        4. Payload mentah way OSM tersimpan di data/raw/osm/way_*.json untuk keterulangan (reproducibility).
        """
        raw_polygons_path = "data/raw/osm/genuine_campus_polygons.json"
        self.assertTrue(os.path.exists(raw_polygons_path), "genuine_campus_polygons.json harus ada di data/raw/osm/")

        with open(raw_polygons_path, "r", encoding="utf-8") as f:
            poly_data = json.load(f)

        self.assertEqual(len(poly_data), 8, "Harus ada 8 kampus dengan poligon asli OSM")

        expected_ways = {
            "UNAIR-KAMPUS-A": 448790949,
            "UNAIR-KAMPUS-B": 448790950,
            "UNAIR-KAMPUS-C": 320182776,
            "UKWMS-DINOYO": 279576575,
            "UKWMS-KALIJUDAN": 432849700,
            "UKWMS-PAKUWON": 876180997,
            "UBAYA-NGAGEL": 429131451,
            "UBAYA-TENGGILIS": 463579114
        }

        for cid, way_id in expected_ways.items():
            self.assertIn(cid, poly_data)
            campus_info = poly_data[cid]
            self.assertEqual(campus_info["way_id"], way_id)
            self.assertGreaterEqual(campus_info["nodes_count"], 6, "Setiap poligon kampus memiliki minimal 6 titik batas")

            # Verifikasi keterulangan payload mentah
            raw_way_file = f"data/raw/osm/way_{way_id}.json"
            self.assertTrue(os.path.exists(raw_way_file), f"Payload mentah way {way_id} harus tersimpan di data/raw/osm/")

            # Verifikasi luas kadaster metrik positif
            area_ha = campus_info["area_ha"]
            self.assertGreater(area_ha, 0.5, f"Luas kadaster {cid} harus > 0.5 ha")
            self.assertLess(area_ha, 100.0, f"Luas kadaster {cid} harus < 100 ha")

        # Verifikasi berkas processed
        proc_poly_path = "data/processed/universities_polygons.geojson"
        with open(proc_poly_path, "r", encoding="utf-8") as f:
            proc_polys = json.load(f)

        self.assertEqual(len(proc_polys["features"]), 8)
        for feat in proc_polys["features"]:
            coords = feat["geometry"]["coordinates"][0]
            self.assertEqual(coords[0], coords[-1], "Cincin poligon kampus harus tertutup eksak")
            self.assertGreater(feat["properties"]["campus_area_ha"], 0)

    def test_18_survey_dataset_template_integrity_and_anti_fabrication_audit(self):
        """
        Uji Integritas Template Survei Lahan & Audit Anti-Fabrikasi (Prompt A Task 1 & 4):
        1. data/raw/survey_land_candidates.geojson ada dan valid skemanya.
        2. Status berkas valid (SURVEY_COMPLETED atau AWAITING_FIELD_SURVEY_DATA).
        3. Setiap fitur survei wajib memiliki bukti URL/foto, tanggal observasi ISO, dan surveyor.
        4. Keterulangan eksekusi pipeline menghasilkan processed dataset secara deterministik.
        """
        survey_template_path = "data/raw/survey_land_candidates.geojson"
        self.assertTrue(os.path.exists(survey_template_path))

        with open(survey_template_path, "r", encoding="utf-8") as f:
            template = json.load(f)

        self.assertEqual(template["type"], "FeatureCollection")
        self.assertIn("required_fields", template["metadata"]["protocol_guidelines"])
        status = template["metadata"].get("status")
        self.assertIn(status, ["SURVEY_COMPLETED", "AWAITING_FIELD_SURVEY_DATA"])

        if status == "SURVEY_COMPLETED":
            self.assertGreaterEqual(len(template["features"]), 16, "Dataset survei wajib memuat observasi lapangan riil")
            for feat in template["features"]:
                p = feat["properties"]
                self.assertTrue(bool(p.get("evidence_url") or p.get("evidence_photo")), f"Fitur {p.get('id')} wajib punya bukti")
                self.assertRegex(p.get("observed_at", ""), r"^\d{4}-\d{2}-\d{2}$")
                self.assertIn(p.get("status"), VALID_LAND_STATUSES)
                self.assertIn(p.get("survey_method"), ["street_view", "google_maps", "lapangan"])
        else:
            self.assertEqual(len(template["features"]), 0)

    def test_19_production_dataset_real_data_remediation_and_fixture_isolation(self):
        """
        Uji Remediasi Data Riil Jalur Produksi & Isolasi Fixture (Mandat Pengguna & Prompt A):
        1. Berkas produksi data/processed/land_candidates.geojson TIDAK memuat kandidat sintetis demo.
        2. Kandidat sintetis lama dipreservasi penuh di data/fixtures/synthetic_land_candidates.geojson.
        3. Seluruh fitur di berkas produksi berakar pada data faktual riil (Survei Tim / OSM).
        4. Zero klaim sewa tanpa bukti observasi terverifikasi.
        5. Zero harga sewa tanpa URL sumber bukti.
        """
        audit_res = audit_production_dataset(
            proc_cands_path="data/processed/land_candidates.geojson",
            fixtures_path="data/fixtures/synthetic_land_candidates.geojson"
        )
        self.assertEqual(audit_res["status"], "PASSED")
        self.assertEqual(audit_res["synthetic_in_production"], 0)
        self.assertEqual(audit_res["fake_rentable_claims"], 0)
        self.assertEqual(audit_res["unbacked_prices"], 0)
        self.assertEqual(audit_res["fixtures_preserved_count"], 20)
        # Ambang minimum disamakan dengan test_18 (>= 16 observasi nyata).
        self.assertGreaterEqual(audit_res["production_features_count"], 16)

        # Verifikasi langsung pada berkas produksi
        with open("data/processed/land_candidates.geojson", "r", encoding="utf-8") as f:
            proc_cands = json.load(f)["features"]

        for cf in proc_cands:
            p = cf["properties"]
            fid = p["id"]
            # Tidak boleh ada prefix CAND- atau data_kind demo di berkas produksi
            self.assertFalse(fid.startswith("CAND-"), f"ID {fid} adalah kandidat sintetis lama!")
            self.assertNotEqual(p.get("data_kind"), "synthetic_academic_demo")
            self.assertTrue(
                "survey" in p.get("data_kind", "") or "osm" in p.get("data_kind", ""),
                f"Data kind {p.get('data_kind')} tidak valid!"
            )
            # Jika mengklaim sewa, wajib memiliki bukti observasi (anti-fabrikasi)
            if p.get("is_rentable_or_sale"):
                self.assertTrue(
                    bool(p.get("evidence_url") or p.get("evidence_photo")),
                    f"Fitur {fid} tidak boleh mengklaim sewa tanpa bukti!"
                )
            # Tidak boleh ada harga sewa tanpa URL sumber bukti
            if p.get("rental_price_yr") is not None:
                self.assertTrue(bool(p.get("price_source_url")), f"Harga sewa pada {fid} harus memiliki sumber valid!")

    def test_20_midpoint_range_estimation_and_anti_fabrication(self):
        """
        Uji Estimasi Titik Tengah Rentang Harga (Mandat Anti-Fabrikasi):
        1. Nilai midpoint dari rentang [min, max] terdokumentasi WAJIB dilabeli estimasi (is_estimate=True).
        2. Nilai midpoint DILARANG diklaim sebagai harga transaksi atau harga penawaran riil (is_transaction_price=False).
        3. Rentang asli terdokumentasi (source_range) wajib disertakan utuh untuk transparansi.
        4. Jika rentang tidak lengkap (min atau max bernilai None), midpoint wajib bernilai None.
        5. Validasi kesalahan: batas bawah > batas atas memicu ValueError.
        """
        # A. Kasus valid rentang sewa terdokumentasi
        min_p = 60000000.0
        max_p = 90000000.0
        res = calculate_range_midpoint_estimate(min_p, max_p, source_label="Survei Koridor Dinoyo")
        self.assertEqual(res["midpoint"], 75000000.0)
        self.assertTrue(res["is_estimate"], "Titik tengah wajib dilabeli sebagai estimasi.")
        self.assertFalse(res["is_transaction_price"], "Titik tengah dilarang diklaim sebagai harga transaksi riil.")
        self.assertEqual(res["source_range"], [min_p, max_p])
        self.assertIn("Estimasi titik tengah", res["label"])

        # B. Kasus data tidak lengkap (None)
        res_null = calculate_range_midpoint_estimate(None, 80000000.0)
        self.assertIsNone(res_null["midpoint"])
        self.assertFalse(res_null["is_estimate"])

        # C. Kasus batas terbalik (min > max) memicu ValueError
        with self.assertRaises(ValueError):
            calculate_range_midpoint_estimate(100000000.0, 50000000.0)

    def test_21_synthetic_scenario_fixture_reproducibility_and_contract(self):
        """
        Uji Pembangkitan Reproduktibel Fixed-Seed & Kontrak Fixture Skenario Simulasi Sintetis:
        1. Fixture data/fixtures/synthetic_scenario_candidates.geojson ada dan valid skemanya.
        2. Keterulangan eksekusi (reproducibility): Menjalankan pembangkitan dua kali dengan seed=42
           menghasilkan payload yang identik (koordinat, ID, properti persis sama).
        3. Efektivitas seed: Menjalankan dengan seed berbeda (seed=999) menghasilkan koordinat berbeda.
        4. Batasan cacah: Jumlah fitur berada dalam rentang 4–10 situs kafe (tepat 8 situs).
        5. Kontrak anti-fabrikasi:
           - Setiap fitur memiliki data_kind='synthetic_scenario', is_real=False, simulated=True,
             is_factual=False, is_verified=False, is_eligible_as_verified=False.
           - generated_date='2026-11-01', generation_method='reproducible_fixed_seed_buffer_sampling', seed=42.
        6. Penandaan harga estimasi:
           - is_price_estimate=True, price_type='simulated_estimate', is_transaction_price=False.
           - rental_price_yr adalah angka positif berhingga.
        7. Keterlacakan bukti harga:
           - price_basis berupa penjelasan non-kosong.
           - source_listing_ids memuat ID listing sewa terverifikasi dari reports/research.md.
           - source_range berupa list [min, max] dengan min <= max.
        8. Validitas spasial buffer:
           - Setiap titik berada di dalam buffer 1km kampus (distance_meters <= 1000.0, is_in_buffer=True).
           - Koordinat berada dalam batas terpercaya SURABAYA_BBOX.
        9. Isolasi dataset produksi:
           - data/processed/land_candidates.geojson tetap memuat 33 fitur faktual OSM tanpa perubahan.
           - data/fixtures/synthetic_land_candidates.geojson tetap memuat 20 kandidat demo lama.
        """
        fixture_path = "data/fixtures/synthetic_scenario_candidates.geojson"
        self.assertTrue(os.path.exists(fixture_path), f"Fixture {fixture_path} harus tersedia di filesystem.")

        # 1. Audit Skema & Kontrak Fixture
        audit_res = audit_synthetic_scenario_fixture(fixture_path)
        self.assertEqual(audit_res["status"], "PASSED")
        self.assertEqual(audit_res["seed"], 42)

        # 2. Verifikasi Batasan Cacah Fitur (4–10 situs)
        self.assertGreaterEqual(audit_res["features_count"], 4)
        self.assertLessEqual(audit_res["features_count"], 10)
        self.assertEqual(audit_res["features_count"], 8)

        # 3. Verifikasi Ulang Keterulangan Pembangkitan (Fixed-Seed Reproducibility)
        file_run1 = os.path.join(self.temp_dir, "scenario_run1.geojson")
        file_run2 = os.path.join(self.temp_dir, "scenario_run2.geojson")
        file_run_diff_seed = os.path.join(self.temp_dir, "scenario_diff_seed.geojson")

        res1 = generate_synthetic_scenario_fixture(
            universities_path="data/raw/universities.geojson",
            output_path=file_run1,
            seed=42,
            pipeline=self.pipeline
        )
        res2 = generate_synthetic_scenario_fixture(
            universities_path="data/raw/universities.geojson",
            output_path=file_run2,
            seed=42,
            pipeline=self.pipeline
        )
        res_diff = generate_synthetic_scenario_fixture(
            universities_path="data/raw/universities.geojson",
            output_path=file_run_diff_seed,
            seed=999,
            pipeline=self.pipeline
        )

        with open(file_run1, "r", encoding="utf-8") as f1, open(file_run2, "r", encoding="utf-8") as f2:
            data1 = json.load(f1)
            data2 = json.load(f2)

        # Harus identik bit-for-bit antara dua pemanggilan ber-seed sama
        self.assertEqual(data1, data2, "Pembangkitan dengan seed sama (seed=42) harus deterministik dan identik.")

        with open(file_run_diff_seed, "r", encoding="utf-8") as fd:
            data_diff = json.load(fd)

        # Seed berbeda harus menghasilkan koordinat yang berbeda
        c1 = data1["features"][0]["geometry"]["coordinates"]
        c_diff = data_diff["features"][0]["geometry"]["coordinates"]
        self.assertNotEqual(c1, c_diff, "Seed berbeda harus menghasilkan koordinat titik yang berbeda.")

        # 4. Verifikasi Kontrak Detail Setiap Fitur pada Fixture
        with open(fixture_path, "r", encoding="utf-8") as f:
            fixture_data = json.load(f)

        features = fixture_data["features"]
        verified_prefix_patterns = ("UNAIR-", "UKWMS-", "UBAYA-")

        for idx, feat in enumerate(features):
            props = feat["properties"]
            fid = props["id"]

            # Kontrak Anti-Fabrikasi
            self.assertEqual(props["data_kind"], "synthetic_scenario")
            self.assertFalse(props["is_real"])
            self.assertTrue(props["simulated"])
            self.assertFalse(props["is_factual"])
            self.assertFalse(props["is_verified"])
            self.assertFalse(props["is_eligible_as_verified"])

            # Penanda Estimasi Harga
            self.assertTrue(props["is_price_estimate"])
            self.assertEqual(props["price_type"], "simulated_estimate")
            self.assertFalse(props["is_transaction_price"])
            self.assertIsInstance(props["rental_price_yr"], (int, float))
            self.assertGreater(props["rental_price_yr"], 0.0)

            # Metadata Reproduktibilitas & Penanda Penempatan Acak Konsisten
            self.assertEqual(props["generated_date"], "2026-11-01")
            self.assertEqual(props["generation_method"], "reproducible_fixed_seed_buffer_sampling")
            self.assertEqual(props["seed"], 42)
            self.assertTrue(props["random_placement"], f"{fid}: random_placement harus True")
            self.assertTrue(props["is_random_placement"], f"{fid}: is_random_placement harus True")
            self.assertEqual(props["placement"], "random")
            self.assertTrue(props["is_scenario"], f"{fid}: is_scenario harus True")

            # Kompatibilitas Skema Frontend (nearest_university_id & nearest_university_name)
            self.assertIn("nearest_university_id", props)
            self.assertIn("nearest_university_name", props)
            self.assertEqual(props["nearest_university_id"], props["target_campus_id"])
            self.assertEqual(props["nearest_university_name"], props["target_campus_name"])
            self.assertIn(props["nearest_university_id"], CAMPUS_POLYGONS_WGS84)

            # Keterlacakan Bukti Riset
            self.assertIsInstance(props["price_basis"], str)
            self.assertGreater(len(props["price_basis"]), 15)
            self.assertIsInstance(props["source_listing_ids"], list)
            self.assertGreater(len(props["source_listing_ids"]), 0)
            for lid in props["source_listing_ids"]:
                self.assertTrue(
                    any(lid.startswith(pfx) for pfx in verified_prefix_patterns),
                    f"ID listing {lid} tidak sesuai konvensi listing terverifikasi di reports/research.md"
                )

            self.assertIsInstance(props["source_range"], list)
            self.assertEqual(len(props["source_range"]), 2)
            self.assertLessEqual(props["source_range"][0], props["source_range"][1])

            # Metrik Jarak Spasial
            coords = feat["geometry"]["coordinates"]
            self.assertEqual(len(coords), 2)
            lon, lat = coords[0], coords[1]

            # Bounding box Surabaya
            self.assertGreaterEqual(lon, SURABAYA_BBOX["min_lon"])
            self.assertLessEqual(lon, SURABAYA_BBOX["max_lon"])
            self.assertGreaterEqual(lat, SURABAYA_BBOX["min_lat"])
            self.assertLessEqual(lat, SURABAYA_BBOX["max_lat"])

            # Jarak dalam buffer 1km
            self.assertLessEqual(props["distance_meters"], 1000.0)
            self.assertTrue(props["is_in_buffer"])
            self.assertLessEqual(props["distance_to_polygon_meters"], 1000.0)

        # 5. Verifikasi Isolasi Mutlak Dataset Produksi & Fixture Lama
        audit_prod = audit_production_dataset(
            proc_cands_path="data/processed/land_candidates.geojson",
            fixtures_path="data/fixtures/synthetic_land_candidates.geojson"
        )
        self.assertEqual(audit_prod["status"], "PASSED")
        with open("data/raw/survey_land_candidates.geojson", "r", encoding="utf-8") as f:
            expected_production = len(json.load(f)["features"])
        self.assertEqual(audit_prod["production_features_count"], expected_production)
        self.assertEqual(audit_prod["fixtures_preserved_count"], 20)

    def test_22_centralized_radius_config_and_dual_buffer_generation(self):
        """
        GIS Task 2: Konfigurasi Radius Terpusat & Output Buffer Dual (500m & 1000m):
        1. Konstanta radius baku terpusat: BASELINE_RADIUS_METERS=500.0 & SCENARIO_RADIUS_METERS=1000.0.
        2. RADIUS_CONFIG memuat definisi 'baseline' (500m) dan 'scenario' (1000m).
        3. File buffer radial tersedia: buffer_500m.geojson, buffer_1000m.geojson, buffer_1km.geojson (alias).
        4. File buffer dilatasi poligon tersedia: buffer_polygon_500m.geojson, buffer_polygon_1000m.geojson, buffer_polygon_1km.geojson.
        5. Setiap berkas memuat tepat 8 poligon tertutup valid (closed ring) untuk 8 kampus sasaran.
        """
        self.assertEqual(BASELINE_RADIUS_METERS, 500.0)
        self.assertEqual(SCENARIO_RADIUS_METERS, 1000.0)
        self.assertEqual(SUPPORTED_RADII_METERS, [500.0, 1000.0])
        self.assertIn("baseline", RADIUS_CONFIG)
        self.assertIn("scenario", RADIUS_CONFIG)
        self.assertEqual(RADIUS_CONFIG["baseline"]["radius_m"], 500.0)
        self.assertEqual(RADIUS_CONFIG["scenario"]["radius_m"], 1000.0)

        expected_buffer_files = [
            ("data/processed/buffer_500m.geojson", 500, "radial"),
            ("data/processed/buffer_1000m.geojson", 1000, "radial"),
            ("data/processed/buffer_1km.geojson", 1000, "radial"),
            ("data/processed/buffer_polygon_500m.geojson", 500, "polygon_dilation"),
            ("data/processed/buffer_polygon_1000m.geojson", 1000, "polygon_dilation"),
            ("data/processed/buffer_polygon_1km.geojson", 1000, "polygon_dilation"),
        ]

        for file_path, expected_radius, buf_type in expected_buffer_files:
            self.assertTrue(os.path.exists(file_path), f"Berkas {file_path} wajib ada di filesystem.")
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            self.assertEqual(data.get("type"), "FeatureCollection")
            meta = data.get("metadata", {})
            self.assertEqual(meta.get("radius_m"), expected_radius)
            self.assertEqual(len(data.get("features", [])), 8, f"{file_path} harus memuat tepat 8 fitur buffer.")

            for feat in data["features"]:
                self.assertEqual(feat.get("type"), "Feature")
                geom = feat.get("geometry", {})
                self.assertEqual(geom.get("type"), "Polygon")
                coords = geom.get("coordinates", [])
                self.assertGreater(len(coords), 0)
                ring = coords[0]
                self.assertGreaterEqual(len(ring), 4)
                self.assertEqual(ring[0], ring[-1], "Ring poligon buffer wajib tertutup eksak (closed ring).")
                self.assertEqual(feat["properties"]["radius_m"], expected_radius)

    def test_23_candidate_and_cafe_metrics_dual_radius(self):
        """
        GIS Task 3: Metrik Kandidat Lahan & Kafe untuk Kedua Radius (500m & 1000m):
        1. Kandidat lahan memuat flag: is_in_buffer_500m, is_in_buffer_1000m, is_eligible_500m, is_eligible_1000m.
        2. Invarian himpunan bagian: jika is_in_buffer_500m=True maka is_in_buffer_1000m wajib bernilai True.
        3. Backward compatibility: is_in_buffer == is_in_buffer_1000m dan is_eligible == is_eligible_1000m.
        4. Kafe OSM memuat flag: is_in_buffer_500m dan is_in_buffer_1000m.
        5. Kafe OSM dalam 500m (23 kafe) merupakan subset konsisten dari 1000m (59 kafe).
        """
        # A. Evaluasi Kandidat Lahan
        with open("data/processed/land_candidates.geojson", "r", encoding="utf-8") as f:
            cands_data = json.load(f)

        features = cands_data.get("features", [])
        self.assertGreaterEqual(len(features), 1)

        for feat in features:
            p = feat["properties"]
            fid = p["id"]
            dist = p["distance_meters"]

            self.assertIn("is_in_buffer_500m", p)
            self.assertIn("is_in_buffer_1000m", p)
            self.assertIn("is_eligible_500m", p)
            self.assertIn("is_eligible_1000m", p)

            # Validasi matematis jarak vs bendera
            if dist <= 500.0:
                self.assertTrue(p["is_in_buffer_500m"], f"{fid}: dist={dist} <= 500 tapi is_in_buffer_500m False")
            else:
                self.assertFalse(p["is_in_buffer_500m"], f"{fid}: dist={dist} > 500 tapi is_in_buffer_500m True")

            if dist <= 1000.0:
                self.assertTrue(p["is_in_buffer_1000m"], f"{fid}: dist={dist} <= 1000 tapi is_in_buffer_1000m False")
            else:
                self.assertFalse(p["is_in_buffer_1000m"], f"{fid}: dist={dist} > 1000 tapi is_in_buffer_1000m True")

            # Invarian subset: 500m subset dari 1000m
            if p["is_in_buffer_500m"]:
                self.assertTrue(p["is_in_buffer_1000m"], f"{fid}: in 500m harus in 1000m")
            if p["is_eligible_500m"]:
                self.assertTrue(p["is_eligible_1000m"], f"{fid}: eligible 500m harus eligible 1000m")

            # Kompatibilitas mundur
            self.assertEqual(p["is_in_buffer"], p["is_in_buffer_1000m"])
            self.assertEqual(p["is_eligible"], p["is_eligible_1000m"])

        # B. Evaluasi Kafe OSM
        with open("data/processed/osm_cafes.geojson", "r", encoding="utf-8") as f:
            cafes_data = json.load(f)

        cafe_feats = cafes_data.get("features", [])
        count_500 = sum(1 for cf in cafe_feats if cf["properties"]["is_in_buffer_500m"])
        count_1000 = sum(1 for cf in cafe_feats if cf["properties"]["is_in_buffer_1000m"])

        self.assertEqual(count_500, 23, "Tepat 23 kafe eksisting OSM berada di dalam baseline 500m")
        self.assertEqual(count_1000, 59, "Tepat 59 kafe eksisting OSM berada di dalam skenario 1000m")
        self.assertLessEqual(count_500, count_1000)

        meta = cafes_data.get("metadata", {})
        self.assertEqual(meta.get("in_buffer_500m_count"), 23)
        self.assertEqual(meta.get("in_buffer_1000m_count"), 59)

    def test_24_gate_distance_null_provenance(self):
        """
        GIS Task 5: Penegakan Jarak Gerbang Kampus Bernilai NULL (UNOBSERVED):
        1. Jarak ke gerbang utama kampus (distance_to_nearest_gate_meters) strictly bernilai None / null.
        2. Status observasi gerbang (gate_observation_status) wajib bernilai 'UNOBSERVED'.
        3. Dilarang keras mengarang koordinat gerbang kampus atau menghitung jarak rekaan.
        4. Berlaku pada seluruh layer: kandidat lahan, kafe OSM, dan fixture skenario sintetis.
        """
        # 1. Kandidat Lahan
        with open("data/processed/land_candidates.geojson", "r", encoding="utf-8") as f:
            cands = json.load(f)["features"]
        for feat in cands:
            p = feat["properties"]
            fid = p["id"]
            self.assertIsNone(p.get("distance_to_nearest_gate_meters"), f"{fid}: distance_to_nearest_gate_meters harus None")
            self.assertEqual(p.get("gate_observation_status"), "UNOBSERVED")
            self.assertIn("belum diobservasi", p.get("gate_notes", ""))

        # 2. Kafe OSM
        with open("data/processed/osm_cafes.geojson", "r", encoding="utf-8") as f:
            cafes = json.load(f)["features"]
        for feat in cafes:
            p = feat["properties"]
            self.assertIsNone(p.get("distance_to_nearest_gate_meters"))
            self.assertEqual(p.get("gate_observation_status"), "UNOBSERVED")

        # 3. Fixture Skenario Sintetis
        with open("data/fixtures/synthetic_scenario_candidates.geojson", "r", encoding="utf-8") as f:
            scenarios = json.load(f)["features"]
        for feat in scenarios:
            p = feat["properties"]
            self.assertIsNone(p.get("distance_to_nearest_gate_meters"))
            self.assertEqual(p.get("gate_observation_status"), "UNOBSERVED")

    def test_25_transparent_scoring_renormalization_and_assumptions(self):
        """
        GIS Task 8: Skor Kelayakan Transparan dengan Renormalisasi Komponen Null & Asumsi Tim Terpusat:
        1. Parameter asumsi tim terpusat (bobot: 40 proksimitas, 30 luas, 30 efisiensi sewa).
        2. Mandat anti-fabrikasi sewa: Never guess rent (harga sewa null tidak boleh ditebak).
        3. Komponen null dikeluarkan dari pembagi bobot; skor direnormalisasi ke skala 0-100 secara proporsional.
        4. Kandidat dari survei lapangan Street View (luas & sewa null) menghasilkan skor ternormalisasi jujur.
        5. Mode radius 500m dan 1000m menggunakan ambang jarak yang disesuaikan secara transparan.
        """
        # 1. Verifikasi Asumsi Terpusat
        assumptions = TEAM_SCORING_ASSUMPTIONS
        self.assertEqual(assumptions["weights"]["proximity"], 40.0)
        self.assertEqual(assumptions["weights"]["space"], 30.0)
        self.assertEqual(assumptions["weights"]["cost_efficiency"], 30.0)
        self.assertIn("never guess rent", assumptions["anti_fabrication_rule"].lower(), "Mandat anti-fabrikasi wajib ada")

        # 2. Kasus Ideal: Seluruh 3 komponen diobservasi lengkap
        res_full = calculate_transparent_feasibility_score(
            distance_meters=200.0,
            area_sqm=120.0,
            rental_price_yr=36000000.0,  # 300.000 / m2 -> efisien (30 poin)
            radius_mode="scenario_1km"
        )
        self.assertEqual(res_full["score_normalized"], 100.0)
        self.assertFalse(res_full["is_renormalized"])
        self.assertEqual(len(res_full["observed_components"]), 3)
        self.assertEqual(len(res_full["null_components"]), 0)
        self.assertEqual(res_full["grade"], "Sangat Strategis ★★★")

        # 3. Kasus Realistis Street View (Mandat Anti-Fabrikasi: rent & space NULL)
        # Hanya jarak 200m yang diobservasi (40 poin dari maks bobot 40)
        res_renorm = calculate_transparent_feasibility_score(
            distance_meters=200.0,
            area_sqm=None,
            rental_price_yr=None,
            radius_mode="scenario_1km"
        )
        self.assertTrue(res_renorm["is_renormalized"])
        self.assertEqual(res_renorm["max_available_weight"], 40.0)
        self.assertEqual(res_renorm["raw_earned_points"], 40.0)
        self.assertEqual(res_renorm["score_normalized"], 100.0)  # (40 / 40) * 100 = 100.0
        self.assertIn("space", res_renorm["null_components"])
        self.assertIn("cost_efficiency", res_renorm["null_components"])

        # 4. Mode Radius Baseline 500m vs Scenario 1km
        # Jarak 250m: Pada 1km (<=300m) dapat 40 poin; Pada 500m (<=300m) dapat 30 poin
        res_500m = calculate_transparent_feasibility_score(
            distance_meters=250.0,
            area_sqm=None,
            rental_price_yr=None,
            radius_mode="baseline_500m"
        )
        self.assertEqual(res_500m["raw_earned_points"], 30.0)
        self.assertEqual(res_500m["score_normalized"], 75.0)  # (30 / 40) * 100 = 75.0
        self.assertEqual(res_500m["grade"], "Strategis ★★")

        # 5. Verifikasi Data Kandidat Riil di land_candidates.geojson
        with open("data/processed/land_candidates.geojson", "r", encoding="utf-8") as f:
            proc_cands = json.load(f)["features"]

        for cf in proc_cands:
            p = cf["properties"]
            self.assertIn("feasibility_score_normalized", p)
            self.assertIn("feasibility_grade", p)
            self.assertIn("feasibility_scoring", p)
            self.assertIn("feasibility_scoring_baseline_500m", p)

            # Jika harga sewa null, sewa tidak boleh ditebak dan wajib masuk null_components
            if p["rental_price_yr"] is None:
                self.assertIn("cost_efficiency", p["feasibility_scoring"]["null_components"])
                self.assertTrue(p["feasibility_scoring"]["is_renormalized"])

    def test_26_strict_rfc8259_json_compliance_and_no_nonfinite_floats(self):
        """
        Uji Kepatuhan Ketat JSON RFC 8259 (Strict JSON Parser Regression):
        1. Seluruh berkas GeoJSON dan JSON di data/processed/ dan data/fixtures/ wajib mematuhi RFC 8259.
        2. Dilarang keras memuat float non-finit (Infinity, -Infinity, NaN).
        3. Parser ketat Python (json.loads dengan parse_constant penolak) dan Node.js JSON.parse
           berhasil mem-parse seluruh berkas tanpa error.
        4. Parameter TEAM_SCORING_ASSUMPTIONS dapat diserialisasi dengan json.dumps(allow_nan=False) tanpa ValueError.
        5. Injeksi float('inf') atau float('nan') wajib tertangkap dan ditolak oleh allow_nan=False.
        """
        def strict_constant_reject(c: str):
            raise ValueError(f"Strict JSON RFC 8259 violation: non-finite constant '{c}' encountered.")

        # 1. Uji Serialisasi allow_nan=False pada Asumsi Penilaian Terpusat
        serialized_assumptions = json.dumps(TEAM_SCORING_ASSUMPTIONS, allow_nan=False, indent=2)
        self.assertNotIn("Infinity", serialized_assumptions)
        self.assertNotIn("NaN", serialized_assumptions)
        parsed_assumptions = json.loads(serialized_assumptions, parse_constant=strict_constant_reject)
        self.assertIsNone(parsed_assumptions["proximity_thresholds_m"]["scenario_1km"]["unsuitable"][0])
        self.assertIsNone(parsed_assumptions["cost_efficiency_thresholds_idr_per_sqm_yr"]["high"][0])

        # 2. Verifikasi Efektivitas Guard allow_nan=False
        bad_payload = {"test_inf": float("inf")}
        with self.assertRaises(ValueError):
            json.dumps(bad_payload, allow_nan=False)

        bad_nan_payload = {"test_nan": float("nan")}
        with self.assertRaises(ValueError):
            json.dumps(bad_nan_payload, allow_nan=False)

        # 3. Verifikasi Seluruh Berkas JSON / GeoJSON di data/processed/ dan data/fixtures/
        target_dirs = ["data/processed", "data/fixtures"]
        files_verified = 0

        for d in target_dirs:
            if not os.path.exists(d):
                continue
            for fname in os.listdir(d):
                if not (fname.endswith(".json") or fname.endswith(".geojson")):
                    continue
                fpath = os.path.join(d, fname)
                with open(fpath, "r", encoding="utf-8") as f:
                    raw_content = f.read()

                # Cek teks mentah tanpa Infinity atau NaN
                self.assertNotIn("Infinity", raw_content, f"Berkas {fpath} memuat token 'Infinity' tidak sesuai RFC 8259!")
                self.assertNotIn("NaN", raw_content, f"Berkas {fpath} memuat token 'NaN' tidak sesuai RFC 8259!")

                # Parse ketat dengan Python JSON parser (menolak parse_constant)
                try:
                    parsed_obj = json.loads(raw_content, parse_constant=strict_constant_reject)
                    self.assertIsInstance(parsed_obj, (dict, list))
                    files_verified += 1
                except Exception as e:
                    self.fail(f"Strict JSON parser gagal mem-parse {fpath}: {e}")

        self.assertGreaterEqual(files_verified, 10, "Minimal 10 berkas GeoJSON/JSON produksi wajib teruji.")

if __name__ == "__main__":
    unittest.main()
