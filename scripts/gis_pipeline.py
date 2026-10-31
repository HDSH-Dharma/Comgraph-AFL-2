#!/usr/bin/env python3
"""
GIS Pipeline Engine - Proyek Buka Kafe (AFL 2 Computer Graphics)
Surabaya University Buffer (1.000m) & Land Candidate Spatial Evaluation.

CRS Transformations:
  - Input: EPSG:4326 (WGS 84, [lon, lat])
  - Computation: EPSG:32749 (WGS 84 / UTM Zone 49S, metric [x, y])
  - Output: EPSG:4326 (WGS 84 GeoJSON compliant)
"""

import os
import sys
import math
import json
import argparse
from typing import Dict, List, Tuple, Any, Optional

try:
    import pyproj
except ImportError:
    print("Error: 'pyproj' library is required. Install via 'pip install pyproj'.", file=sys.stderr)
    sys.exit(1)

# Status taksonomi baku 5 status lahan
VALID_LAND_STATUSES = [
    "Lahan kosong",
    "Lahan yang tersedia untuk disewakan",
    "Rumah atau bangunan tempat tinggal",
    "Bangunan yang telah digunakan untuk fungsi lain",
    "Lahan yang statusnya belum terverifikasi"
]

DEFAULT_LAND_STATUS = "Lahan yang statusnya belum terverifikasi"
ELIGIBLE_STATUSES = {
    "Lahan kosong",
    "Lahan yang tersedia untuk disewakan"
}

# Boundary geografis terpercaya kawasan Surabaya & sekitarnya
SURABAYA_BBOX = {
    "min_lon": 112.50,
    "max_lon": 112.95,
    "min_lat": -7.45,
    "max_lat": -7.15
}

class GISPipeline:
    def __init__(self):
        # Inisialisasi proyektor koordinat dengan always_xy=True
        # EPSG:4326 [lon, lat] <-> EPSG:32749 [x, y]
        self.transformer_fwd = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:32749", always_xy=True)
        self.transformer_inv = pyproj.Transformer.from_crs("EPSG:32749", "EPSG:4326", always_xy=True)

    def validate_coordinate(self, lon: Any, lat: Any, name: str = "Titik") -> Tuple[float, float]:
        """
        Validasi batas kepercayaan (trust boundary) koordinat:
        - Harus bertipe numerik berhingga (finite float/int), bukan boolean.
        - Harus berada dalam rentang geografis valid di kawasan metropolitan Surabaya.
        """
        if isinstance(lon, bool) or isinstance(lat, bool):
            raise ValueError(f"Trust boundary violation: Koordinat untuk {name} tidak boleh berupa boolean.")

        try:
            flon = float(lon)
            flat = float(lat)
        except (TypeError, ValueError):
            raise ValueError(f"Trust boundary violation: Koordinat untuk {name} harus bernilai numerik.")

        if not (math.isfinite(flon) and math.isfinite(flat)):
            raise ValueError(f"Trust boundary violation: Koordinat untuk {name} harus berhingga (bukan NaN/Inf).")

        if not (SURABAYA_BBOX["min_lon"] <= flon <= SURABAYA_BBOX["max_lon"]):
            raise ValueError(
                f"Trust boundary violation: Longitude {flon} untuk {name} di luar batas Surabaya "
                f"[{SURABAYA_BBOX['min_lon']}, {SURABAYA_BBOX['max_lon']}]."
            )

        if not (SURABAYA_BBOX["min_lat"] <= flat <= SURABAYA_BBOX["max_lat"]):
            raise ValueError(
                f"Trust boundary violation: Latitude {flat} untuk {name} di luar batas Surabaya "
                f"[{SURABAYA_BBOX['min_lat']}, {SURABAYA_BBOX['max_lat']}]."
            )

        return flon, flat

    def normalize_status(self, raw_status: Optional[str]) -> str:
        """
        Normalisasi status lahan ke 5 status persis.
        Jika tidak terkonfirmasi, kosong, atau invalid, default ke 'Lahan yang statusnya belum terverifikasi'.
        """
        if not raw_status or not isinstance(raw_status, str):
            return DEFAULT_LAND_STATUS

        trimmed = raw_status.strip()
        if trimmed in VALID_LAND_STATUSES:
            return trimmed

        return DEFAULT_LAND_STATUS

    def create_radial_buffer_polygon(self, center_lon: float, center_lat: float, radius_m: float = 1000.0, num_segments: int = 128) -> List[List[float]]:
        """
        Membangkitkan poligon buffer radial lingkaran berjarak tepat radius_m (1.000m)
        pada sistem proyeksi metrik EPSG:32749, lalu mengembalikan koordinat cincin tertutup
        pada EPSG:4326 [lon, lat].
        """
        cx_m, cy_m = self.transformer_fwd.transform(center_lon, center_lat)

        ring: List[List[float]] = []
        for i in range(num_segments + 1):
            theta = 2.0 * math.pi * (i / num_segments)
            px = cx_m + radius_m * math.cos(theta)
            py = cy_m + radius_m * math.sin(theta)

            plon, plat = self.transformer_inv.transform(px, py)
            ring.append([round(plon, 7), round(plat, 7)])

        # Pastikan cincin tertutup secara eksak (closed ring)
        ring[-1] = ring[0]
        return ring

    def process(
        self,
        universities_path: str,
        candidates_path: str,
        output_dir: str
    ) -> Dict[str, Any]:
        """
        Menjalankan seluruh pipeline GIS:
        1. Membaca & memvalidasi data/raw/universities.geojson.
        2. Membangkitkan buffer 1.000 meter metrik -> data/processed/buffer_1km.geojson.
        3. Membaca & mengevaluasi kandidat lahan -> data/processed/land_candidates.geojson.
        4. Menyalin universitas terverifikasi -> data/processed/universities.geojson.
        """
        os.makedirs(output_dir, exist_ok=True)

        # 1. Load Universities
        if not os.path.exists(universities_path):
            raise FileNotFoundError(f"File input universitas tidak ditemukan: {universities_path}")

        with open(universities_path, "r", encoding="utf-8") as f:
            uni_geojson = json.load(f)

        uni_features = uni_geojson.get("features", [])
        if not uni_features:
            raise ValueError(f"File {universities_path} tidak memuat fitur universitas.")

        processed_campuses: List[Dict[str, Any]] = []
        buffer_features: List[Dict[str, Any]] = []
        uni_ids_seen = set()

        for idx, feat in enumerate(uni_features):
            geom = feat.get("geometry", {})
            props = feat.get("properties", {})

            cid = props.get("id")
            if not cid or not isinstance(cid, str) or not cid.strip():
                raise ValueError(f"Kampus pada indeks {idx} tidak memiliki properti 'id' valid.")
            cid = cid.strip()
            if cid in uni_ids_seen:
                raise ValueError(f"Duplikasi id kampus ditemukan: '{cid}'.")
            uni_ids_seen.add(cid)

            institution = props.get("institution", "").strip()
            univ_name = props.get("university_name", "").strip()
            campus_name = props.get("campus_name", "").strip()
            source = props.get("source", "").strip()
            verified_at = props.get("verified_at", "").strip()

            coords = geom.get("coordinates", [])
            if len(coords) < 2:
                raise ValueError(f"Koordinat tidak valid pada kampus {cid}.")

            lon, lat = self.validate_coordinate(coords[0], coords[1], name=f"Kampus {cid}")

            # Hitung koordinat metrik UTM Zone 49S
            xm, ym = self.transformer_fwd.transform(lon, lat)

            campus_entry = {
                "id": cid,
                "institution": institution,
                "university_name": univ_name,
                "campus_name": campus_name,
                "lon": lon,
                "lat": lat,
                "x_utm": xm,
                "y_utm": ym,
                "source": source,
                "verified_at": verified_at
            }
            processed_campuses.append(campus_entry)

            # Buat poligon buffer radial 1000m
            buffer_ring = self.create_radial_buffer_polygon(lon, lat, radius_m=1000.0, num_segments=128)

            buffer_features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [buffer_ring]
                },
                "properties": {
                    "university_id": cid,
                    "institution": institution,
                    "campus_name": campus_name,
                    "radius_m": 1000,
                    "crs_calculated": "EPSG:32749"
                }
            })

        # 2. Load Candidates
        if not os.path.exists(candidates_path):
            raise FileNotFoundError(f"File input kandidat lahan tidak ditemukan: {candidates_path}")

        with open(candidates_path, "r", encoding="utf-8") as f:
            cand_geojson = json.load(f)

        cand_features = cand_geojson.get("features", [])
        processed_candidates: List[Dict[str, Any]] = []
        cand_ids_seen = set()

        stats = {
            "total_candidates": len(cand_features),
            "in_buffer_count": 0,
            "out_of_buffer_count": 0,
            "eligible_count": 0,
            "ineligible_count": 0,
            "status_counts": {s: 0 for s in VALID_LAND_STATUSES}
        }

        for idx, feat in enumerate(cand_features):
            geom = feat.get("geometry", {})
            props = feat.get("properties", {})

            lid = props.get("id")
            if not lid or not isinstance(lid, str) or not lid.strip():
                raise ValueError(f"Kandidat lahan pada indeks {idx} tidak memiliki properti 'id' valid.")
            lid = lid.strip()
            if lid in cand_ids_seen:
                raise ValueError(f"Duplikasi id kandidat lahan ditemukan: '{lid}'.")
            cand_ids_seen.add(lid)

            name = props.get("name", f"Lahan {lid}").strip()
            address = props.get("address", "").strip()
            status = self.normalize_status(props.get("status"))

            try:
                area_sqm = float(props.get("area_sqm", 0.0))
            except (TypeError, ValueError):
                area_sqm = 0.0

            try:
                rental_price_yr = float(props.get("rental_price_yr", 0.0))
            except (TypeError, ValueError):
                rental_price_yr = 0.0

            data_kind = props.get("data_kind", "synthetic_academic_demo")
            source = props.get("source", "Simulasi Akademik AFL 2 2026")

            coords = geom.get("coordinates", [])
            if len(coords) < 2:
                raise ValueError(f"Koordinat tidak valid pada kandidat {lid}.")

            lon, lat = self.validate_coordinate(coords[0], coords[1], name=f"Kandidat {lid}")
            lx, ly = self.transformer_fwd.transform(lon, lat)

            # Hitung jarak Euclidean ke seluruh titik kampus di CRS metrik EPSG:32749
            min_dist = float("inf")
            nearest_campus: Optional[Dict[str, Any]] = None

            for camp in processed_campuses:
                dist = math.sqrt((lx - camp["x_utm"]) ** 2 + (ly - camp["y_utm"]) ** 2)
                if dist < min_dist:
                    min_dist = dist
                    nearest_campus = camp

            if nearest_campus is None:
                raise RuntimeError("Gagal menentukan kampus terdekat.")

            # Batas inklusif <= 1000 meter tanpa pembulatan keputusan
            is_in_buffer = bool(min_dist <= 1000.0)
            is_eligible = bool(is_in_buffer and (status in ELIGIBLE_STATUSES))

            # Update statistik
            stats["status_counts"][status] += 1
            if is_in_buffer:
                stats["in_buffer_count"] += 1
            else:
                stats["out_of_buffer_count"] += 1

            if is_eligible:
                stats["eligible_count"] += 1
            else:
                stats["ineligible_count"] += 1

            processed_candidates.append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(lon, 7), round(lat, 7)]
                },
                "properties": {
                    "id": lid,
                    "name": name,
                    "address": address,
                    "status": status,
                    "area_sqm": area_sqm,
                    "rental_price_yr": rental_price_yr,
                    "nearest_university_id": nearest_campus["id"],
                    "nearest_university_name": nearest_campus["campus_name"],
                    "distance_meters": min_dist,  # unrounded float presisi penuh
                    "is_in_buffer": is_in_buffer,
                    "is_eligible": is_eligible,
                    "data_kind": data_kind,
                    "source": source
                }
            })

        # 3. Export Processed Universities
        universities_out_path = os.path.join(output_dir, "universities.geojson")
        exported_unis = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Titik Koordinat Terverifikasi Kampus Unair, Unesa, Ubaya (Processed)",
                "total_features": len(processed_campuses),
                "crs": "EPSG:4326",
                "computation_crs": "EPSG:32749"
            },
            "features": [
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [round(c["lon"], 7), round(c["lat"], 7)]
                    },
                    "properties": {
                        "id": c["id"],
                        "institution": c["institution"],
                        "university_name": c["university_name"],
                        "campus_name": c["campus_name"],
                        "source": c["source"],
                        "verified_at": c["verified_at"]
                    }
                }
                for c in processed_campuses
            ]
        }
        with open(universities_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_unis, f, indent=2, ensure_ascii=False)

        # 4. Export Processed Buffer 1km
        buffer_out_path = os.path.join(output_dir, "buffer_1km.geojson")
        exported_buffer = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Poligon Buffer Radial 1.000m Kampus Surabaya",
                "radius_m": 1000,
                "total_features": len(buffer_features),
                "crs": "EPSG:4326",
                "calculated_crs": "EPSG:32749"
            },
            "features": buffer_features
        }
        with open(buffer_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_buffer, f, indent=2, ensure_ascii=False)

        # 5. Export Processed Land Candidates
        candidates_out_path = os.path.join(output_dir, "land_candidates.geojson")
        exported_candidates = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Kandidat Lahan Terklasifikasi & Terevaluasi Spasial",
                "total_features": len(processed_candidates),
                "crs": "EPSG:4326",
                "evaluation_rules": {
                    "buffer_threshold_meters": 1000.0,
                    "eligible_statuses": list(ELIGIBLE_STATUSES)
                },
                "summary": stats
            },
            "features": processed_candidates
        }
        with open(candidates_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_candidates, f, indent=2, ensure_ascii=False)

        return {
            "universities_count": len(processed_campuses),
            "buffers_count": len(buffer_features),
            "candidates_count": len(processed_candidates),
            "stats": stats,
            "outputs": {
                "universities": universities_out_path,
                "buffer_1km": buffer_out_path,
                "land_candidates": candidates_out_path
            }
        }

def main():
    parser = argparse.ArgumentParser(description="GIS Processing Pipeline - Proyek Buka Kafe Surabaya")
    parser.add_argument("--universities", default="data/raw/universities.geojson", help="Path file input universities.geojson")
    parser.add_argument("--candidates", default="data/raw/land_candidates.geojson", help="Path file input land_candidates.geojson")
    parser.add_argument("--output-dir", default="data/processed", help="Direktori target output processed data")

    args = parser.parse_args()

    pipeline = GISPipeline()
    print(f"=== Menjalankan GIS Pipeline Buka Kafe ===")
    print(f"Input Universitas : {args.universities}")
    print(f"Input Kandidat    : {args.candidates}")
    print(f"Output Direktori  : {args.output_dir}")

    try:
        result = pipeline.process(
            universities_path=args.universities,
            candidates_path=args.candidates,
            output_dir=args.output_dir
        )
        print("\n[SUCCESS] Pemrosesan GIS selesai:")
        print(f"  - Titik Kampus Diproses : {result['universities_count']}")
        print(f"  - Poligon Buffer 1 km   : {result['buffers_count']}")
        print(f"  - Kandidat Dievaluasi   : {result['candidates_count']}")
        print(f"    * Di dalam buffer <=1km: {result['stats']['in_buffer_count']}")
        print(f"    * Di luar buffer >1km  : {result['stats']['out_of_buffer_count']}")
        print(f"    * Status ELIGIBLE     : {result['stats']['eligible_count']}")
        print(f"    * Status INELIGIBLE   : {result['stats']['ineligible_count']}")
        print("\nFile Output:")
        for k, v in result["outputs"].items():
            print(f"  - {k}: {v}")
    except Exception as e:
        print(f"\n[ERROR] Pipeline gagal: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
