#!/usr/bin/env python3
"""
Rental Market Service - Proyek Buka Kafe (AFL 2 Computer Graphics)
Unified Evidence Engine for Scrutinized Real Public Rental Listings.

Quality Invariants & Remediation:
1. Strict Anti-Fabrication: Rejects invented coordinates, generic search directory URLs,
   and fake verification flags.
2. Optional / Null Geometry with Geocode Provenance: Point coordinates are strictly
   null unless accompanied by independent geocode provenance metadata.
3. Specific Source Listing URLs: Validates that URLs are canonical individual listing
   pages (Rumah123, Ray White, Brighton) and not generic search filters.
4. Strict Comparable Rule (>= 3): An area cluster is ONLY eligible for price-range
   summary if it contains >= 3 verified independent listings of the same comparable type.
   If < 3, status is 'INSUFFICIENT_DATA' with all price metrics null (zero fabrication).
5. Non-Destructive Preservation: Audits and guarantees that the existing 20 synthetic
   academic demo candidates are never altered or overwritten.
6. Honest Status on Unsupported Evidence: If research reports or raw listings are
   found unsupported/unverified, listing dataset outputs an empty FeatureCollection
   and all target clusters are explicitly marked INSUFFICIENT_DATA with null stats.
"""

import os
import sys
import re
import math
import json
from typing import Dict, List, Tuple, Any, Optional

try:
    import pyproj
except ImportError:
    print("Error: 'pyproj' library is required. Install via 'pip install pyproj'.", file=sys.stderr)
    sys.exit(1)

# Import konstanta terpercaya dari gis_pipeline
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from scripts.gis_pipeline import (
    SURABAYA_BBOX,
    BASELINE_RADIUS_METERS,
    SCENARIO_RADIUS_METERS,
    SUPPORTED_RADII_METERS,
    RADIUS_CONFIG,
    TEAM_SCORING_ASSUMPTIONS,
    calculate_transparent_feasibility_score,
)

MIN_COMPARABLE_LISTINGS = 3
ALLOWED_PORTALS = {"Rumah123", "Ray White", "Brighton"}
ALLOWED_PROPERTY_TYPES = {"ruko", "tempat usaha", "lahan komersial"}
REAL_DATA_KIND = "real_public_listing"

# Daftar 8 klaster kawasan kampus sasaran (Unair, UKWMS, Ubaya)
DEFAULT_TARGET_CLUSTERS = [
    "UKWMS Dinoyo (Dinoyo/Tegalsari)",
    "UKWMS Kalijudan (Kalijudan/Ploso)",
    "UKWMS Pakuwon City (San Antonio/Kejawan)",
    "Ubaya Ngagel (Ngagel Jaya Selatan)",
    "Ubaya Tenggilis (Tenggilis Mejoyo/Kalirungkut)",
    "Unair Kampus A (Moestopo/Gubeng)",
    "Unair Kampus B (Airlangga/Dharmawangsa)",
    "Unair Kampus C (Mulyorejo/Mulyosari)"
]

# Pola regex URL kanonikal spesifik properti individual (bukan direktori pencarian generik)
SPECIFIC_URL_PATTERNS = [
    re.compile(r"^https?://(?:www\.)?rumah123\.com/properti/[^/]+/.+"),
    re.compile(r"^https?://(?:www\.)?rumah123\.com/properti/surabaya/shr\d+/?"),
    re.compile(r"^https?://[a-z0-9\-]+\.raywhite\.co\.id/properti/\d+/.+"),
    re.compile(r"^https?://(?:www\.)?brighton\.co\.id/cari-properti/view/[^/]+/?")
]

# Pola URL generik yang DILARANG karena hanya berupa halaman pencarian agregat/direktori
GENERIC_URL_BLACKLIST = [
    re.compile(r"^https?://(?:www\.)?rumah123\.com/sewa/"),
    re.compile(r"^https?://(?:www\.)?lamudi\.co\.id/sewa/"),
    re.compile(r"^https?://(?:www\.)?99\.co/id/sewa/"),
    re.compile(r"^https?://(?:www\.)?pinhome\.id/sewa-properti/"),
    re.compile(r"^https?://(?:www\.)?olx\.co\.id/properti/")
]


class RentalMarketService:
    def __init__(self):
        self.transformer_fwd = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:32749", always_xy=True)
        self.transformer_inv = pyproj.Transformer.from_crs("EPSG:32749", "EPSG:4326", always_xy=True)

    def is_source_specific_url(self, url: str) -> bool:
        """
        Validasi URL spesifik:
        - Harus cocok dengan pola halaman listing individual.
        - Tidak boleh berupa halaman pencarian generik.
        """
        if not url or not isinstance(url, str):
            return False

        # Cek blacklist direktori pencarian generik
        for bad_pat in GENERIC_URL_BLACKLIST:
            if bad_pat.search(url):
                return False

        # Cek whitelist URL kanonikal spesifik
        for good_pat in SPECIFIC_URL_PATTERNS:
            if good_pat.search(url):
                return True

        return False

    def validate_listing(self, feat: Dict[str, Any], seen_ids: set) -> Dict[str, Any]:
        """
        Validasi independen listing riil tanpa mempercayai bendera 'is_verified' secara sirkular.
        - Memeriksa kelengkapan fakta terverifikasi (URL spesifik, harga positif, luas, tipe properti).
        - Menjamin geometri null kecuali disertai bukti provenance geokoding independen.
        """
        props = feat.get("properties", {})
        geom = feat.get("geometry")

        lid = props.get("listing_id")
        if not lid or not isinstance(lid, str) or not lid.strip():
            raise ValueError("Trust boundary violation: Listing wajib memiliki 'listing_id' non-kosong.")
        lid = lid.strip()
        if lid in seen_ids:
            raise ValueError(f"Trust boundary violation: Duplikasi listing_id ditemukan: '{lid}'.")
        seen_ids.add(lid)

        # 1. Validasi URL Spesifik (Anti-Generic URL)
        source_url = props.get("source_url", "").strip()
        if not self.is_source_specific_url(source_url):
            raise ValueError(
                f"Trust boundary violation: URL '{source_url}' pada {lid} bukan URL listing individual spesifik "
                "(terdeteksi URL direktori pencarian atau tidak memenuhi format kanonikal)."
            )

        # 2. Validasi Portal & Bukti Sumber
        portal = props.get("source_portal", "").strip()
        if portal not in ALLOWED_PORTALS:
            raise ValueError(f"Trust boundary violation: Portal '{portal}' pada {lid} tidak terdaftar dalam {ALLOWED_PORTALS}.")

        evidence_src = props.get("evidence_source", "").strip()
        if not evidence_src:
            raise ValueError(f"Trust boundary violation: Listing {lid} wajib mencantumkan 'evidence_source'.")

        # 3. Validasi Harga Sewa (Wajib positif finite number, bukan boolean)
        rental_price = props.get("rental_price_yr")
        if isinstance(rental_price, bool) or not isinstance(rental_price, (int, float)):
            raise ValueError(f"Trust boundary violation: rental_price_yr pada {lid} harus berupa angka numerik.")
        rental_price = float(rental_price)
        if not math.isfinite(rental_price) or rental_price <= 0.0:
            raise ValueError(f"Trust boundary violation: rental_price_yr pada {lid} harus positif dan berhingga.")

        # 4. Validasi Tipe Properti & Deskripsi Fakta
        prop_type = props.get("property_type", "").strip()
        if prop_type not in ALLOWED_PROPERTY_TYPES:
            raise ValueError(f"Trust boundary violation: property_type '{prop_type}' pada {lid} tidak valid.")

        title = props.get("title", "").strip()
        if not title:
            raise ValueError(f"Trust boundary violation: Listing {lid} wajib memiliki 'title'.")

        area_cluster = props.get("area_cluster", "").strip()
        if not area_cluster:
            raise ValueError(f"Trust boundary violation: Listing {lid} wajib memiliki 'area_cluster'.")

        address = props.get("address", "").strip()
        if not address:
            raise ValueError(f"Trust boundary violation: Listing {lid} wajib memiliki 'address'.")

        # Luas tanah & bangunan
        try:
            land_sqm = float(props.get("land_area_sqm", 0.0))
            bld_sqm = float(props.get("building_area_sqm", 0.0))
        except (TypeError, ValueError):
            raise ValueError(f"Trust boundary violation: Luas tanah/bangunan pada {lid} tidak valid.")

        effective_area = bld_sqm if bld_sqm > 0.0 else land_sqm
        price_sqm = (rental_price / effective_area) if effective_area > 0.0 else None

        # 5. Validasi Geometri & Geocode Provenance (Anti-Invented Coordinates)
        geocode_provenance = props.get("geocode_provenance")
        validated_coords: Optional[Tuple[float, float]] = None

        if geom is not None and isinstance(geom, dict):
            coords = geom.get("coordinates")
            if coords is not None:
                # Koordinat HANYA diizinkan jika memiliki geocode_provenance valid
                if not geocode_provenance or not isinstance(geocode_provenance, dict) or not geocode_provenance.get("source"):
                    # Tolak koordinat rekaan tanpa provenance -> paksa null
                    coords = None
                    geom = None
                else:
                    if len(coords) < 2:
                        raise ValueError(f"Trust boundary violation: Format koordinat pada {lid} harus [lon, lat].")
                    lon, lat = coords[0], coords[1]
                    if isinstance(lon, bool) or isinstance(lat, bool):
                        raise ValueError(f"Trust boundary violation: Koordinat {lid} tidak boleh boolean.")
                    try:
                        flon, flat = float(lon), float(lat)
                    except (TypeError, ValueError):
                        raise ValueError(f"Trust boundary violation: Koordinat {lid} harus bernilai float.")
                    if not (math.isfinite(flon) and math.isfinite(flat)):
                        raise ValueError(f"Trust boundary violation: Koordinat {lid} harus berhingga.")
                    if not (SURABAYA_BBOX["min_lon"] <= flon <= SURABAYA_BBOX["max_lon"]):
                        raise ValueError(f"Trust boundary violation: Longitude {flon} pada {lid} di luar Surabaya.")
                    if not (SURABAYA_BBOX["min_lat"] <= flat <= SURABAYA_BBOX["max_lat"]):
                        raise ValueError(f"Trust boundary violation: Latitude {flat} pada {lid} di luar Surabaya.")
                    validated_coords = (flon, flat)

        return {
            "listing_id": lid,
            "title": title,
            "area_cluster": area_cluster,
            "address": address,
            "subdistrict": props.get("subdistrict", "").strip(),
            "property_type": prop_type,
            "floors": props.get("floors", 1),
            "land_area_sqm": land_sqm if land_sqm > 0.0 else None,
            "building_area_sqm": bld_sqm if bld_sqm > 0.0 else None,
            "rental_price_yr": rental_price,
            "price_sqm_yr": price_sqm,
            "source_portal": portal,
            "source_url": source_url,
            "verification_date": props.get("verification_date", "").strip(),
            "evidence_source": evidence_src,
            "coordinates": validated_coords,
            "geocode_provenance": geocode_provenance if validated_coords else None,
            "has_geocoded_location": bool(validated_coords is not None)
        }

    @staticmethod
    def calculate_median(values: List[float]) -> float:
        """Menghitung nilai median presisi dari daftar angka float."""
        if not values:
            raise ValueError("Daftar angka kosong tidak memiliki median.")
        s = sorted(values)
        n = len(s)
        mid = n // 2
        if n % 2 == 1:
            return s[mid]
        return (s[mid - 1] + s[mid]) / 2.0

    def summarize_area_cluster(
        self,
        area_name: str,
        area_listings: List[Dict[str, Any]],
        target_property_type: str = "ruko"
    ) -> Dict[str, Any]:
        """
        Menyusun ringkasan rentang harga kawasan dengan aturan ketat:
        - Hanya memasukkan listing dengan tipe properti yang sebanding (comparable).
        - HANYA menghitung rentang jika jumlah listing pembanding >= 3.
        - Bila < 3, status INSUFFICIENT_DATA dan nilai metrik diisi null (tanpa fabrikasi).
        """
        comparables = [l for l in area_listings if l.get("property_type") == target_property_type]
        count = len(comparables)
        listing_ids = [l["listing_id"] for l in comparables if "listing_id" in l]

        if count < MIN_COMPARABLE_LISTINGS:
            return {
                "area_cluster": area_name,
                "property_type": target_property_type,
                "has_sufficient_listings": False,
                "status": "INSUFFICIENT_DATA",
                "count": count,
                "required_minimum": MIN_COMPARABLE_LISTINGS,
                "min_price_yr": None,
                "max_price_yr": None,
                "median_price_yr": None,
                "mean_price_yr": None,
                "min_price_sqm_yr": None,
                "max_price_sqm_yr": None,
                "median_price_sqm_yr": None,
                "comparable_listing_ids": listing_ids,
                "note": (
                    f"Kawasan '{area_name}' hanya memiliki {count} listing sebanding terverifikasi "
                    f"(di bawah batas minimum {MIN_COMPARABLE_LISTINGS}). "
                    "Rentang harga tidak disintesis untuk mencegah distorsi data (zero fabrication)."
                )
            }

        prices = [l["rental_price_yr"] for l in comparables]
        prices_sqm = [l["price_sqm_yr"] for l in comparables if l.get("price_sqm_yr") is not None]

        min_price = min(prices)
        max_price = max(prices)
        median_price = self.calculate_median(prices)
        mean_price = sum(prices) / float(count)

        min_sqm = min(prices_sqm) if prices_sqm else None
        max_sqm = max(prices_sqm) if prices_sqm else None
        median_sqm = self.calculate_median(prices_sqm) if prices_sqm else None

        return {
            "area_cluster": area_name,
            "property_type": target_property_type,
            "has_sufficient_listings": True,
            "status": "SUFFICIENT_DATA",
            "count": count,
            "required_minimum": MIN_COMPARABLE_LISTINGS,
            "min_price_yr": min_price,
            "max_price_yr": max_price,
            "median_price_yr": median_price,
            "mean_price_yr": mean_price,
            "min_price_sqm_yr": min_sqm,
            "max_price_sqm_yr": max_sqm,
            "median_price_sqm_yr": median_sqm,
            "comparable_listing_ids": listing_ids,
            "note": (
                f"Kawasan '{area_name}' memiliki {count} listing pembanding tipe '{target_property_type}' "
                f"terverifikasi (memenuhi ambang batas >= {MIN_COMPARABLE_LISTINGS})."
            )
        }

    def evaluate_against_universities(
        self,
        listings: List[Dict[str, Any]],
        universities_geojson_path: str
    ) -> List[Dict[str, Any]]:
        """
        Menghasilkan fitur GeoJSON dengan dukungan geometri opsional/null:
        - Jika koordinat null (karena tidak ada geocode provenance persil):
          geometry bernilai null, distance_meters bernilai null, is_in_buffer bernilai null.
        - Jika koordinat terverifikasi dengan provenance:
          menghitung jarak metrik EPSG:32749 ke kampus terdekat.
        """
        uni_nodes = []
        if universities_geojson_path and os.path.exists(universities_geojson_path):
            with open(universities_geojson_path, "r", encoding="utf-8") as f:
                uni_data = json.load(f)
            for feat in uni_data.get("features", []):
                cid = feat["properties"]["id"]
                cname = feat["properties"]["campus_name"]
                coords = feat["geometry"]["coordinates"]
                ux, uy = self.transformer_fwd.transform(coords[0], coords[1])
                uni_nodes.append({"id": cid, "campus_name": cname, "x": ux, "y": uy})

        geo_features = []
        for l in listings:
            coords = l["coordinates"]
            if coords is not None and uni_nodes:
                flon, flat = coords
                lx, ly = self.transformer_fwd.transform(flon, flat)
                min_dist = float("inf")
                nearest_uni = None
                for u in uni_nodes:
                    d = math.sqrt((lx - u["x"]) ** 2 + (ly - u["y"]) ** 2)
                    if d < min_dist:
                        min_dist = d
                        nearest_uni = u
                is_in_buf = bool(min_dist <= 1000.0)
                geometry = {
                    "type": "Point",
                    "coordinates": [round(flon, 7), round(flat, 7)]
                }
                dist_m = min_dist
                near_id = nearest_uni["id"] if nearest_uni else None
                near_name = nearest_uni["campus_name"] if nearest_uni else None
                spatial_note = "geocoded_with_provenance"
            else:
                geometry = None
                dist_m = None
                is_in_buf = None
                near_id = None
                near_name = None
                spatial_note = "geometry_null_no_invented_coords"

            geo_features.append({
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "listing_id": l["listing_id"],
                    "title": l["title"],
                    "area_cluster": l["area_cluster"],
                    "address": l["address"],
                    "subdistrict": l.get("subdistrict", ""),
                    "property_type": l.get("property_type", "ruko"),
                    "floors": l.get("floors", 1),
                    "land_area_sqm": l.get("land_area_sqm"),
                    "building_area_sqm": l.get("building_area_sqm"),
                    "rental_price_yr": l.get("rental_price_yr"),
                    "price_sqm_yr": l.get("price_sqm_yr"),
                    "source_portal": l.get("source_portal"),
                    "source_url": l.get("source_url"),
                    "verification_date": l.get("verification_date", ""),
                    "evidence_source": l.get("evidence_source", ""),
                    "nearest_university_id": near_id,
                    "nearest_university_name": near_name,
                    "distance_meters": dist_m,
                    "is_in_buffer": is_in_buf,
                    "spatial_evaluation": spatial_note,
                    "geocode_provenance": l.get("geocode_provenance"),
                    "data_kind": REAL_DATA_KIND
                }
            })

        return geo_features

    def process_rental_market(
        self,
        raw_listings_path: Optional[str] = None,
        universities_path: str = "data/processed/universities.geojson",
        output_dir: str = "data/processed"
    ) -> Dict[str, Any]:
        """
        Menjalankan pipeline audit dan agregasi pasar sewa properti riil:
        1. Membaca & memvalidasi data raw jika ada; jika tidak ada atau unsupported, listing diset kosong [].
        2. Mengelompokkan per kawasan target dan menerapkan aturan >= 3 listing sebanding.
        3. Menghasilkan ringkasan harga kawasan berstatus transparan (INSUFFICIENT_DATA jika < 3).
        4. Mengekspor GeoJSON listing riil (FeatureCollection kosong jika tidak ada listing lolos verifikasi).
        """
        os.makedirs(output_dir, exist_ok=True)

        validated_listings: List[Dict[str, Any]] = []
        seen_ids = set()

        if raw_listings_path and os.path.exists(raw_listings_path):
            with open(raw_listings_path, "r", encoding="utf-8") as f:
                raw_data = json.load(f)
            features = raw_data.get("features", [])
            for feat in features:
                val = self.validate_listing(feat, seen_ids)
                validated_listings.append(val)

        # Kelompokkan per kawasan (area_cluster)
        by_area: Dict[str, List[Dict[str, Any]]] = {}
        # Inisialisasi seluruh kawasan target default agar tidak ada klaster yang hilang
        for cluster in DEFAULT_TARGET_CLUSTERS:
            by_area[cluster] = []

        for l in validated_listings:
            area = l["area_cluster"]
            if area not in by_area:
                by_area[area] = []
            by_area[area].append(l)

        # Susun ringkasan kawasan
        summaries: List[Dict[str, Any]] = []
        sufficient_areas = []
        insufficient_areas = []

        for area_name, items in sorted(by_area.items()):
            summary = self.summarize_area_cluster(area_name, items, target_property_type="ruko")
            summaries.append(summary)
            if summary["has_sufficient_listings"]:
                sufficient_areas.append(area_name)
            else:
                insufficient_areas.append(area_name)

        # Evaluasi spasial terhadap kampus
        geo_features = self.evaluate_against_universities(validated_listings, universities_path)

        # Ekspor Ringkasan Rentang Harga Kawasan
        summary_out_path = os.path.join(output_dir, "area_rental_price_summary.json")
        summary_payload = {
            "metadata": {
                "title": "Ringkasan Rentang Harga Sewa Tempat Usaha Berdasarkan Bukti Listing Riil Terverifikasi",
                "contract_version": "2.0.0",
                "retrieved_at": "2026-11-01",
                "evidence_source": "None (unsupported/unverified research claims rejected)",
                "min_comparable_threshold": MIN_COMPARABLE_LISTINGS,
                "total_areas_evaluated": len(summaries),
                "sufficient_areas_count": len(sufficient_areas),
                "insufficient_areas_count": len(insufficient_areas),
                "policy_statement": (
                    "Hanya kawasan dengan >= 3 listing pembanding terverifikasi sumber independen dengan tipe properti yang sebanding "
                    "yang menghasilkan metrik harga. Seluruh kawasan tanpa bukti cukup ditandai INSUFFICIENT_DATA dengan statistik null."
                )
            },
            "sufficient_areas": sufficient_areas,
            "insufficient_areas": insufficient_areas,
            "area_summaries": summaries
        }

        with open(summary_out_path, "w", encoding="utf-8") as f:
            json.dump(summary_payload, f, indent=2, ensure_ascii=False, allow_nan=False)

        # Ekspor Listing Riil Terproses (GeoJSON) - Menghasilkan FeatureCollection kosong jika tidak ada listing valid
        listings_out_path = os.path.join(output_dir, "real_rental_listings.geojson")
        listings_geojson = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Listing Sewa Properti Riil Publik (Status: Kosong / Unsupported Research Report)",
                "total_features": len(geo_features),
                "crs": "EPSG:4326",
                "contract_version": "2.0.0",
                "status": "EMPTY_UNVERIFIED" if len(geo_features) == 0 else "POPULATED",
                "evidence_source": "None (research claims unsupported)",
                "unlocated_features_count": sum(1 for gf in geo_features if gf["geometry"] is None),
                "geocoded_features_count": sum(1 for gf in geo_features if gf["geometry"] is not None),
                "description": (
                    "Tidak ada listing properti riil yang lolos verifikasi independen (laporan riset dinyatakan unsupported). "
                    "Dataset listing dikosongkan guna mencegah pengiriman data buatan / fabrikasi."
                )
            },
            "features": geo_features
        }

        with open(listings_out_path, "w", encoding="utf-8") as f:
            json.dump(listings_geojson, f, indent=2, ensure_ascii=False, allow_nan=False)

        return {
            "total_listings": len(validated_listings),
            "total_areas": len(summaries),
            "sufficient_areas": sufficient_areas,
            "insufficient_areas": insufficient_areas,
            "outputs": {
                "area_summary": summary_out_path,
                "real_listings": listings_out_path
            }
        }


def audit_synthetic_candidates(fixture_candidates_path: str = "data/fixtures/synthetic_land_candidates.geojson", raw_fixture_path: str = "data/raw/synthetic_land_candidates.geojson") -> Dict[str, Any]:
    """
    Memverifikasi integritas 20 kandidat lahan akademis demo yang diisolasi:
    - Menjamin tepat 20 fitur tersimpan aman di berkas fixture terisolasi.
    - Menjamin seluruhnya bertanda data_kind: 'synthetic_academic_demo'.
    - Menjamin tidak tercampur dengan layer interaktif faktual OSM.
    """
    for p in [fixture_candidates_path, raw_fixture_path]:
        if not os.path.exists(p):
            raise FileNotFoundError(f"File fixture kandidat sintetis tidak ditemukan: {p}")

    with open(fixture_candidates_path, "r", encoding="utf-8") as f:
        fixture_cands = json.load(f)
    with open(raw_fixture_path, "r", encoding="utf-8") as f:
        raw_cands = json.load(f)

    fixture_feats = fixture_cands.get("features", [])
    raw_feats = raw_cands.get("features", [])

    if len(fixture_feats) != 20:
        raise ValueError(f"Audit gagal: Fixture candidates harus tepat 20, ditemukan {len(fixture_feats)}.")
    if len(raw_feats) != 20:
        raise ValueError(f"Audit gagal: Raw fixture candidates harus tepat 20, ditemukan {len(raw_feats)}.")

    fixture_ids = [feat["properties"]["id"] for feat in fixture_feats]
    raw_ids = [feat["properties"]["id"] for feat in raw_feats]

    if fixture_ids != raw_ids:
        raise ValueError("Audit gagal: ID pada fixture candidates dan raw fixture candidates tidak sinkron.")

    for feat in fixture_feats:
        props = feat["properties"]
        if props.get("data_kind") != "synthetic_academic_demo":
            raise ValueError(f"Audit gagal: Fitur {props.get('id')} bukan synthetic_academic_demo.")

    return {
        "status": "PASSED",
        "total_synthetic_candidates": 20,
        "fixture_path": fixture_candidates_path,
        "verified_ids": fixture_ids
    }


def audit_factual_interactive_layer(proc_candidates_path: str = "data/processed/land_candidates.geojson") -> Dict[str, Any]:
    """
    Memverifikasi lapisan interaktif faktual (OpenStreetMap):
    1. Eliminasi Fitur Sintetis: Menjamin TIDAK ADA fitur sintetis lama (CAND-*) di layer interaktif aktif.
    2. Integritas Faktual: Seluruh fitur berasal dari open data riil (OSM node/way) dengan ID, tag, dan atribusi query.
    3. Klasifikasi Tanpa Fabrikasi: Bangunan hunian/fungsi lain diklasifikasikan non-clickable.
    4. Guard Perlindungan: Tidak ada klaim kosong/sewa tanpa bukti (is_rentable_or_sale: False, is_clickable_for_planning: False).
    """
    if not os.path.exists(proc_candidates_path):
        raise FileNotFoundError(f"File layer interaktif faktual tidak ditemukan: {proc_candidates_path}")

    with open(proc_candidates_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    feats = data.get("features", [])
    if not feats:
        raise ValueError("Audit gagal: Layer interaktif faktual tidak boleh kosong.")

    synthetic_count = 0
    factual_osm_count = 0

    for feat in feats:
        props = feat.get("properties", {})
        fid = str(props.get("id", ""))
        data_kind = str(props.get("data_kind", ""))

        # 1. Pastikan tidak ada fitur sintetis lama yang lolos
        if fid.startswith("CAND-") or data_kind == "synthetic_academic_demo":
            synthetic_count += 1

        # 2. Pastikan fitur faktual memiliki OSM ID dan atribusi query
        if fid.startswith("OSM-") or "osm_id" in props:
            factual_osm_count += 1
            if not props.get("query_attribution"):
                raise ValueError(f"Audit gagal: Fitur {fid} tidak memuat query_attribution.")
            if not props.get("osm_tags"):
                raise ValueError(f"Audit gagal: Fitur {fid} tidak memuat osm_tags.")

        # 3. Penegakan Anti-Klaim Sewa Palsu: Tanpa bukti sewa riil, status tidak boleh disewakan/kosong
        status = props.get("status")
        if status in {"Lahan kosong", "Lahan yang tersedia untuk disewakan"}:
            raise ValueError(f"Audit gagal: Fitur {fid} mengklaim status sewa/kosong tanpa bukti.")

        # 4. Pastikan flag kelayakan dan guard bernilai False
        if props.get("is_rentable_or_sale") is not False:
            raise ValueError(f"Audit gagal: Fitur {fid} is_rentable_or_sale harus False.")
        if props.get("is_clickable_for_planning") is not False:
            raise ValueError(f"Audit gagal: Fitur {fid} is_clickable_for_planning harus False.")

    if synthetic_count > 0:
        raise ValueError(f"Audit gagal: Ditemukan {synthetic_count} fitur sintetis dalam layer interaktif aktif.")

    return {
        "status": "PASSED",
        "total_factual_features": len(feats),
        "factual_osm_count": factual_osm_count,
        "synthetic_in_active_layer": 0,
        "empty_or_rentable_claims": 0
    }


def calculate_range_midpoint_estimate(
    min_price: Optional[float],
    max_price: Optional[float],
    source_label: str = "documented_range"
) -> Dict[str, Any]:
    """
    Menghitung estimasi titik tengah (midpoint) dari rentang harga sewa terdokumentasi [min, max].
    Sesuai mandat anti-fabrikasi:
    - Nilai midpoint WAJIB dilabeli secara eksplisit sebagai estimasi matematis ('is_estimate': True).
    - Nilai midpoint TIDAK BOLEH diklaim sebagai harga transaksi atau harga penawaran riil ('is_transaction_price': False).
    - Rentang sumber asli ('source_range': [min, max]) wajib disertakan utuh sebagai transparansi.
    - Jika salah satu batas bernilai None, midpoint bernilai None.
    """
    if min_price is None or max_price is None:
        return {
            "midpoint": None,
            "is_estimate": False,
            "source_range": None,
            "is_transaction_price": False,
            "label": "Rentang harga tidak tersedia (null)"
        }

    fmin = float(min_price)
    fmax = float(max_price)
    if fmin > fmax:
        raise ValueError(f"Batas bawah rentang ({fmin}) lebih besar dari batas atas ({fmax}).")

    midpoint = (fmin + fmax) / 2.0
    return {
        "midpoint": round(midpoint, 2),
        "is_estimate": True,
        "source_range": [fmin, fmax],
        "is_transaction_price": False,
        "label": f"Estimasi titik tengah rentang Rp {fmin:,.0f} - Rp {fmax:,.0f} ({source_label})"
    }


def audit_production_dataset(
    proc_cands_path: str = "data/processed/land_candidates.geojson",
    fixtures_path: str = "data/fixtures/synthetic_land_candidates.geojson"
) -> Dict[str, Any]:
    """
    Audit penarikan data sintetis dari jalur produksi dan preservasi fixture:
    1. Memverifikasi data/processed/land_candidates.geojson TIDAK memuat kandidat demo/sintetis.
    2. Memverifikasi seluruh kandidat produksi berakar pada data faktual riil (OSM).
    3. Memverifikasi zero klaim sewa/lahan kosong tanpa bukti (is_rentable_or_sale=False).
    4. Memverifikasi harga sewa dan luas tidak dikarang (null).
    5. Memverifikasi bahwa 20 kandidat sintetis lama tetap dipreservasi di file fixtures.
    """
    if not os.path.exists(proc_cands_path):
        raise FileNotFoundError(f"Berkas produksi {proc_cands_path} tidak ditemukan.")
    if not os.path.exists(fixtures_path):
        raise FileNotFoundError(f"Berkas fixture {fixtures_path} tidak ditemukan.")

    # 1. Audit berkas produksi
    with open(proc_cands_path, "r", encoding="utf-8") as f:
        proc_data = json.load(f)

    proc_feats = proc_data.get("features", [])
    synthetic_in_prod = 0
    fake_rentable_claims = 0
    unbacked_prices = 0

    for feat in proc_feats:
        props = feat.get("properties", {})
        fid = str(props.get("id", ""))
        dkind = str(props.get("data_kind", ""))

        if fid.startswith("CAND-") or "synthetic" in dkind or "demo" in dkind:
            synthetic_in_prod += 1

        if props.get("is_rentable_or_sale") is True or props.get("is_clickable_for_planning") is True:
            has_evidence = bool(props.get("evidence_url") or props.get("evidence_photo") or props.get("price_source_url"))
            if not has_evidence:
                fake_rentable_claims += 1

        if props.get("rental_price_yr") is not None and not props.get("price_source_url"):
            unbacked_prices += 1

    if synthetic_in_prod > 0:
        raise AssertionError(f"Ditemukan {synthetic_in_prod} kandidat sintetis/demo di berkas produksi {proc_cands_path}!")

    if fake_rentable_claims > 0:
        raise AssertionError(f"Ditemukan {fake_rentable_claims} klaim sewa/tersedia tanpa bukti di {proc_cands_path}!")

    if unbacked_prices > 0:
        raise AssertionError(f"Ditemukan {unbacked_prices} harga sewa tanpa sumber bukti di {proc_cands_path}!")

    # 2. Audit preservasi fixture
    with open(fixtures_path, "r", encoding="utf-8") as f:
        fix_data = json.load(f)

    fix_feats = fix_data.get("features", [])
    if len(fix_feats) != 20:
        raise AssertionError(f"Fixture {fixtures_path} harus tetap memuat tepat 20 kandidat demo (ditemukan: {len(fix_feats)}).")

    return {
        "status": "PASSED",
        "production_features_count": len(proc_feats),
        "synthetic_in_production": 0,
        "fake_rentable_claims": 0,
        "unbacked_prices": 0,
        "fixtures_preserved_count": len(fix_feats)
    }



def main():
    service = RentalMarketService()
    raw_path = "data/raw/real_rental_listings.json" if os.path.exists("data/raw/real_rental_listings.json") else None
    unis_path = "data/processed/universities.geojson"
    out_dir = "data/processed"

    print("=== Menjalankan Rental Market Service (Remediasi Bebas Fabrikasi) ===")
    audit_res = audit_synthetic_candidates("data/fixtures/synthetic_land_candidates.geojson", "data/raw/synthetic_land_candidates.geojson")
    print(f"[AUDIT] 20 kandidat sintetis lama terisolasi aman: {audit_res['status']}.")

    audit_factual = audit_factual_interactive_layer("data/processed/factual_osm_candidates.geojson")
    print(f"[AUDIT] Layer interaktif faktual OSM terverifikasi: {audit_factual['status']} ({audit_factual['total_factual_features']} fitur, 0 sintetis).")

    res = service.process_rental_market(raw_path, unis_path, out_dir)
    print(f"\n[SUCCESS] Pemrosesan pasar sewa properti riil selesai:")
    print(f"  - Total Listing Riil Publik: {res['total_listings']}")
    print(f"  - Total Kawasan Dievaluasi : {res['total_areas']}")
    print(f"  - Kawasan CUKUP Listing (>=3): {len(res['sufficient_areas'])} -> {res['sufficient_areas']}")
    print(f"  - Kawasan TIDAK CUKUP Listing (<3): {len(res['insufficient_areas'])} -> {res['insufficient_areas']}")
    print("\nFile Output:")
    for k, v in res["outputs"].items():
        print(f"  - {k}: {v}")


if __name__ == "__main__":
    main()
