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
    SURABAYA_BBOX
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
        with open(cand_out) as f:
            cand_data = json.load(f)
        self.assertEqual(cand_data["type"], "FeatureCollection")
        self.assertEqual(len(cand_data["features"]), 20)

        required_cand_props = [
            "id", "name", "address", "status", "area_sqm", "rental_price_yr",
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

        # Verifikasi kandidat khusus UKWMS
        ukwms_cands = [cf for cf in cand_data["features"] if cf["properties"]["id"].startswith("CAND-UKWMS-")]
        self.assertEqual(len(ukwms_cands), 4, "Harus ada 4 kandidat yang dikurasi khusus untuk UKWMS.")
        for uk_cand in ukwms_cands:
            p = uk_cand["properties"]
            self.assertTrue(p["is_in_buffer"], f"Kandidat {p['id']} harus berada di dalam buffer UKWMS.")
            self.assertLessEqual(p["distance_meters"], 1000.0)

if __name__ == "__main__":
    unittest.main()
