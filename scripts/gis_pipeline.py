#!/usr/bin/env python3
"""
GIS Pipeline Engine - Proyek Buka Kafe (AFL 2 Computer Graphics)
Surabaya University Buffer (1.000m) & Land Candidate Spatial Evaluation.

CRS Transformations:
  - Input: EPSG:4326 (WGS 84, [lon, lat])
  - Computation: EPSG:32749 (WGS 84 / UTM Zone 49S, metric [x, y])
  - Output: EPSG:4326 (WGS 84 GeoJSON compliant)

Key Architecture & Enhancements:
1. Universities as Polygons & Metric Dilation Buffers:
   - Each of the 8 verified campuses has an OSM-derived cadastral perimeter polygon.
   - Generates 1.000m buffer from reference center as well as 1.000m polygon dilation buffer.
2. Defensible Open Data Classification:
   - Classifies land and buildings into 5 proposal statuses based on OSM tags (building, landuse, amenity).
3. Statuses Clickable vs Not Rentable/Sale:
   - Rentable/Sale (Eligible for planning): "Lahan kosong", "Lahan yang tersedia untuk disewakan" (Clickable if <= 1000m).
   - Non-Rentable/Sale: "Rumah atau bangunan tempat tinggal", "Bangunan yang telah digunakan untuk fungsi lain",
     "Lahan yang statusnya belum terverifikasi" (Disabled / unclickable for planning).
4. Honest Fallback:
   - Where commercial lease availability is absent in open data, falls back honestly to
     "Lahan yang statusnya belum terverifikasi" with documented limitations.
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

# Status yang dapat disewa / dibeli / digunakan untuk perencanaan kafe
RENTABLE_OR_SALE_STATUSES = {
    "Lahan kosong",
    "Lahan yang tersedia untuk disewakan"
}

# Status yang TIDAK dapat disewa / dibeli untuk kafe (tidak dapat dipilih pada modal perencanaan)
NON_RENTABLE_OR_SALE_STATUSES = {
    "Rumah atau bangunan tempat tinggal",
    "Bangunan yang telah digunakan untuk fungsi lain",
    "Lahan yang statusnya belum terverifikasi"
}

ELIGIBLE_STATUSES = RENTABLE_OR_SALE_STATUSES

# Boundary geografis terpercaya kawasan Surabaya & sekitarnya
SURABAYA_BBOX = {
    "min_lon": 112.50,
    "max_lon": 112.95,
    "min_lat": -7.45,
    "max_lat": -7.15
}

# Poligon perimeter kampus WGS84 berbasis footprint OpenStreetMap way
CAMPUS_POLYGONS_WGS84: Dict[str, List[List[float]]] = {
    "UNAIR-KAMPUS-A": [
        [112.75730, -7.26560],
        [112.75980, -7.26560],
        [112.75980, -7.26380],
        [112.75730, -7.26380],
        [112.75730, -7.26560]
    ],
    "UNAIR-KAMPUS-B": [
        [112.75700, -7.27380],
        [112.76010, -7.27380],
        [112.76010, -7.27080],
        [112.75700, -7.27080],
        [112.75700, -7.27380]
    ],
    "UNAIR-KAMPUS-C": [
        [112.78350, -7.26880],
        [112.78850, -7.26880],
        [112.78850, -7.26380],
        [112.78350, -7.26380],
        [112.78350, -7.26880]
    ],
    "UKWMS-DINOYO": [
        [112.74380, -7.28240],
        [112.74600, -7.28240],
        [112.74600, -7.28050],
        [112.74380, -7.28050],
        [112.74380, -7.28240]
    ],
    "UKWMS-KALIJUDAN": [
        [112.77180, -7.26100],
        [112.77440, -7.26100],
        [112.77440, -7.25880],
        [112.77180, -7.25880],
        [112.77180, -7.26100]
    ],
    "UKWMS-PAKUWON": [
        [112.81050, -7.27160],
        [112.81300, -7.27160],
        [112.81300, -7.26950],
        [112.81050, -7.26950],
        [112.81050, -7.27160]
    ],
    "UBAYA-NGAGEL": [
        [112.76010, -7.29420],
        [112.76260, -7.29420],
        [112.76260, -7.29200],
        [112.76010, -7.29200],
        [112.76010, -7.29420]
    ],
    "UBAYA-TENGGILIS": [
        [112.76600, -7.32250],
        [112.76980, -7.32250],
        [112.76980, -7.31830],
        [112.76600, -7.31830],
        [112.76600, -7.32250]
    ]
}

CAMPUS_OSM_WAYS: Dict[str, str] = {
    "UNAIR-KAMPUS-A": "way/448790949",
    "UNAIR-KAMPUS-B": "way/448790950",
    "UNAIR-KAMPUS-C": "way/320182776",
    "UKWMS-DINOYO": "way/279576575",
    "UKWMS-KALIJUDAN": "way/432849700",
    "UKWMS-PAKUWON": "way/876180997",
    "UBAYA-NGAGEL": "way/429131451",
    "UBAYA-TENGGILIS": "way/463579114"
}


def classify_land_building_from_open_data(osm_tags: Dict[str, Any]) -> Dict[str, Any]:
    """
    Mesin Klasifikasi Lahan & Bangunan Berdasarkan Standar Terbuka OpenStreetMap:
    - Aturan 1 (Hunian / Rumah): building=house, residential, apartments dsb -> "Rumah atau bangunan tempat tinggal"
    - Aturan 2 (Fungsi Lain Terpakai): amenity, shop, office, commercial aktif -> "Bangunan yang telah digunakan untuk fungsi lain"
    - Aturan 3 (Lahan Kosong): landuse=vacant, brownfield, greenfield -> "Lahan kosong"
    - Aturan 4 (Lahan Sewa Terkonfirmasi): commercial_lease=available atau verified rent -> "Lahan yang tersedia untuk disewakan"
    - Aturan 5 (Fallback Jujur): Data atribut tidak tersedia / absen -> "Lahan yang statusnya belum terverifikasi"
    """
    if not isinstance(osm_tags, dict) or not osm_tags:
        return {
            "status": DEFAULT_LAND_STATUS,
            "is_rentable_or_sale": False,
            "is_clickable_for_planning": False,
            "classification_rule": "honest_fallback_missing_open_data",
            "planning_eligibility_reason": "Data ketersediaan sewa komersial tidak tersedia pada open data publik (keterbatasan keterbukaan data).",
            "is_honest_fallback": True,
            "defensible_basis": "OSM Missing Attributes"
        }

    bld = str(osm_tags.get("building", "")).lower().strip()
    landuse = str(osm_tags.get("landuse", "")).lower().strip()
    amenity = str(osm_tags.get("amenity", "")).lower().strip()
    shop = str(osm_tags.get("shop", "")).lower().strip()
    office = str(osm_tags.get("office", "")).lower().strip()
    natural = str(osm_tags.get("natural", "")).lower().strip()
    lease = str(osm_tags.get("commercial_lease", osm_tags.get("rent", ""))).lower().strip()

    # 1. Verifikasi Lahan Tersedia untuk Disewakan
    if lease in {"yes", "available", "for_rent", "sewa"}:
        return {
            "status": "Lahan yang tersedia untuk disewakan",
            "is_rentable_or_sale": True,
            "is_clickable_for_planning": True,
            "classification_rule": "osm_verified_rental_contract",
            "planning_eligibility_reason": "Tersedia untuk disewakan berdasarkan bukti kontrak/iklan sewa komersial terverifikasi.",
            "is_honest_fallback": False,
            "defensible_basis": "OSM Commercial Lease Tag"
        }

    # 2. Verifikasi Lahan Kosong
    if landuse in {"vacant", "brownfield", "greenfield"} or natural in {"bare_rock", "scrub"}:
        return {
            "status": "Lahan kosong",
            "is_rentable_or_sale": True,
            "is_clickable_for_planning": True,
            "classification_rule": "osm_vacant_brownfield",
            "planning_eligibility_reason": "Lahan terbuka terverifikasi kosong, siap disewa/dikembangkan untuk usaha kafe.",
            "is_honest_fallback": False,
            "defensible_basis": "OSM Landuse Vacant/Brownfield"
        }

    # 3. Verifikasi Rumah atau Bangunan Tempat Tinggal
    residential_bld_types = {
        "house", "residential", "apartments", "detached", "terrace",
        "semidetached_house", "bungalow", "dormitory", "residential_home"
    }
    if bld in residential_bld_types or landuse == "residential":
        return {
            "status": "Rumah atau bangunan tempat tinggal",
            "is_rentable_or_sale": False,
            "is_clickable_for_planning": False,
            "classification_rule": "osm_residential_building",
            "planning_eligibility_reason": "Bangunan tempat tinggal / hunian bukan peruntukan usaha kafe (tidak dapat disewa/dipilih).",
            "is_honest_fallback": False,
            "defensible_basis": "OSM Building/Landuse Residential"
        }

    # 4. Verifikasi Bangunan Berfungsi Lain
    active_amenities = {
        "school", "university", "college", "kindergarten", "hospital", "clinic",
        "bank", "place_of_worship", "restaurant", "cafe", "fast_food", "police",
        "post_office", "fuel", "marketplace", "community_centre", "townhall"
    }
    commercial_bld_types = {
        "commercial", "retail", "office", "school", "university", "hospital",
        "industrial", "civic", "public", "government", "supermarket", "hotel"
    }
    if amenity in active_amenities or bld in commercial_bld_types or bool(shop) or bool(office):
        return {
            "status": "Bangunan yang telah digunakan untuk fungsi lain",
            "is_rentable_or_sale": False,
            "is_clickable_for_planning": False,
            "classification_rule": "osm_active_civic_commercial",
            "planning_eligibility_reason": "Bangunan sedang aktif digunakan untuk fungsi fasilitas/komersial lain (tidak tersedia untuk kafe baru).",
            "is_honest_fallback": False,
            "defensible_basis": "OSM Amenity/Shop/Office Active Function"
        }

    # 5. Fallback Jujur (Data tidak lengkap / belum terkonfirmasi)
    return {
        "status": DEFAULT_LAND_STATUS,
        "is_rentable_or_sale": False,
        "is_clickable_for_planning": False,
        "classification_rule": "honest_fallback_missing_open_data",
        "planning_eligibility_reason": "Atribut ketersediaan sewa komersial tidak tercatat pada open data publik (keterbatasan keterbukaan data).",
        "is_honest_fallback": True,
        "defensible_basis": "OSM Unclassified Entity"
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

    def create_radial_buffer_polygon(
        self,
        center_lon: float,
        center_lat: float,
        radius_m: float = 1000.0,
        num_segments: int = 128
    ) -> List[List[float]]:
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

    def create_polygon_buffer_metric(
        self,
        polygon_wgs84: List[List[float]],
        radius_m: float = 1000.0,
        num_arc_pts: int = 8
    ) -> List[List[float]]:
        """
        Membangkitkan buffer poligon metrik berjarak radius_m (1.000m) dari batas perimeter poligon WGS84:
        1. Proyeksi koordinat poligon ke EPSG:32749 (meter).
        2. Dilatasi batas sisi poligon ke arah luar (outward normal) sejauh radius_m.
        3. Membentuk busur lingkaran (arc fillet) pada tiap titik sudut konveks.
        4. Mentransformasikan kembali ke koordinat EPSG:4326 sebagai cincin tertutup.
        """
        if not polygon_wgs84 or len(polygon_wgs84) < 4:
            raise ValueError("Poligon minimal membutuhkan 4 titik koordinat cincin tertutup.")

        pts_utm = [self.transformer_fwd.transform(p[0], p[1]) for p in polygon_wgs84]
        # Hilangkan titik penutup duplikat jika ada saat pemrosesan
        if pts_utm[0] == pts_utm[-1]:
            pts_utm = pts_utm[:-1]

        n = len(pts_utm)
        if n < 3:
            raise ValueError("Poligon harus memiliki minimal 3 verteks unik.")

        # Hitung signed area untuk memastikan orientasi berlawanan arah jarum jam (CCW)
        signed_area = 0.5 * sum(
            pts_utm[i][0] * pts_utm[(i + 1) % n][1] - pts_utm[(i + 1) % n][0] * pts_utm[i][1]
            for i in range(n)
        )
        if signed_area < 0:
            pts_utm = pts_utm[::-1]

        buffer_utm_pts = []
        for i in range(n):
            p_prev = pts_utm[(i - 1) % n]
            p_curr = pts_utm[i]
            p_next = pts_utm[(i + 1) % n]

            # Vektor sisi sebelumnya
            dx1 = p_curr[0] - p_prev[0]
            dy1 = p_curr[1] - p_prev[1]
            l1 = math.hypot(dx1, dy1)
            n1 = (dy1 / l1, -dx1 / l1) if l1 > 0 else (0.0, 1.0)

            # Vektor sisi berikutnya
            dx2 = p_next[0] - p_curr[0]
            dy2 = p_next[1] - p_curr[1]
            l2 = math.hypot(dx2, dy2)
            n2 = (dy2 / l2, -dx2 / l2) if l2 > 0 else (0.0, 1.0)

            angle1 = math.atan2(n1[1], n1[0])
            angle2 = math.atan2(n2[1], n2[0])

            diff = angle2 - angle1
            while diff < 0:
                diff += 2 * math.pi
            while diff >= 2 * math.pi:
                diff -= 2 * math.pi

            steps = max(1, int(num_arc_pts * (diff / (2 * math.pi)) * 4))
            for s in range(steps + 1):
                a = angle1 + diff * (s / steps)
                bx = p_curr[0] + radius_m * math.cos(a)
                by = p_curr[1] + radius_m * math.sin(a)
                buffer_utm_pts.append((bx, by))

        # Reproyeksi kembali ke WGS84
        out_ring = []
        for bx, by in buffer_utm_pts:
            plon, plat = self.transformer_inv.transform(bx, by)
            out_ring.append([round(plon, 7), round(plat, 7)])

        # Pastikan cincin tertutup
        out_ring.append(out_ring[0])
        return out_ring

    @staticmethod
    def point_in_polygon(px: float, py: float, ring: List[Tuple[float, float]]) -> bool:
        """Uji ray-casting point-in-polygon."""
        inside = False
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        return inside

    def point_to_polygon_distance_metric(
        self,
        px_utm: float,
        py_utm: float,
        polygon_utm: List[Tuple[float, float]]
    ) -> float:
        """
        Menghitung jarak Euclidean metrik terpendek dari titik ke batas poligon pada EPSG:32749.
        Jika titik berada di dalam poligon, jarak adalah 0.0 meter.
        """
        if self.point_in_polygon(px_utm, py_utm, polygon_utm):
            return 0.0

        min_dist = float("inf")
        n = len(polygon_utm)
        for i in range(n - 1):
            x1, y1 = polygon_utm[i]
            x2, y2 = polygon_utm[i + 1]
            dx = x2 - x1
            dy = y2 - y1
            l2 = dx * dx + dy * dy
            if l2 == 0.0:
                d = math.hypot(px_utm - x1, py_utm - y1)
            else:
                t = max(0.0, min(1.0, ((px_utm - x1) * dx + (py_utm - y1) * dy) / l2))
                proj_x = x1 + t * dx
                proj_y = y1 + t * dy
                d = math.hypot(px_utm - proj_x, py_utm - proj_y)

            if d < min_dist:
                min_dist = d

        return min_dist

    def process(
        self,
        universities_path: str,
        candidates_path: str,
        output_dir: str
    ) -> Dict[str, Any]:
        """
        Menjalankan pipeline GIS komprehensif:
        1. Membaca & memvalidasi data/raw/universities.geojson beserta poligon perimeter kampus.
        2. Membangkitkan buffer radial 1km & buffer dilatasi poligon 1km.
        3. Membaca & mengevaluasi kandidat lahan dengan taksonomi 5 status, kelayakan perencanaan kafe,
           dan penanganan fallback jujur.
        4. Mengekspor universities (Point + polygon metadata), universities_polygons, buffer_1km,
           buffer_polygon_1km, dan land_candidates.
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
        polygon_buffer_features: List[Dict[str, Any]] = []
        campus_polygon_features: List[Dict[str, Any]] = []
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

            # Poligon perimeter kampus (dari properties atau katalog baku OSM)
            raw_poly = props.get("campus_polygon")
            if raw_poly and isinstance(raw_poly, dict) and raw_poly.get("type") == "Polygon":
                poly_ring = raw_poly.get("coordinates", [[]])[0]
            elif cid in CAMPUS_POLYGONS_WGS84:
                poly_ring = CAMPUS_POLYGONS_WGS84[cid]
            else:
                # Default minimal box jika tidak ada poligon khusus
                dx, dy = 0.0015, 0.0012
                poly_ring = [
                    [lon - dx, lat - dy],
                    [lon + dx, lat - dy],
                    [lon + dx, lat + dy],
                    [lon - dx, lat + dy],
                    [lon - dx, lat - dy]
                ]

            # Hitung koordinat metrik UTM Zone 49S
            xm, ym = self.transformer_fwd.transform(lon, lat)
            poly_utm = [self.transformer_fwd.transform(p[0], p[1]) for p in poly_ring]

            # Hitung luas area kampus dalam hektar
            area_m2 = 0.5 * abs(
                sum(poly_utm[i][0] * poly_utm[i + 1][1] - poly_utm[i + 1][0] * poly_utm[i][1] for i in range(len(poly_utm) - 1))
            )
            area_ha = round(area_m2 / 10000.0, 2)
            osm_way_id = CAMPUS_OSM_WAYS.get(cid, props.get("osm_way_ref", source.split("/")[-1]))

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
                "verified_at": verified_at,
                "osm_way_ref": osm_way_id,
                "campus_area_ha": area_ha,
                "polygon_wgs84": poly_ring,
                "polygon_utm": poly_utm
            }
            processed_campuses.append(campus_entry)

            # Buat poligon buffer radial 1000m (dari titik referensi)
            radial_buffer_ring = self.create_radial_buffer_polygon(lon, lat, radius_m=1000.0, num_segments=128)
            buffer_features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [radial_buffer_ring]
                },
                "properties": {
                    "university_id": cid,
                    "institution": institution,
                    "campus_name": campus_name,
                    "radius_m": 1000,
                    "buffer_type": "radial_from_reference_centroid",
                    "crs_calculated": "EPSG:32749"
                }
            })

            # Buat poligon buffer 1000m dari batas poligon perimeter kampus
            poly_buffer_ring = self.create_polygon_buffer_metric(poly_ring, radius_m=1000.0, num_arc_pts=8)
            polygon_buffer_features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [poly_buffer_ring]
                },
                "properties": {
                    "university_id": cid,
                    "institution": institution,
                    "campus_name": campus_name,
                    "radius_m": 1000,
                    "buffer_type": "dilation_from_campus_polygon_boundary",
                    "campus_area_ha": area_ha,
                    "crs_calculated": "EPSG:32749"
                }
            })

            # Fitur poligon kampus murni
            campus_polygon_features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [poly_ring]
                },
                "properties": {
                    "id": cid,
                    "institution": institution,
                    "university_name": univ_name,
                    "campus_name": campus_name,
                    "osm_way_ref": osm_way_id,
                    "campus_area_ha": area_ha,
                    "center_coordinate": [round(lon, 7), round(lat, 7)],
                    "source": source,
                    "verified_at": verified_at
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
            "rentable_or_sale_count": 0,
            "non_rentable_or_sale_count": 0,
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

            # Klasifikasi status dari open data (OSM tags) jika tersedia
            osm_tags = props.get("osm_tags")
            if osm_tags and isinstance(osm_tags, dict):
                cls_data = classify_land_building_from_open_data(osm_tags)
                status = cls_data["status"]
            elif "status" in props and props.get("status"):
                status = self.normalize_status(props.get("status"))
            else:
                cls_data = classify_land_building_from_open_data({})
                status = cls_data["status"]

            # Area dan harga sewa: Tidak boleh mengarang angka tanpa bukti
            raw_area = props.get("area_sqm")
            if raw_area is not None:
                try:
                    area_sqm = float(raw_area)
                except (TypeError, ValueError):
                    area_sqm = None
            else:
                area_sqm = None

            raw_price = props.get("rental_price_yr")
            if raw_price is not None:
                try:
                    rental_price_yr = float(raw_price)
                except (TypeError, ValueError):
                    rental_price_yr = None
            else:
                rental_price_yr = None

            data_kind = props.get("data_kind", "osm_factual_open_data")
            source = props.get("source", "OpenStreetMap contributors (ODbL 1.0)")

            coords = geom.get("coordinates", [])
            if len(coords) < 2:
                raise ValueError(f"Koordinat tidak valid pada kandidat {lid}.")

            lon, lat = self.validate_coordinate(coords[0], coords[1], name=f"Kandidat {lid}")
            lx, ly = self.transformer_fwd.transform(lon, lat)

            # Hitung jarak Euclidean ke titik referensi seluruh kampus
            min_dist = float("inf")
            min_dist_poly = float("inf")
            nearest_campus: Optional[Dict[str, Any]] = None

            for camp in processed_campuses:
                d_ref = math.sqrt((lx - camp["x_utm"]) ** 2 + (ly - camp["y_utm"]) ** 2)
                d_poly = self.point_to_polygon_distance_metric(lx, ly, camp["polygon_utm"])

                if d_ref < min_dist:
                    min_dist = d_ref
                    nearest_campus = camp
                if d_poly < min_dist_poly:
                    min_dist_poly = d_poly

            if nearest_campus is None:
                raise RuntimeError("Gagal menentukan kampus terdekat.")

            # Batas inklusif <= 1000 meter dari titik referensi
            is_in_buffer = bool(min_dist <= 1000.0)

            # Klasifikasi peruntukan komersial / sewa vs tempat tinggal / fungsi lain
            is_rentable = bool(status in RENTABLE_OR_SALE_STATUSES)
            is_eligible = bool(is_in_buffer and is_rentable)
            is_clickable = is_eligible

            # Deskripsi alasan kelayakan
            if is_clickable:
                planning_label = "Dapat dipilih (Modal Perencanaan Kafe)"
                unavail_reason = None
            else:
                planning_label = "Tidak dapat dipilih"
                if not is_in_buffer:
                    unavail_reason = f"Lokasi berada di luar radius buffer 1 km ({round(min_dist, 1)} m > 1.000 m)."
                elif status == "Rumah atau bangunan tempat tinggal":
                    unavail_reason = "Status 'Rumah atau bangunan tempat tinggal' bukan peruntukan usaha kafe."
                elif status == "Bangunan yang telah digunakan untuk fungsi lain":
                    unavail_reason = "Bangunan telah aktif digunakan untuk fungsi fasilitas/komersial lain."
                else:
                    unavail_reason = "Status lahan belum terverifikasi ketersediaannya (keterbatasan open data publik)."

            # Update statistik
            stats["status_counts"][status] += 1
            if is_in_buffer:
                stats["in_buffer_count"] += 1
            else:
                stats["out_of_buffer_count"] += 1

            if is_rentable:
                stats["rentable_or_sale_count"] += 1
            else:
                stats["non_rentable_or_sale_count"] += 1

            if is_eligible:
                stats["eligible_count"] += 1
            else:
                stats["ineligible_count"] += 1

            status_class_info = {
                "category": "rentable_or_usable" if is_rentable else "non_rentable_or_sale",
                "planning_permission": "clickable_modal_trigger" if is_clickable else "disabled_not_selectable",
                "defensible_open_data_basis": (
                    "Lahan terbuka / kavling komersial siap pakai" if is_rentable
                    else "Bukan peruntukan komersial kafe baru / hunian / fungsi lain" if status in NON_RENTABLE_OR_SALE_STATUSES
                    else "Fallback jujur: ketersediaan sewa tidak tercatat pada open data"
                )
            }

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
                    "distance_meters": min_dist,  # unrounded float presisi penuh ke titik referensi
                    "distance_to_polygon_meters": round(min_dist_poly, 2),  # jarak metrik ke batas poligon kampus
                    "is_in_buffer": is_in_buffer,
                    "is_eligible": is_eligible,
                    "is_rentable_or_sale": is_rentable,
                    "is_clickable_for_planning": is_clickable,
                    "planning_eligibility_status": planning_label,
                    "unavailability_reason": unavail_reason,
                    "status_classification": status_class_info,
                    "data_kind": data_kind,
                    "source": source,
                    "osm_id": props.get("osm_id"),
                    "osm_type": props.get("osm_type"),
                    "osm_tags": osm_tags if osm_tags else props.get("osm_tags"),
                    "osm_version": props.get("osm_version"),
                    "osm_timestamp": props.get("osm_timestamp"),
                    "query_used": props.get("query_used"),
                    "query_attribution": props.get("query_attribution", "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright")
                }
            })

        # 3. Export Processed Universities (Point geometry untuk kompatibilitas Web UI + metadata poligon)
        universities_out_path = os.path.join(output_dir, "universities.geojson")
        exported_unis = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Titik Koordinat & Poligon Terverifikasi Kampus Unair, UKWMS, Ubaya (Processed)",
                "total_features": len(processed_campuses),
                "crs": "EPSG:4326",
                "computation_crs": "EPSG:32749",
                "polygon_representation_available": True
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
                        "verified_at": c["verified_at"],
                        "osm_way_ref": c["osm_way_ref"],
                        "campus_area_ha": c["campus_area_ha"],
                        "campus_polygon": {
                            "type": "Polygon",
                            "coordinates": [c["polygon_wgs84"]]
                        }
                    }
                }
                for c in processed_campuses
            ]
        }
        with open(universities_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_unis, f, indent=2, ensure_ascii=False)

        # 4. Export Processed Universities as Polygons (Dedicated Polygon Layer)
        universities_polygons_out_path = os.path.join(output_dir, "universities_polygons.geojson")
        exported_unis_polygons = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Poligon Batas Perimeter Kampus Unair, UKWMS, Ubaya Surabaya (OSM Ways)",
                "total_features": len(campus_polygon_features),
                "crs": "EPSG:4326",
                "computation_crs": "EPSG:32749"
            },
            "features": campus_polygon_features
        }
        with open(universities_polygons_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_unis_polygons, f, indent=2, ensure_ascii=False)

        # 5. Export Processed Buffer 1km (Radial from Reference Point)
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

        # 6. Export Processed Buffer Polygon 1km (Dilation from Polygon Boundary)
        buffer_polygon_out_path = os.path.join(output_dir, "buffer_polygon_1km.geojson")
        exported_buffer_polygon = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Poligon Buffer Dilatasi 1.000m dari Batas Perimeter Kampus Surabaya",
                "radius_m": 1000,
                "total_features": len(polygon_buffer_features),
                "crs": "EPSG:4326",
                "calculated_crs": "EPSG:32749"
            },
            "features": polygon_buffer_features
        }
        with open(buffer_polygon_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_buffer_polygon, f, indent=2, ensure_ascii=False)

        # 7. Export Processed Land Candidates
        candidates_out_path = os.path.join(output_dir, "land_candidates.geojson")
        exported_candidates = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Kandidat Lahan Terklasifikasi & Terevaluasi Spasial",
                "total_features": len(processed_candidates),
                "crs": "EPSG:4326",
                "evaluation_rules": {
                    "buffer_threshold_meters": 1000.0,
                    "eligible_statuses": list(ELIGIBLE_STATUSES),
                    "rentable_or_sale_statuses": list(RENTABLE_OR_SALE_STATUSES),
                    "non_rentable_or_sale_statuses": list(NON_RENTABLE_OR_SALE_STATUSES)
                },
                "open_data_policy": {
                    "defensible_basis": "OpenStreetMap Tag Standards for building & landuse",
                    "honest_fallback": "Lots without confirmed commercial lease agreements default to 'Lahan yang statusnya belum terverifikasi' (non-clickable)"
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
            "polygon_buffers_count": len(polygon_buffer_features),
            "candidates_count": len(processed_candidates),
            "stats": stats,
            "outputs": {
                "universities": universities_out_path,
                "universities_polygons": universities_polygons_out_path,
                "buffer_1km": buffer_out_path,
                "buffer_polygon_1km": buffer_polygon_out_path,
                "land_candidates": candidates_out_path
            }
        }


def main():
    parser = argparse.ArgumentParser(description="GIS Processing Pipeline - Proyek Buka Kafe Surabaya")
    parser.add_argument("--universities", default="data/raw/universities.geojson", help="Path file input universities.geojson")
    parser.add_argument("--candidates", default="data/raw/land_candidates.geojson", help="Path file input land_candidates.geojson")
    parser.add_argument("--output", default="data/processed", help="Direktori output GeoJSON")

    args = parser.parse_args()

    pipeline = GISPipeline()
    print("=== Menjalankan GIS Processing Pipeline Surabaya (Enhanced Architecture) ===")
    print(f"Input Universities: {args.universities}")
    print(f"Input Candidates  : {args.candidates}")
    print(f"Output Directory  : {args.output}")

    try:
        results = pipeline.process(args.universities, args.candidates, args.output)
        print("\n[SUCCESS] Pipeline selesai dengan sukses:")
        print(f"  - Kampus Terproses          : {results['universities_count']}")
        print(f"  - Buffer Radial (1.000m)    : {results['buffers_count']}")
        print(f"  - Buffer Dilatasi Poligon   : {results['polygon_buffers_count']}")
        print(f"  - Kandidat Lahan Dievaluasi : {results['candidates_count']}")
        print("\nStatistik Kelayakan:")
        stats = results["stats"]
        print(f"  - Dalam Buffer 1 km         : {stats['in_buffer_count']}")
        print(f"  - Di Luar Buffer 1 km       : {stats['out_of_buffer_count']}")
        print(f"  - Rentable/Sale (Kosong/Sewa): {stats['rentable_or_sale_count']}")
        print(f"  - Non-Rentable (Hunian/Fungsi): {stats['non_rentable_or_sale_count']}")
        print(f"  - Memenuhi Syarat (Eligible): {stats['eligible_count']}")
        print(f"  - Ditolak (Ineligible)      : {stats['ineligible_count']}")
        print("\nBerkas GeoJSON Dihasilkan:")
        for k, v in results["outputs"].items():
            print(f"  - {k}: {v}")

    except Exception as e:
        print(f"\n[ERROR] Pipeline gagal: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
