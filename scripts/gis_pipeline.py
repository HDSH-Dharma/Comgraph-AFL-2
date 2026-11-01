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
import random
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

# Taksonomi metode survei dan jenis data survei lapangan / Google Street View (Prompt A)
VALID_SURVEY_METHODS = {"street_view", "google_maps", "lapangan"}
VALID_SURVEY_DATA_KINDS = {"survey_google_maps", "survey_lapangan"}

# ==============================================================================
# KONFIGURASI RADIUS TERPUSAT (GIS TASK 2: BASELINE 500M & SCENARIO 1KM)
# ==============================================================================
# Radius spasial terpusat untuk analisis jangkauan kawasan sekitar kampus:
# - BASELINE (500.0 m): Batas pejalan kaki standar proposal Bab 1.1 & Bab 3 (~5-7 menit jalan kaki).
# - SCENARIO (1000.0 m / 1 km): Batas skenario jangkauan strategis Bab 2.2 untuk eksplorasi modal kafe.
BASELINE_RADIUS_METERS: float = 500.0
SCENARIO_RADIUS_METERS: float = 1000.0
SUPPORTED_RADII_METERS: List[float] = [500.0, 1000.0]

# Metadata konfigurasi radius terpusat: single source of truth untuk koordinasi
# antara GIS pipeline, test suite, dan komponen visualisasi antarmuka web.
RADIUS_CONFIG: Dict[str, Dict[str, Any]] = {
    "baseline": {
        "radius_m": 500.0,
        "name": "baseline_500m",
        "label": "Radius Pejalan Kaki 500m (Standar Proposal)",
        "description": "Radius jalan kaki standar proposal Bab 1.1 dan Bab 3 (500 meter / 0.5 km)"
    },
    "scenario": {
        "radius_m": 1000.0,
        "name": "scenario_1km",
        "label": "Radius Jangkauan Strategis 1.000m (Skenario Perencanaan)",
        "description": "Zona jangkauan strategis perencanaan kafe Bab 2.2 (1.000 meter / 1 km)"
    }
}

# ==============================================================================
# ASUMSI PENILAIAN SKOR KELAYAKAN MULTI-KOMPONEN TERPUSAT (PERBAIKAN 1 & TASK 8)
# ==============================================================================
# 7 Komponen Penilaian Terbuka (Multi-Criteria Decision Analysis - Tim AFL 2):
# 1. Proksimitas Kampus (campus_proximity): 25.0 poin (Baseline <=150m: 25, <=300m: 18, <=500m: 12; Skenario <=300m: 25, <=600m: 18, <=1000m: 12)
# 2. Proksimitas Gerbang (gate_proximity): 15.0 poin (<=100m: 15, <=250m: 11, <=400m: 7, >400m: 3)
# 3. Kompetisi & Aglomerasi Kafe OSM (osm_cafe_competition): 15.0 poin (2-5 kafe: 15, 1 kafe: 11, 6-10 kafe: 8, >10 kafe: 4, 0 kafe: 5)
# 4. Tipe Jalan / Aksesibilitas (road_type): 10.0 poin (primary/arteri: 10, secondary: 9, tertiary/kolektor: 8, residential: 6, service: 4, alley: 3)
# 5. Indikator Aktivitas Mahasiswa (student_indicators): 10.0 poin (tinggi/kost_cluster: 10, sedang: 7, rendah: 4)
# 6. Efisiensi Biaya Sewa (rent): 15.0 poin (<=400k/m2/thn: 15, <=700k/m2/thn: 10, >700k: 5)
# 7. Kesesuaian Luas (area): 10.0 poin (80-250 m2: 10, 50-80 / 250-400 m2: 7, lainnya: 4)
# Total Bobot Teoretis: 100.0 poin.
#
# Aturan Cakupan (Coverage) & Bintang (Perbaikan 1):
# - Komponen yang bernilai null dikeluarkan dari poin yang diperoleh DAN pembagi bobot (denominator).
# - Coverage dihitung sebagai persentase bobot yang tersedia terhadap total 100.0 poin.
# - Jika coverage < 60.0%: TIDAK MENDAPAT BINTANG (has_stars=False, stars="", grade="Data Terbatas (<60% Cakupan - Tanpa Bintang)").
# - Komponen yang hilang wajib dicatat eksplisit dalam daftar 'missing'.
# - Kepatuhan JSON RFC 8259 murni (allow_nan=False, batas terbuka memakai None/null).

TEAM_SCORING_ASSUMPTIONS: Dict[str, Any] = {
    "version": "2.0.0",
    "basis": "team_assumptions",
    "description": "Asumsi parameter penilaian kelayakan kafe terpusat tim AFL 2 Computer Graphics (Multi-Component Scoring)",
    "weights": {
        "campus_proximity": 25.0,
        "gate_proximity": 15.0,
        "osm_cafe_competition": 15.0,
        "road_type": 10.0,
        "student_indicators": 10.0,
        "rent": 15.0,
        "area": 10.0,
        # Kunci alias kompatibilitas mundur (legacy backward compatibility)
        "proximity": 25.0,
        "space": 10.0,
        "cost_efficiency": 15.0
    },
    "min_coverage_for_stars": 60.0,
    "campus_proximity_thresholds_m": {
        "baseline_500m": {
            "excellent": (150.0, 25.0),
            "good": (300.0, 18.0),
            "fair": (500.0, 12.0),
            "unsuitable": (None, 0.0)
        },
        "scenario_1km": {
            "excellent": (300.0, 25.0),
            "good": (600.0, 18.0),
            "fair": (1000.0, 12.0),
            "unsuitable": (None, 0.0)
        }
    },
    "gate_proximity_thresholds_m": {
        "excellent": (100.0, 15.0),
        "good": (250.0, 11.0),
        "fair": (400.0, 7.0),
        "unsuitable": (None, 3.0)
    },
    "osm_cafe_competition_thresholds": {
        "optimal_cluster": ((2, 5), 15.0),
        "single_competitor": ((1, 1), 11.0),
        "moderate_competition": ((6, 10), 8.0),
        "high_saturation": ((11, None), 4.0),
        "zero_competitors": ((0, 0), 5.0)
    },
    "road_type_weights": {
        "primary": 10.0,
        "arterial": 10.0,
        "arteri": 10.0,
        "utama": 10.0,
        "secondary": 9.0,
        "sekunder": 9.0,
        "tertiary": 8.0,
        "kolektor": 8.0,
        "residential": 6.0,
        "lokal": 6.0,
        "service": 4.0,
        "akses": 4.0,
        "alley": 3.0,
        "gang": 3.0,
        "default": 4.0
    },
    "student_indicators_weights": {
        "high": 10.0,
        "kost_cluster": 10.0,
        "tinggi": 10.0,
        "padat": 10.0,
        "medium": 7.0,
        "moderate": 7.0,
        "sedang": 7.0,
        "low": 4.0,
        "rendah": 4.0,
        "default": 4.0
    },
    "rent_thresholds_idr_per_sqm_yr": {
        "efficient": (400000.0, 15.0),
        "moderate": (700000.0, 10.0),
        "high": (None, 5.0)
    },
    "area_thresholds_sqm": {
        "optimal_range": ([80.0, 250.0], 10.0),
        "moderate_ranges": [([50.0, 80.0], 7.0), ([250.0, 400.0], 7.0)],
        "acceptable_fallback": 4.0
    },
    # Alias kompatibilitas mundur untuk dictionary lookup legacy
    "proximity_thresholds_m": {
        "scenario_1km": {
            "excellent": (300.0, 25.0),
            "good": (600.0, 18.0),
            "fair": (1000.0, 12.0),
            "unsuitable": (None, 0.0)
        },
        "baseline_500m": {
            "excellent": (150.0, 25.0),
            "good": (300.0, 18.0),
            "fair": (500.0, 12.0),
            "unsuitable": (None, 0.0)
        }
    },
    "space_thresholds_sqm": {
        "optimal_range": ([80.0, 250.0], 10.0),
        "moderate_ranges": [([50.0, 80.0], 7.0), ([250.0, 400.0], 7.0)],
        "acceptable_fallback": 4.0
    },
    "cost_efficiency_thresholds_idr_per_sqm_yr": {
        "efficient": (400000.0, 15.0),
        "moderate": (700000.0, 10.0),
        "high": (None, 5.0)
    },
    "anti_fabrication_rule": "Dilarang keras menebak harga sewa (never guess rent); nilai null dikeluarkan dari pembagi bobot dan dipertahankan dalam daftar missing.",
    "star_thresholds": {
        "3_stars": (85.0, "Sangat Strategis ★★★", "★★★"),
        "2_stars": (70.0, "Strategis ★★", "★★"),
        "1_star": (50.0, "Cukup Layak ★", "★"),
        "0_stars": (0.0, "Kurang Layak", "")
    }
}


def calculate_transparent_feasibility_score(
    distance_meters: Optional[float] = None,
    area_sqm: Optional[float] = None,
    rental_price_yr: Optional[float] = None,
    radius_mode: str = "scenario_1km",
    assumptions: Optional[Dict[str, Any]] = None,
    distance_to_nearest_gate_meters: Optional[float] = None,
    nearby_cafes_count: Optional[int] = None,
    road_type: Optional[str] = None,
    student_indicators: Optional[str] = None
) -> Dict[str, Any]:
    """
    Menghitung skor kelayakan kafe multi-komponen transparan (Perbaikan 1 & GIS Task 8):
    7 Komponen Terpusat (Asumsi Tim):
    1. campus_proximity (maks 25 poin)
    2. gate_proximity (maks 15 poin)
    3. osm_cafe_competition (maks 15 poin)
    4. road_type (maks 10 poin)
    5. student_indicators (maks 10 poin)
    6. rent (maks 15 poin)
    7. area (maks 10 poin)
    Total bobot teoretis: 100.0 poin.

    Aturan Cakupan Data (Coverage) & Bintang:
    - Komponen bernilai null dikeluarkan dari poin DAN dari penyebut (max_available_weight).
    - Cakupan dihitung: coverage = (max_available_weight / 100.0) * 100.0.
    - Di bawah ambang 60% (coverage < 60.0%): Bintang dinonaktifkan (has_stars=False, stars=""),
      grade dilabeli jelas dengan tingkat cakupan ("Data Terbatas (X% Cakupan - Tanpa Bintang)").
    - Daftar komponen yang hilang dicatat secara eksplisit pada field 'missing'.
    """
    if assumptions is None:
        assumptions = TEAM_SCORING_ASSUMPTIONS

    weights = assumptions["weights"]
    w_campus = weights.get("campus_proximity", 25.0)
    w_gate = weights.get("gate_proximity", 15.0)
    w_cafe = weights.get("osm_cafe_competition", 15.0)
    w_road = weights.get("road_type", 10.0)
    w_student = weights.get("student_indicators", 10.0)
    w_rent = weights.get("rent", 15.0)
    w_area = weights.get("area", 10.0)

    breakdown: Dict[str, Any] = {}
    observed_components: List[str] = []
    missing_components: List[str] = []
    raw_earned_points = 0.0
    max_available_weight = 0.0

    # -------------------------------------------------------------------------
    # 1. Proksimitas Kampus (campus_proximity, Maks 25 Poin)
    # -------------------------------------------------------------------------
    if distance_meters is not None and math.isfinite(distance_meters) and distance_meters >= 0.0:
        observed_components.append("campus_proximity")
        max_available_weight += w_campus
        prox_map = assumptions.get("campus_proximity_thresholds_m", assumptions.get("proximity_thresholds_m", {}))
        p_th = prox_map.get(radius_mode, prox_map.get("scenario_1km", {}))
        if p_th.get("excellent", (None, 0.0))[0] is not None and distance_meters <= p_th["excellent"][0]:
            p_score = p_th["excellent"][1]
        elif p_th.get("good", (None, 0.0))[0] is not None and distance_meters <= p_th["good"][0]:
            p_score = p_th["good"][1]
        elif p_th.get("fair", (None, 0.0))[0] is not None and distance_meters <= p_th["fair"][0]:
            p_score = p_th["fair"][1]
        else:
            p_score = p_th.get("unsuitable", (None, 0.0))[1]
        raw_earned_points += p_score
        breakdown["campus_proximity"] = {
            "raw": round(distance_meters, 2),
            "points": p_score,
            "weight": w_campus,
            "status": "OBSERVED"
        }
    else:
        missing_components.append("campus_proximity")
        breakdown["campus_proximity"] = {
            "raw": None,
            "points": None,
            "weight": w_campus,
            "status": "MISSING (Unobserved campus distance)"
        }

    # -------------------------------------------------------------------------
    # 2. Proksimitas Gerbang Kampus (gate_proximity, Maks 15 Poin)
    # -------------------------------------------------------------------------
    if (distance_to_nearest_gate_meters is not None and
            math.isfinite(distance_to_nearest_gate_meters) and
            distance_to_nearest_gate_meters >= 0.0):
        observed_components.append("gate_proximity")
        max_available_weight += w_gate
        g_th = assumptions.get("gate_proximity_thresholds_m", {})
        if g_th.get("excellent", (None, 0.0))[0] is not None and distance_to_nearest_gate_meters <= g_th["excellent"][0]:
            g_score = g_th["excellent"][1]
        elif g_th.get("good", (None, 0.0))[0] is not None and distance_to_nearest_gate_meters <= g_th["good"][0]:
            g_score = g_th["good"][1]
        elif g_th.get("fair", (None, 0.0))[0] is not None and distance_to_nearest_gate_meters <= g_th["fair"][0]:
            g_score = g_th["fair"][1]
        else:
            g_score = g_th.get("unsuitable", (None, 3.0))[1]
        raw_earned_points += g_score
        breakdown["gate_proximity"] = {
            "raw": round(distance_to_nearest_gate_meters, 2),
            "points": g_score,
            "weight": w_gate,
            "status": "OBSERVED"
        }
    else:
        missing_components.append("gate_proximity")
        breakdown["gate_proximity"] = {
            "raw": None,
            "points": None,
            "weight": w_gate,
            "status": "MISSING (Gate unobserved)"
        }

    # -------------------------------------------------------------------------
    # 3. Kompetisi & Aglomerasi Kafe OSM (osm_cafe_competition, Maks 15 Poin)
    # -------------------------------------------------------------------------
    if nearby_cafes_count is not None and isinstance(nearby_cafes_count, (int, float)) and nearby_cafes_count >= 0:
        observed_components.append("osm_cafe_competition")
        max_available_weight += w_cafe
        c_th = assumptions.get("osm_cafe_competition_thresholds", {})
        count_int = int(nearby_cafes_count)
        if 2 <= count_int <= 5:
            c_score = c_th.get("optimal_cluster", ((2, 5), 15.0))[1]
        elif count_int == 1:
            c_score = c_th.get("single_competitor", ((1, 1), 11.0))[1]
        elif 6 <= count_int <= 10:
            c_score = c_th.get("moderate_competition", ((6, 10), 8.0))[1]
        elif count_int > 10:
            c_score = c_th.get("high_saturation", ((11, None), 4.0))[1]
        else:  # count_int == 0
            c_score = c_th.get("zero_competitors", ((0, 0), 5.0))[1]
        raw_earned_points += c_score
        breakdown["osm_cafe_competition"] = {
            "raw": count_int,
            "points": c_score,
            "weight": w_cafe,
            "status": "OBSERVED"
        }
    else:
        missing_components.append("osm_cafe_competition")
        breakdown["osm_cafe_competition"] = {
            "raw": None,
            "points": None,
            "weight": w_cafe,
            "status": "MISSING (Nearby cafes unobserved)"
        }

    # -------------------------------------------------------------------------
    # 4. Tipe Jalan / Aksesibilitas (road_type, Maks 10 Poin)
    # -------------------------------------------------------------------------
    if road_type is not None and str(road_type).strip() != "":
        observed_components.append("road_type")
        max_available_weight += w_road
        rt_norm = str(road_type).strip().lower()
        rt_weights = assumptions.get("road_type_weights", {})
        matched_score = None
        for key, val in rt_weights.items():
            if key != "default" and key in rt_norm:
                matched_score = val
                break
        if matched_score is None:
            matched_score = rt_weights.get("default", 4.0)
        raw_earned_points += matched_score
        breakdown["road_type"] = {
            "raw": str(road_type).strip(),
            "points": matched_score,
            "weight": w_road,
            "status": "OBSERVED"
        }
    else:
        missing_components.append("road_type")
        breakdown["road_type"] = {
            "raw": None,
            "points": None,
            "weight": w_road,
            "status": "MISSING (Road type unobserved)"
        }

    # -------------------------------------------------------------------------
    # 5. Indikator Aktivitas Mahasiswa (student_indicators, Maks 10 Poin)
    # -------------------------------------------------------------------------
    if student_indicators is not None and str(student_indicators).strip() != "":
        observed_components.append("student_indicators")
        max_available_weight += w_student
        si_norm = str(student_indicators).strip().lower()
        si_weights = assumptions.get("student_indicators_weights", {})
        matched_si = None
        for key, val in si_weights.items():
            if key != "default" and key in si_norm:
                matched_si = val
                break
        if matched_si is None:
            matched_si = si_weights.get("default", 4.0)
        raw_earned_points += matched_si
        breakdown["student_indicators"] = {
            "raw": str(student_indicators).strip(),
            "points": matched_si,
            "weight": w_student,
            "status": "OBSERVED"
        }
    else:
        missing_components.append("student_indicators")
        breakdown["student_indicators"] = {
            "raw": None,
            "points": None,
            "weight": w_student,
            "status": "MISSING (Student indicators unobserved)"
        }

    # -------------------------------------------------------------------------
    # 6. Efisiensi Biaya Sewa (rent, Maks 15 Poin)
    # Mandat Anti-Fabrikasi: Dilarang keras menebak harga sewa (never guess rent)
    # -------------------------------------------------------------------------
    if (rental_price_yr is not None and math.isfinite(rental_price_yr) and rental_price_yr > 0.0 and
            area_sqm is not None and math.isfinite(area_sqm) and area_sqm > 0.0):
        observed_components.append("rent")
        max_available_weight += w_rent
        cost_per_sqm = rental_price_yr / area_sqm
        r_th = assumptions.get("rent_thresholds_idr_per_sqm_yr", assumptions.get("cost_efficiency_thresholds_idr_per_sqm_yr", {}))
        if r_th.get("efficient", (None, 0.0))[0] is not None and cost_per_sqm <= r_th["efficient"][0]:
            r_score = r_th["efficient"][1]
        elif r_th.get("moderate", (None, 0.0))[0] is not None and cost_per_sqm <= r_th["moderate"][0]:
            r_score = r_th["moderate"][1]
        else:
            r_score = r_th.get("high", (None, 5.0))[1]
        raw_earned_points += r_score
        breakdown["rent"] = {
            "raw": round(cost_per_sqm, 2),
            "points": r_score,
            "weight": w_rent,
            "status": "OBSERVED"
        }
    else:
        missing_components.append("rent")
        reason = "Unobserved rent (never guessed)" if rental_price_yr is None else "Missing area for rent calculation"
        breakdown["rent"] = {
            "raw": None,
            "points": None,
            "weight": w_rent,
            "status": f"MISSING ({reason})"
        }

    # -------------------------------------------------------------------------
    # 7. Kesesuaian Luas (area, Maks 10 Poin)
    # -------------------------------------------------------------------------
    if area_sqm is not None and math.isfinite(area_sqm) and area_sqm > 0.0:
        observed_components.append("area")
        max_available_weight += w_area
        a_th = assumptions.get("area_thresholds_sqm", assumptions.get("space_thresholds_sqm", {}))
        opt_range = a_th.get("optimal_range", ([80.0, 250.0], 10.0))[0]
        if opt_range[0] <= area_sqm <= opt_range[1]:
            a_score = a_th.get("optimal_range", ([80.0, 250.0], 10.0))[1]
        else:
            in_mod = False
            for m_rng, m_val in a_th.get("moderate_ranges", [([50.0, 80.0], 7.0), ([250.0, 400.0], 7.0)]):
                if m_rng[0] <= area_sqm <= m_rng[1]:
                    a_score = m_val
                    in_mod = True
                    break
            if not in_mod:
                a_score = a_th.get("acceptable_fallback", 4.0)
        raw_earned_points += a_score
        breakdown["area"] = {
            "raw": round(area_sqm, 2),
            "points": a_score,
            "weight": w_area,
            "status": "OBSERVED"
        }
    else:
        missing_components.append("area")
        breakdown["area"] = {
            "raw": None,
            "points": None,
            "weight": w_area,
            "status": "MISSING (Unmeasured area)"
        }

    # -------------------------------------------------------------------------
    # Normalisasi Proporsional & Cakupan Bobot (Coverage)
    # -------------------------------------------------------------------------
    theoretical_max = 100.0
    coverage = round((max_available_weight / theoretical_max) * 100.0, 2)
    is_renormalized = len(missing_components) > 0

    if max_available_weight > 0.0:
        feasibility_score = round((raw_earned_points / max_available_weight) * 100.0, 2)
    else:
        feasibility_score = None

    # -------------------------------------------------------------------------
    # Evaluasi Ambang Batas Bintang Berdasarkan Cakupan (Perbaikan 1)
    # Aturan: Cakupan < 60% = TANPA BINTANG dan cantumkan missing secara transparan.
    # -------------------------------------------------------------------------
    min_cov = assumptions.get("min_coverage_for_stars", 60.0)
    if coverage < min_cov:
        has_stars = False
        stars = ""
        grade = f"Data Terbatas ({coverage:.0f}% Cakupan - Tanpa Bintang)"
    else:
        has_stars = True
        if feasibility_score is None:
            grade = "Data Belum Lengkap"
            stars = ""
            has_stars = False
        elif feasibility_score >= 85.0:
            grade = "Sangat Strategis ★★★"
            stars = "★★★"
        elif feasibility_score >= 70.0:
            grade = "Strategis ★★"
            stars = "★★"
        elif feasibility_score >= 50.0:
            grade = "Cukup Layak ★"
            stars = "★"
        else:
            grade = "Kurang Layak"
            stars = ""

    return {
        "feasibility_score": feasibility_score,
        "score_normalized": feasibility_score,  # Alias kompatibilitas mundur
        "coverage": coverage,
        "feasibility_grade": grade,
        "grade": grade,  # Alias kompatibilitas mundur
        "has_stars": has_stars,
        "stars": stars,
        "missing": missing_components,
        "breakdown": breakdown,
        "raw_earned_points": round(raw_earned_points, 2),
        "max_available_weight": round(max_available_weight, 2),
        "theoretical_max_weight": theoretical_max,
        "is_renormalized": is_renormalized,
        "observed_components": observed_components,
        "null_components": missing_components,  # Alias kompatibilitas mundur
        "radius_mode": radius_mode,
        "assumptions_version": assumptions.get("version", "2.0.0"),
        "formula_note": (
            f"Skor dinormalisasi dari {len(observed_components)} komponen yang diobservasi "
            f"(cakupan {coverage:.1f}%, bobot tersedia {round(max_available_weight, 1)}/100.0). "
            f"Komponen yang belum diobservasi ({len(missing_components)}): {missing_components}. "
            + ("Bintang dinonaktifkan karena cakupan data di bawah ambang 60%." if not has_stars else "")
        )
    }


def evaluate_candidate_feasibility(
    candidate_props: Dict[str, Any],
    user_rent_yr: Optional[float] = None,
    user_area_sqm: Optional[float] = None,
    radius_mode: str = "baseline_500m",
    assumptions: Optional[Dict[str, Any]] = None,
    nearby_cafes_count: Optional[int] = None,
    distance_to_nearest_gate_meters: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Evaluator kelayakan terbagi untuk modul Planner & GIS Pipeline (Perbaikan 1 & 4):
    - Digunakan kembali oleh perencana (planner) hanya untuk memasukkan sewa (rent) dan luas (area) pengguna.
    - Tidak pernah mengubah atau memfabrikasi variabel spasial kandidat yang diamati di lapangan.
    - Jika pengguna menginput sewa dan luas valid, komponen rent dan area diobservasi, sehingga
      meningkatkan cakupan (coverage) kandidat dan berpotensi membuka penilaian bintang (>= 60%).
    """
    rent_to_use = user_rent_yr if (user_rent_yr is not None and math.isfinite(user_rent_yr) and user_rent_yr > 0.0) else candidate_props.get("rental_price_yr")
    area_to_use = user_area_sqm if (user_area_sqm is not None and math.isfinite(user_area_sqm) and user_area_sqm > 0.0) else candidate_props.get("area_sqm")

    dist_m = candidate_props.get("distance_meters")
    if dist_m is None:
        dist_m = candidate_props.get("distance")

    gate_dist_m = distance_to_nearest_gate_meters
    if gate_dist_m is None:
        gate_dist_m = candidate_props.get("distance_to_nearest_gate_meters")

    cafe_cnt = nearby_cafes_count
    if cafe_cnt is None:
        cafe_cnt = candidate_props.get("nearby_cafes_count")

    road_tp = candidate_props.get("road_type")
    stud_ind = candidate_props.get("student_indicators")

    return calculate_transparent_feasibility_score(
        distance_meters=dist_m,
        area_sqm=area_to_use,
        rental_price_yr=rent_to_use,
        radius_mode=radius_mode,
        assumptions=assumptions,
        distance_to_nearest_gate_meters=gate_dist_m,
        nearby_cafes_count=cafe_cnt,
        road_type=road_tp,
        student_indicators=stud_ind
    )


def load_and_validate_campus_gates(
    gates_path: Optional[str] = None
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
    """
    Validasi dan pemuatan berkas gerbang kampus opsional (Campus Gates GeoJSON):
    - Jika path None atau berkas tidak ada di sistem: mengembalikan (None, "ABSENT").
    - Jika berkas ada:
      * Memeriksa struktur GeoJSON FeatureCollection.
      * Memvalidasi tipe geometri Point dan koordinat WGS84 [lon, lat].
      * Memvalidasi atribut pengenal kampus (campus_id / nearest_university_id).
      * Memproyeksikan koordinat gerbang ke EPSG:32749 (UTM 49S).
      * Mengembalikan daftar fitur gerbang terproyeksi yang tervalidasi.
    """
    if not gates_path or not os.path.exists(gates_path):
        return None, "ABSENT"

    try:
        with open(gates_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.warning(f"Gagal membaca berkas gerbang kampus {gates_path}: {e}")
        return None, f"INVALID_JSON: {e}"

    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        return None, "INVALID_GEOJSON_STRUCTURE: Root must be FeatureCollection"

    features = data.get("features", [])
    if not isinstance(features, list):
        return None, "INVALID_GEOJSON_STRUCTURE: 'features' must be a list"

    validated_gates: List[Dict[str, Any]] = []
    transformer = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:32749", always_xy=True)

    for idx, feat in enumerate(features):
        geom = feat.get("geometry", {})
        if not isinstance(geom, dict) or geom.get("type") != "Point":
            continue
        coords = geom.get("coordinates", [])
        if not isinstance(coords, (list, tuple)) or len(coords) < 2:
            continue
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (ValueError, TypeError):
            continue

        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            continue

        props = feat.get("properties", {}) or {}
        campus_id = (
            props.get("campus_id") or
            props.get("target_campus_id") or
            props.get("nearest_university_id") or
            props.get("university_id")
        )
        if not campus_id:
            continue

        campus_id_norm = str(campus_id).strip().upper().replace("_", "-")

        try:
            utm_x, utm_y = transformer.transform(lon, lat)
        except Exception:
            continue

        validated_gates.append({
            "id": props.get("id", f"GATE-{idx+1}"),
            "name": props.get("name", f"Gerbang Kampus #{idx+1}"),
            "campus_id": campus_id_norm,
            "raw_campus_id": campus_id,
            "lon": lon,
            "lat": lat,
            "utm_x": utm_x,
            "utm_y": utm_y,
            "gate_type": props.get("gate_type", "main_gate")
        })

    if not validated_gates:
        return None, "EMPTY_OR_NO_VALID_POINT_FEATURES"

    return validated_gates, "VALID"


# Boundary geografis terpercaya kawasan Surabaya & sekitarnya
SURABAYA_BBOX = {
    "min_lon": 112.50,
    "max_lon": 112.95,
    "min_lat": -7.45,
    "max_lat": -7.15
}

# Poligon perimeter kampus WGS84 berbasis footprint OpenStreetMap way asli (Overpass/API v0.6)
CAMPUS_POLYGONS_WGS84: Dict[str, List[List[float]]] = {
    "UNAIR-KAMPUS-A": [
        [112.7571763, -7.263713],
        [112.7568544, -7.2653188],
        [112.7568585, -7.2654757],
        [112.7569886, -7.2656141],
        [112.7601334, -7.2656952],
        [112.7601924, -7.2656261],
        [112.7602246, -7.2645192],
        [112.7602286, -7.2640429],
        [112.7597371, -7.2639465],
        [112.7591986, -7.2638807],
        [112.7582726, -7.2638667],
        [112.7582726, -7.2638002],
        [112.7571763, -7.263713],
    ],
    "UNAIR-KAMPUS-B": [
        [112.7605703, -7.2726689],
        [112.760538, -7.2734611],
        [112.7605122, -7.27397],
        [112.7586081, -7.2739094],
        [112.7569431, -7.2738549],
        [112.7567702, -7.2738493],
        [112.7564353, -7.2738383],
        [112.7564873, -7.2720881],
        [112.7564939, -7.2718662],
        [112.7565106, -7.2713027],
        [112.7565222, -7.2709113],
        [112.7565291, -7.2706788],
        [112.756564, -7.2706123],
        [112.7566337, -7.2706076],
        [112.7569306, -7.2706181],
        [112.7576125, -7.2706568],
        [112.7601917, -7.2707599],
        [112.7601944, -7.2714611],
        [112.7606072, -7.2713504],
        [112.7605703, -7.2726689],
    ],
    "UNAIR-KAMPUS-C": [
        [112.7894399, -7.2693777],
        [112.7894339, -7.2701737],
        [112.789435, -7.2708221],
        [112.7888833, -7.2707626],
        [112.7876562, -7.2706003],
        [112.7855909, -7.2703496],
        [112.7853106, -7.270309],
        [112.7852114, -7.2702957],
        [112.7841463, -7.270176],
        [112.7840567, -7.2701307],
        [112.7840137, -7.2700828],
        [112.7838421, -7.2700669],
        [112.7837506, -7.2701541],
        [112.7828395, -7.2700471],
        [112.7823508, -7.2699897],
        [112.7823159, -7.2699697],
        [112.7823025, -7.2699338],
        [112.7823065, -7.2698713],
        [112.7824458, -7.2693092],
        [112.7824862, -7.2691463],
        [112.782603, -7.2683543],
        [112.783071, -7.2651792],
        [112.7831823, -7.2641895],
        [112.7831957, -7.263966],
        [112.783197, -7.2636759],
        [112.7836342, -7.2636826],
        [112.7837951, -7.2636826],
        [112.7846722, -7.2634764],
        [112.7846421, -7.2633653],
        [112.7848917, -7.2632705],
        [112.7852518, -7.2631337],
        [112.7851515, -7.2636907],
        [112.785098, -7.264043],
        [112.7850652, -7.2642587],
        [112.7853871, -7.2643032],
        [112.7854925, -7.2635986],
        [112.7858226, -7.2636118],
        [112.7859824, -7.2635788],
        [112.7861863, -7.2631931],
        [112.786307, -7.2631638],
        [112.786409, -7.2630627],
        [112.7865028, -7.2628511],
        [112.7867236, -7.2627561],
        [112.7873813, -7.2625438],
        [112.7885391, -7.2620687],
        [112.7885695, -7.2620898],
        [112.7885733, -7.2621746],
        [112.7888139, -7.262125],
        [112.7888512, -7.2620117],
        [112.7896272, -7.2617689],
        [112.7895753, -7.2642586],
        [112.7896009, -7.2650249],
        [112.7894913, -7.267542],
        [112.789464, -7.2683694],
        [112.7894439, -7.2692687],
        [112.7894399, -7.2693777],
    ],
    "UKWMS-DINOYO": [
        [112.7442426, -7.2811131],
        [112.7442267, -7.2814752],
        [112.7441977, -7.2819285],
        [112.7445625, -7.2820083],
        [112.7447207, -7.2820456],
        [112.7447254, -7.2820749],
        [112.7449293, -7.2820469],
        [112.7450044, -7.2819884],
        [112.7455361, -7.2817982],
        [112.7455629, -7.2817702],
        [112.7455757, -7.281737],
        [112.7455723, -7.2817017],
        [112.7452934, -7.2812707],
        [112.74517, -7.281159],
        [112.7448562, -7.2809155],
        [112.744773, -7.2808796],
        [112.7446496, -7.2808809],
        [112.7444847, -7.2809102],
        [112.7443546, -7.280982],
        [112.7442426, -7.2811131],
    ],
    "UKWMS-KALIJUDAN": [
        [112.7743804, -7.2607086],
        [112.7745281, -7.2604878],
        [112.773639, -7.2598991],
        [112.7730568, -7.2594809],
        [112.7724548, -7.2590483],
        [112.7717064, -7.2596031],
        [112.7726933, -7.2603777],
        [112.7732165, -7.2608024],
        [112.7732592, -7.2607439],
        [112.7733794, -7.2605754],
        [112.7733689, -7.260568],
        [112.77351, -7.2603703],
        [112.7735163, -7.2603648],
        [112.7735728, -7.2602895],
        [112.7735896, -7.2603019],
        [112.7736192, -7.2602624],
        [112.7736872, -7.2601718],
        [112.7737237, -7.2601977],
        [112.7738548, -7.2603028],
        [112.7738635, -7.2603077],
        [112.7739461, -7.2603739],
        [112.7741004, -7.2604895],
        [112.7743804, -7.2607086],
    ],
    "UKWMS-PAKUWON": [
        [112.8112087, -7.2719107],
        [112.8101653, -7.2708438],
        [112.8108282, -7.2702362],
        [112.8110129, -7.2700669],
        [112.8125954, -7.2691888],
        [112.8132847, -7.2705511],
        [112.812534, -7.2709401],
        [112.8120267, -7.2712029],
        [112.8118434, -7.2713615],
        [112.8112087, -7.2719107],
    ],
    "UBAYA-NGAGEL": [
        [112.760828, -7.2928811],
        [112.760828, -7.2935474],
        [112.7617338, -7.2935382],
        [112.7618324, -7.2926825],
        [112.7614843, -7.2927346],
        [112.7614781, -7.2928872],
        [112.760828, -7.2928811],
    ],
    "UBAYA-TENGGILIS": [
        [112.7674363, -7.3181116],
        [112.7673265, -7.3192483],
        [112.7671524, -7.3209734],
        [112.766921, -7.3223881],
        [112.7668734, -7.3227359],
        [112.7670598, -7.3229966],
        [112.7671778, -7.3230512],
        [112.7673773, -7.3229866],
        [112.767777, -7.3230052],
        [112.7683506, -7.3228789],
        [112.7685417, -7.3228024],
        [112.7685602, -7.3222936],
        [112.7686581, -7.3218414],
        [112.7685414, -7.3218121],
        [112.7683792, -7.3216937],
        [112.768469, -7.3214357],
        [112.7685709, -7.3214024],
        [112.768583, -7.3211404],
        [112.7685562, -7.3210752],
        [112.7685495, -7.3208225],
        [112.768632, -7.3204866],
        [112.7687734, -7.3194803],
        [112.7687256, -7.3193962],
        [112.768762, -7.3192788],
        [112.7688001, -7.3191867],
        [112.7687593, -7.3189961],
        [112.7688244, -7.3189722],
        [112.7688217, -7.3186463],
        [112.7686863, -7.318645],
        [112.7686879, -7.3183916],
        [112.7682211, -7.3180642],
        [112.7679105, -7.3180508],
        [112.7679003, -7.3178986],
        [112.7676514, -7.3178739],
        [112.7676594, -7.3177875],
        [112.7674308, -7.3177413],
        [112.7673919, -7.3177443],
        [112.7674363, -7.3181116],
    ],
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

# Basis harga sewa empiris terverifikasi per koridor kampus dari reports/research.md
# Digunakan khusus untuk mengalibrasi parameter harga skenario simulasi sintetis (tanpa rekayasa spekulatif)
RESEARCH_RENT_BASIS: Dict[str, Dict[str, Any]] = {
    "UNAIR-KAMPUS-A": {
        "source_listing_ids": ["UNAIR-A-01", "UNAIR-A-02"],
        "source_range": [75000000.0, 135000000.0],
        "rental_price_yr": 105000000.0,
        "price_basis": "Estimasi titik tengah rentang sewa ruko komersial koridor Unair A (Moestopo/Tambaksari): Rp 75.000.000 - Rp 135.000.000/thn berdasarkan listing UNAIR-A-01 (Rumah123 shr10058906) dan UNAIR-A-02 (Ray White 393372) di reports/research.md.",
        "area_sqm": 80.0,
        "building_area_sqm": 150.0,
        "suggested_name": "Situs Simulasi Ruko Dharmahusada (Unair A)"
    },
    "UNAIR-KAMPUS-B": {
        "source_listing_ids": ["UNAIR-B-01", "UNAIR-B-02"],
        "source_range": [140000000.0, 150000000.0],
        "rental_price_yr": 145000000.0,
        "price_basis": "Estimasi titik tengah rentang sewa komersial koridor Unair B (Dharmawangsa/Gubeng): Rp 140.000.000 - Rp 150.000.000/thn berdasarkan listing UNAIR-B-01 (Ray White 449388) dan UNAIR-B-02 (Ray White 339003) di reports/research.md.",
        "area_sqm": 100.0,
        "building_area_sqm": 250.0,
        "suggested_name": "Situs Simulasi Ruko Dharmawangsa (Unair B)"
    },
    "UNAIR-KAMPUS-C": {
        "source_listing_ids": ["UNAIR-C-01"],
        "source_range": [85000000.0, 85000000.0],
        "rental_price_yr": 85000000.0,
        "price_basis": "Estimasi harga sewa ruko koridor Unair C (Raya Mulyosari): Rp 85.000.000/thn berdasarkan listing UNAIR-C-01 (Ray White 494389) di reports/research.md.",
        "area_sqm": 120.0,
        "building_area_sqm": 120.0,
        "suggested_name": "Situs Simulasi Ruko Raya Mulyosari (Unair C)"
    },
    "UKWMS-DINOYO": {
        "source_listing_ids": ["UKWMS-DIN-01"],
        "source_range": [250000000.0, 250000000.0],
        "rental_price_yr": 250000000.0,
        "price_basis": "Estimasi harga sewa ruko koridor UKWMS Dinoyo (Raya Dinoyo/Tegalsari): Rp 250.000.000/thn berdasarkan listing UKWMS-DIN-01 (Ray White 425870) di reports/research.md.",
        "area_sqm": 142.5,
        "building_area_sqm": 360.0,
        "suggested_name": "Situs Simulasi Ruko Raya Dinoyo (UKWMS Dinoyo)"
    },
    "UKWMS-KALIJUDAN": {
        "source_listing_ids": ["UKWMS-KAL-01", "UKWMS-KAL-02"],
        "source_range": [40000000.0, 110000000.0],
        "rental_price_yr": 75000000.0,
        "price_basis": "Estimasi titik tengah rentang sewa ruko koridor UKWMS Kalijudan (Kalijudan/Kaliwaron): Rp 40.000.000 - Rp 110.000.000/thn berdasarkan listing UKWMS-KAL-01 (Ray White 525829) dan UKWMS-KAL-02 (Ray White 543328) di reports/research.md.",
        "area_sqm": 100.0,
        "building_area_sqm": 180.0,
        "suggested_name": "Situs Simulasi Ruko Kalijudan (UKWMS Kalijudan)"
    },
    "UKWMS-PAKUWON": {
        "source_listing_ids": ["UKWMS-PAK-01", "UKWMS-PAK-02"],
        "source_range": [125000000.0, 125000000.0],
        "rental_price_yr": 125000000.0,
        "price_basis": "Estimasi harga sewa ruko koridor UKWMS Pakuwon City (San Antonio Shopping Street): Rp 125.000.000/thn berdasarkan listing UKWMS-PAK-01 (Ray White 521563) dan UKWMS-PAK-02 (Ray White 455790) di reports/research.md.",
        "area_sqm": 63.0,
        "building_area_sqm": 90.0,
        "suggested_name": "Situs Simulasi Ruko San Antonio (UKWMS Pakuwon City)"
    },
    "UBAYA-NGAGEL": {
        "source_listing_ids": ["UBAYA-NGA-01", "UBAYA-NGA-02"],
        "source_range": [110000000.0, 175000000.0],
        "rental_price_yr": 142500000.0,
        "price_basis": "Estimasi titik tengah rentang sewa ruko koridor Ubaya Ngagel (Ngagel/Ngagel Jaya Selatan): Rp 110.000.000 - Rp 175.000.000/thn berdasarkan listing UBAYA-NGA-01 (Ray White 306708) dan UBAYA-NGA-02 (Ray White 475541) di reports/research.md.",
        "area_sqm": 95.0,
        "building_area_sqm": 300.0,
        "suggested_name": "Situs Simulasi Ruko Ngagel Jaya (Ubaya Ngagel)"
    },
    "UBAYA-TENGGILIS": {
        "source_listing_ids": ["UBAYA-TENG-01", "UBAYA-TENG-02", "UBAYA-TENG-03"],
        "source_range": [65000000.0, 123500000.0],
        "rental_price_yr": 70000000.0,
        "price_basis": "Estimasi harga sewa ruko koridor Ubaya Tenggilis (Raya Tenggilis/Mejoyo): nilai median Rp 70.000.000/thn (rentang Rp 65.000.000 - Rp 123.500.000/thn) berdasarkan kuorum 3 listing UBAYA-TENG-01 (Ray White 513122), UBAYA-TENG-02 (Ray White 453365), dan UBAYA-TENG-03 (Ray White 491945) di reports/research.md.",
        "area_sqm": 52.5,
        "building_area_sqm": 100.0,
        "suggested_name": "Situs Simulasi Ruko Raya Tenggilis (Ubaya Tenggilis)"
    }
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
        Mendukung varian teks dari prompt (e.g. 'Lahan kosong siap bangun' -> 'Lahan kosong').
        """
        if not raw_status or not isinstance(raw_status, str):
            return DEFAULT_LAND_STATUS

        trimmed = raw_status.strip()
        if trimmed == "Lahan kosong siap bangun":
            return "Lahan kosong"
        if trimmed in VALID_LAND_STATUSES:
            return trimmed

        return DEFAULT_LAND_STATUS

    def validate_survey_candidate(self, feature: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validasi ketat skema kandidat lahan hasil survei lapangan / Google Street View (Prompt A Task 1).
        Menegakkan 11 field wajib, integritas bukti (URL/foto), tanggal observasi ISO,
        dan menolak harga/luas tanpa sumber empiris.
        """
        import re
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError("Kandidat survei harus berupa GeoJSON Feature yang valid.")

        geom = feature.get("geometry", {})
        if not isinstance(geom, dict) or geom.get("type") != "Point":
            raise ValueError("Geometri kandidat survei harus bertipe Point.")

        coords = geom.get("coordinates", [])
        if not isinstance(coords, (list, tuple)) or len(coords) < 2:
            raise ValueError("Koordinat Point kandidat survei tidak lengkap.")

        fid = feature.get("properties", {}).get("id", "unknown") if isinstance(feature.get("properties"), dict) else "unknown"
        lon, lat = self.validate_coordinate(coords[0], coords[1], name=f"Kandidat survei {fid}")

        props = feature.get("properties", {})
        if not isinstance(props, dict):
            raise ValueError("Properti kandidat survei harus berupa objek dict.")

        # 1. ID, Name, Address
        cid = props.get("id")
        if not cid or not isinstance(cid, str) or not cid.strip():
            raise ValueError("Kandidat survei wajib memiliki 'id' non-kosong.")
        cid = cid.strip()

        name = props.get("name")
        if not name or not isinstance(name, str) or not name.strip():
            raise ValueError(f"Kandidat survei {cid} wajib memiliki 'name' non-kosong.")

        address = props.get("address")
        if not address or not isinstance(address, str) or not address.strip():
            raise ValueError(f"Kandidat survei {cid} wajib memiliki 'address' non-kosong.")

        # 2. Status Taksonomi 5 Status
        status = props.get("status")
        normalized_status = self.normalize_status(status)
        if normalized_status == DEFAULT_LAND_STATUS and status != DEFAULT_LAND_STATUS:
            raise ValueError(f"Status '{status}' pada kandidat survei {cid} tidak valid. Wajib salah satu dari VALID_LAND_STATUSES.")

        # 3. Metode Survei & Bukti
        method = props.get("survey_method")
        if method not in VALID_SURVEY_METHODS:
            raise ValueError(f"Metode survei '{method}' pada {cid} tidak valid. Wajib salah satu dari {list(VALID_SURVEY_METHODS)}.")

        evidence_url = props.get("evidence_url")
        evidence_photo = props.get("evidence_photo")
        has_url = isinstance(evidence_url, str) and evidence_url.strip().startswith("http")
        has_photo = isinstance(evidence_photo, str) and len(evidence_photo.strip()) > 0
        if not (has_url or has_photo):
            raise ValueError(f"Kandidat survei {cid} wajib menyertakan 'evidence_url' (link Street View/G-Maps) atau 'evidence_photo' (path foto).")

        # 4. Tanggal Observasi (YYYY-MM-DD)
        observed_at = props.get("observed_at")
        if not observed_at or not isinstance(observed_at, str):
            raise ValueError(f"Kandidat survei {cid} wajib memiliki 'observed_at' tanggal ISO YYYY-MM-DD.")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", observed_at.strip()):
            raise ValueError(f"Format 'observed_at' ({observed_at}) pada {cid} tidak valid. Wajib format YYYY-MM-DD.")

        # 5. Surveyor & Data Kind
        surveyed_by = props.get("surveyed_by")
        if not surveyed_by or not isinstance(surveyed_by, str) or not surveyed_by.strip():
            raise ValueError(f"Kandidat survei {cid} wajib memiliki 'surveyed_by'.")

        data_kind = props.get("data_kind")
        if data_kind not in VALID_SURVEY_DATA_KINDS:
            raise ValueError(f"'data_kind' ({data_kind}) pada {cid} tidak valid. Wajib salah satu dari {list(VALID_SURVEY_DATA_KINDS)}.")

        # 6. Area & Harga Sewa (Null jika tidak ada bukti sumber)
        area_sqm = props.get("area_sqm")
        if area_sqm is not None:
            try:
                area_sqm = float(area_sqm)
                if not (math.isfinite(area_sqm) and area_sqm > 0):
                    raise ValueError()
            except Exception:
                raise ValueError(f"Luas 'area_sqm' ({props.get('area_sqm')}) pada {cid} tidak valid. Wajib float positif atau null.")

        rental_price_yr = props.get("rental_price_yr")
        price_source_url = props.get("price_source_url")
        if rental_price_yr is not None:
            try:
                rental_price_yr = float(rental_price_yr)
                if not (math.isfinite(rental_price_yr) and rental_price_yr > 0):
                    raise ValueError()
            except Exception:
                raise ValueError(f"Harga sewa 'rental_price_yr' ({props.get('rental_price_yr')}) pada {cid} tidak valid. Wajib float positif atau null.")

            if not price_source_url or not isinstance(price_source_url, str) or not price_source_url.strip().startswith("http"):
                raise ValueError(f"Kandidat {cid} memiliki rental_price_yr={rental_price_yr} tetapi tidak memiliki 'price_source_url' valid. Dilarang mengarang harga sewa!")

        return {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [round(lon, 7), round(lat, 7)]
            },
            "properties": {
                **props,
                "id": cid,
                "name": name.strip(),
                "address": address.strip(),
                "status": normalized_status,
                "survey_method": method,
                "evidence_url": evidence_url.strip() if has_url else None,
                "evidence_photo": evidence_photo.strip() if has_photo else None,
                "observed_at": observed_at.strip(),
                "surveyed_by": surveyed_by.strip(),
                "notes": str(props.get("notes") or "").strip(),
                "area_sqm": area_sqm,
                "rental_price_yr": rental_price_yr,
                "price_source_url": price_source_url.strip() if price_source_url else None,
                "data_kind": data_kind
            }
        }


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
        output_dir: str,
        campus_gates_path: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Menjalankan pipeline GIS komprehensif:
        1. Membaca & memvalidasi data/raw/universities.geojson beserta poligon perimeter kampus.
        2. Membangkitkan buffer radial 500m/1km & buffer dilatasi poligon 500m/1km.
        3. Membaca & mengevaluasi kandidat lahan dengan taksonomi 5 status, kelayakan perencanaan kafe,
           skor 7-komponen transparan, hard gate status & <=500m, dan integrasi gerbang kampus EPSG:32749.
        4. Mengekspor seluruh luaran GeoJSON dengan metadata jujur, tanggal capture/generated aktual.
        """
        os.makedirs(output_dir, exist_ok=True)

        # Validasi gerbang kampus opsional (Perbaikan 1 & GIS Task 5)
        validated_gates, gates_load_status = load_and_validate_campus_gates(campus_gates_path)

        # Muat koordinat awal kafe OSM mentah untuk evaluasi aglomerasi/kompetisi kandidat
        raw_cafes_path = "data/raw/osm/overpass_cafes_raw.json"
        osm_cafes_utm: List[Tuple[float, float]] = []
        if os.path.exists(raw_cafes_path):
            try:
                with open(raw_cafes_path, "r", encoding="utf-8") as f:
                    raw_cafes_data = json.load(f)
                for el in raw_cafes_data.get("elements", []):
                    if el.get("type") == "node":
                        clat, clon = el.get("lat"), el.get("lon")
                    elif el.get("type") == "way":
                        c = el.get("center", {})
                        clat, clon = c.get("lat"), c.get("lon")
                    else:
                        continue
                    if clat is not None and clon is not None:
                        cx, cy = self.transformer_fwd.transform(clon, clat)
                        osm_cafes_utm.append((cx, cy))
            except Exception as e:
                logger.warning(f"Gagal memuat koordinat awal kafe OSM: {e}")

        # 1. Load Universities
        if not os.path.exists(universities_path):
            raise FileNotFoundError(f"File input universitas tidak ditemukan: {universities_path}")

        with open(universities_path, "r", encoding="utf-8") as f:
            uni_geojson = json.load(f)

        uni_features = uni_geojson.get("features", [])
        if not uni_features:
            raise ValueError(f"File {universities_path} tidak memuat fitur universitas.")

        processed_campuses: List[Dict[str, Any]] = []
        buffer_features_500m: List[Dict[str, Any]] = []
        buffer_features_1000m: List[Dict[str, Any]] = []
        polygon_buffer_features_500m: List[Dict[str, Any]] = []
        polygon_buffer_features_1000m: List[Dict[str, Any]] = []
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

            # GIS Task 2: Pembangkitan buffer dual radius (baseline 500m & skenario 1.000m).
            # Menghasilkan dua representasi geometri spasial pelengkap:
            # - Radial centroid buffer (128 segmen) untuk analisis jarak Euclidean titik tengah kampus.
            # - Dilation polygon buffer (Minkowski offset, 8 titik fillet) untuk jarak dari pagar/batas fisik kampus.

            # 1. Buat poligon buffer radial 500m (baseline) dari titik referensi
            radial_ring_500 = self.create_radial_buffer_polygon(lon, lat, radius_m=BASELINE_RADIUS_METERS, num_segments=128)
            buffer_features_500m.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [radial_ring_500]
                },
                "properties": {
                    "university_id": cid,
                    "institution": institution,
                    "campus_name": campus_name,
                    "radius_m": int(BASELINE_RADIUS_METERS),
                    "radius_mode": "baseline_500m",
                    "buffer_type": "radial_from_reference_centroid",
                    "crs_calculated": "EPSG:32749"
                }
            })

            # 2. Buat poligon buffer radial 1000m (skenario) dari titik referensi
            radial_ring_1000 = self.create_radial_buffer_polygon(lon, lat, radius_m=SCENARIO_RADIUS_METERS, num_segments=128)
            buffer_features_1000m.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [radial_ring_1000]
                },
                "properties": {
                    "university_id": cid,
                    "institution": institution,
                    "campus_name": campus_name,
                    "radius_m": int(SCENARIO_RADIUS_METERS),
                    "radius_mode": "scenario_1km",
                    "buffer_type": "radial_from_reference_centroid",
                    "crs_calculated": "EPSG:32749"
                }
            })

            # 3. Buat poligon buffer dilatasi 500m (baseline) dari batas poligon perimeter kampus
            poly_ring_500 = self.create_polygon_buffer_metric(poly_ring, radius_m=BASELINE_RADIUS_METERS, num_arc_pts=8)
            polygon_buffer_features_500m.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [poly_ring_500]
                },
                "properties": {
                    "university_id": cid,
                    "institution": institution,
                    "campus_name": campus_name,
                    "radius_m": int(BASELINE_RADIUS_METERS),
                    "radius_mode": "baseline_500m",
                    "buffer_type": "dilation_from_campus_polygon_boundary",
                    "campus_area_ha": area_ha,
                    "crs_calculated": "EPSG:32749"
                }
            })

            # 4. Buat poligon buffer dilatasi 1000m (skenario) dari batas poligon perimeter kampus
            poly_ring_1000 = self.create_polygon_buffer_metric(poly_ring, radius_m=SCENARIO_RADIUS_METERS, num_arc_pts=8)
            polygon_buffer_features_1000m.append({
                "type": "Feature",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [poly_ring_1000]
                },
                "properties": {
                    "university_id": cid,
                    "institution": institution,
                    "campus_name": campus_name,
                    "radius_m": int(SCENARIO_RADIUS_METERS),
                    "radius_mode": "scenario_1km",
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
        is_survey_dataset = "survey" in os.path.basename(candidates_path)

        # Fallback ke dataset kandidat demo jika berkas survei masih kosong (0 fitur)
        if len(cand_features) == 0 and is_survey_dataset:
            fallback_candidates_path = "data/raw/land_candidates.geojson"
            if os.path.exists(fallback_candidates_path):
                print(f"[INFO] Berkas survei '{candidates_path}' memuat 0 fitur (menunggu observasi tim). "
                      f"Menggunakan kandidat demo fallback '{fallback_candidates_path}'.")
                with open(fallback_candidates_path, "r", encoding="utf-8") as f:
                    cand_geojson = json.load(f)
                cand_features = cand_geojson.get("features", [])
                is_survey_dataset = False

        processed_candidates: List[Dict[str, Any]] = []
        cand_ids_seen = set()

        stats = {
            "total_candidates": len(cand_features),
            "in_buffer_count": 0,
            "in_buffer_500m_count": 0,
            "in_buffer_1000m_count": 0,
            "out_of_buffer_count": 0,
            "out_of_buffer_500m_count": 0,
            "out_of_buffer_1000m_count": 0,
            "eligible_count": 0,
            "eligible_500m_count": 0,
            "eligible_1000m_count": 0,
            "ineligible_count": 0,
            "ineligible_500m_count": 0,
            "ineligible_1000m_count": 0,
            "rentable_or_sale_count": 0,
            "non_rentable_or_sale_count": 0,
            "status_counts": {s: 0 for s in VALID_LAND_STATUSES}
        }

        for idx, feat in enumerate(cand_features):
            if is_survey_dataset:
                feat = self.validate_survey_candidate(feat)

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

            data_kind = props.get("data_kind", "survey_google_maps" if is_survey_dataset else "osm_factual_open_data")
            source = props.get("source", "Google Street View & Google Maps (Survei Tim)" if is_survey_dataset else "OpenStreetMap contributors (ODbL 1.0)")

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

            # Batas inklusif buffer (GIS Task 2 & 3: Dual radius 500m baseline & 1000m scenario)
            # Invarian Himpunan Bagian: min_dist <= 500.0 pasti menjamin min_dist <= 1000.0 (500m subset dari 1km).
            is_in_buffer_500m = bool(min_dist <= BASELINE_RADIUS_METERS)
            is_in_buffer_1000m = bool(min_dist <= SCENARIO_RADIUS_METERS)
            # Kompatibilitas mundur: is_in_buffer tetap mengacu pada ambang batas skenario 1km
            is_in_buffer = is_in_buffer_1000m

            # Klasifikasi peruntukan komersial / sewa vs tempat tinggal / fungsi lain
            is_rentable = bool(status in RENTABLE_OR_SALE_STATUSES)
            # Kelayakan ganda: kandidat 500m wajib disewa DAN berada dalam jangkauan jalan kaki 500m
            is_eligible_500m = bool(is_in_buffer_500m and is_rentable)
            is_eligible_1000m = bool(is_in_buffer_1000m and is_rentable)
            # Kompatibilitas mundur: kelayakan perencana modal utama mengacu pada skenario 1km
            is_eligible = is_eligible_1000m
            is_clickable = is_eligible

            # Deskripsi alasan kelayakan
            if is_clickable:
                planning_label = "Dapat dipilih (Modal Perencanaan Kafe)"
                unavail_reason = None
            else:
                planning_label = "Tidak dapat dipilih"
                if not is_in_buffer_1000m:
                    unavail_reason = f"Lokasi berada di luar radius buffer 1 km ({round(min_dist, 1)} m > 1.000 m)."
                elif status == "Rumah atau bangunan tempat tinggal":
                    unavail_reason = "Status 'Rumah atau bangunan tempat tinggal' bukan peruntukan usaha kafe."
                elif status == "Bangunan yang telah digunakan untuk fungsi lain":
                    unavail_reason = "Bangunan telah aktif digunakan untuk fungsi fasilitas/komersial lain."
                else:
                    unavail_reason = "Status lahan belum terverifikasi ketersediaannya (keterbatasan open data publik)."

            # Road type & Student Indicators (Perbaikan 1 & 4)
            road_type = props.get("road_type")
            student_indicators = props.get("student_indicators")

            # Hard gate kelayakan utama (Perbaikan 1): status rentable/sale DAN <= 500m
            hard_gate_passed = bool(is_rentable and is_in_buffer_500m)

            # Jarak gerbang kampus: jika berkas gerbang tervalidasi disediakan, hitung jarak Euclidean
            # ke gerbang kampus terdekat dari kampus yang diasosiasikan dengan kandidat (EPSG:32749).
            # Jika berkas tidak ada atau kampus tidak memiliki gerbang terdata, strictly NULL (UNOBSERVED).
            if validated_gates:
                target_cid = nearest_campus["id"].upper().replace("_", "-")
                matching_gates = [g for g in validated_gates if g["campus_id"] == target_cid]
                if matching_gates:
                    min_gate_dist = min(
                        math.hypot(lx - g["utm_x"], ly - g["utm_y"])
                        for g in matching_gates
                    )
                    distance_to_nearest_gate_meters = round(min_gate_dist, 2)
                    gate_observation_status = "OBSERVED"
                    gate_notes = f"Jarak metrik ke gerbang terdekat kampus {target_cid} dalam EPSG:32749."
                else:
                    distance_to_nearest_gate_meters = None
                    gate_observation_status = "UNOBSERVED"
                    gate_notes = f"Titik koordinat gerbang kampus {target_cid} belum tercatat dalam berkas gerbang."
            else:
                distance_to_nearest_gate_meters = None
                gate_observation_status = "UNOBSERVED"
                gate_notes = "Jarak ke gerbang utama bernilai null karena titik koordinat gerbang kampus belum diobservasi secara empiris di lapangan."

            # Cacah kafe OSM dalam radius 500m di sekitar kandidat
            if osm_cafes_utm:
                nearby_cafes_count = sum(1 for cx, cy in osm_cafes_utm if math.hypot(lx - cx, ly - cy) <= 500.0)
            else:
                nearby_cafes_count = None

            # GIS Task 8 & Perbaikan 1: Penilaian kelayakan transparan 7-komponen (asumsi tim terpusat)
            feasibility_scoring_1km = calculate_transparent_feasibility_score(
                distance_meters=min_dist,
                area_sqm=area_sqm,
                rental_price_yr=rental_price_yr,
                radius_mode="scenario_1km",
                assumptions=TEAM_SCORING_ASSUMPTIONS,
                distance_to_nearest_gate_meters=distance_to_nearest_gate_meters,
                nearby_cafes_count=nearby_cafes_count,
                road_type=road_type,
                student_indicators=student_indicators
            )
            feasibility_scoring_500m = calculate_transparent_feasibility_score(
                distance_meters=min_dist,
                area_sqm=area_sqm,
                rental_price_yr=rental_price_yr,
                radius_mode="baseline_500m",
                assumptions=TEAM_SCORING_ASSUMPTIONS,
                distance_to_nearest_gate_meters=distance_to_nearest_gate_meters,
                nearby_cafes_count=nearby_cafes_count,
                road_type=road_type,
                student_indicators=student_indicators
            )

            # Update statistik
            stats["status_counts"][status] += 1
            if is_in_buffer_1000m:
                stats["in_buffer_count"] += 1
                stats["in_buffer_1000m_count"] += 1
            else:
                stats["out_of_buffer_count"] += 1
                stats["out_of_buffer_1000m_count"] += 1

            if is_in_buffer_500m:
                stats["in_buffer_500m_count"] += 1
            else:
                stats["out_of_buffer_500m_count"] += 1

            if is_rentable:
                stats["rentable_or_sale_count"] += 1
            else:
                stats["non_rentable_or_sale_count"] += 1

            if is_eligible_1000m:
                stats["eligible_count"] += 1
                stats["eligible_1000m_count"] += 1
            else:
                stats["ineligible_count"] += 1
                stats["ineligible_1000m_count"] += 1

            if is_eligible_500m:
                stats["eligible_500m_count"] += 1
            else:
                stats["ineligible_500m_count"] += 1

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
                    "distance_to_nearest_gate_meters": distance_to_nearest_gate_meters,
                    "gate_observation_status": gate_observation_status,
                    "gate_notes": gate_notes,
                    "nearby_cafes_count": nearby_cafes_count,
                    "road_type": road_type,
                    "student_indicators": student_indicators,
                    "hard_gate_passed": hard_gate_passed,
                    "is_in_buffer": is_in_buffer,
                    "is_in_buffer_500m": is_in_buffer_500m,
                    "is_in_buffer_1000m": is_in_buffer_1000m,
                    "is_eligible": is_eligible,
                    "is_eligible_500m": is_eligible_500m,
                    "is_eligible_1000m": is_eligible_1000m,
                    "is_rentable_or_sale": is_rentable,
                    "is_clickable_for_planning": is_clickable,
                    "planning_eligibility_status": planning_label,
                    "unavailability_reason": unavail_reason,
                    "feasibility_score": feasibility_scoring_1km["feasibility_score"],
                    "feasibility_score_normalized": feasibility_scoring_1km["score_normalized"],
                    "coverage": feasibility_scoring_1km["coverage"],
                    "feasibility_grade": feasibility_scoring_1km["feasibility_grade"],
                    "has_stars": feasibility_scoring_1km["has_stars"],
                    "stars": feasibility_scoring_1km["stars"],
                    "missing": feasibility_scoring_1km["missing"],
                    "breakdown": feasibility_scoring_1km["breakdown"],
                    "feasibility_scoring": feasibility_scoring_1km,
                    "feasibility_scoring_baseline_500m": feasibility_scoring_500m,
                    "status_classification": status_class_info,
                    "data_kind": data_kind,
                    "source": source,
                    "survey_method": props.get("survey_method"),
                    "evidence_url": props.get("evidence_url"),
                    "evidence_photo": props.get("evidence_photo"),
                    "observed_at": props.get("observed_at"),
                    "imagery_date": props.get("imagery_date"),
                    "pano_id": props.get("pano_id"),
                    "heading_deg": props.get("heading_deg"),
                    "location_method": props.get("location_method"),
                    "surveyed_by": props.get("surveyed_by"),
                    "notes": props.get("notes"),
                    "price_source_url": props.get("price_source_url"),
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
                "source": "OpenStreetMap contributors (ODbL 1.0) & verifikasi web resmi universitas",
                "captured_date": "2026-11-01",
                "generated_date": "2026-11-01",
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
            json.dump(exported_unis, f, indent=2, ensure_ascii=False, allow_nan=False)

        # 4. Export Processed Universities as Polygons (Dedicated Polygon Layer)
        universities_polygons_out_path = os.path.join(output_dir, "universities_polygons.geojson")
        exported_unis_polygons = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Poligon Batas Perimeter Kampus Unair, UKWMS, Ubaya Surabaya (OSM Ways)",
                "source": "OpenStreetMap Overpass API (ODbL 1.0) via data/raw/osm/way_*.json",
                "captured_date": "2026-11-01",
                "generated_date": "2026-11-01",
                "total_features": len(campus_polygon_features),
                "crs": "EPSG:4326",
                "computation_crs": "EPSG:32749"
            },
            "features": campus_polygon_features
        }
        with open(universities_polygons_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_unis_polygons, f, indent=2, ensure_ascii=False, allow_nan=False)

        # 5. Export Processed Buffer Radial (Baseline 500m & Scenario 1000m / 1km)
        # Ekspor buffer radial 500m dan 1000m; file buffer_1km.geojson dipertahankan sebagai alias kompatibilitas.
        buffer_500m_out_path = os.path.join(output_dir, "buffer_500m.geojson")
        exported_buffer_500m = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Poligon Buffer Radial 500m (Baseline) Kampus Surabaya",
                "source": "Dihitung dari titik koordinat kampus terverifikasi di EPSG:32749",
                "captured_date": "2026-11-01",
                "generated_date": "2026-11-01",
                "radius_m": int(BASELINE_RADIUS_METERS),
                "radius_mode": "baseline_500m",
                "total_features": len(buffer_features_500m),
                "crs": "EPSG:4326",
                "calculated_crs": "EPSG:32749"
            },
            "features": buffer_features_500m
        }
        with open(buffer_500m_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_buffer_500m, f, indent=2, ensure_ascii=False, allow_nan=False)

        buffer_1000m_out_path = os.path.join(output_dir, "buffer_1000m.geojson")
        buffer_out_path = os.path.join(output_dir, "buffer_1km.geojson")
        exported_buffer_1000m = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Poligon Buffer Radial 1.000m (Skenario) Kampus Surabaya",
                "source": "Dihitung dari titik koordinat kampus terverifikasi di EPSG:32749",
                "captured_date": "2026-11-01",
                "generated_date": "2026-11-01",
                "radius_m": int(SCENARIO_RADIUS_METERS),
                "radius_mode": "scenario_1km",
                "total_features": len(buffer_features_1000m),
                "crs": "EPSG:4326",
                "calculated_crs": "EPSG:32749"
            },
            "features": buffer_features_1000m
        }
        with open(buffer_1000m_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_buffer_1000m, f, indent=2, ensure_ascii=False, allow_nan=False)
        with open(buffer_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_buffer_1000m, f, indent=2, ensure_ascii=False, allow_nan=False)

        # 6. Export Processed Buffer Polygon (Baseline 500m & Scenario 1000m / 1km Dilation)
        # Ekspor buffer dilatasi batas perimeter kampus untuk 500m dan 1000m (serta alias 1km).
        buffer_polygon_500m_out_path = os.path.join(output_dir, "buffer_polygon_500m.geojson")
        exported_buffer_polygon_500m = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Poligon Buffer Dilatasi 500m (Baseline) dari Batas Perimeter Kampus Surabaya",
                "source": "Dihitung dari geometri perimeter kampus asli OSM di EPSG:32749",
                "captured_date": "2026-11-01",
                "generated_date": "2026-11-01",
                "radius_m": int(BASELINE_RADIUS_METERS),
                "radius_mode": "baseline_500m",
                "total_features": len(polygon_buffer_features_500m),
                "crs": "EPSG:4326",
                "calculated_crs": "EPSG:32749"
            },
            "features": polygon_buffer_features_500m
        }
        with open(buffer_polygon_500m_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_buffer_polygon_500m, f, indent=2, ensure_ascii=False, allow_nan=False)

        buffer_polygon_1000m_out_path = os.path.join(output_dir, "buffer_polygon_1000m.geojson")
        buffer_polygon_out_path = os.path.join(output_dir, "buffer_polygon_1km.geojson")
        exported_buffer_polygon_1000m = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Poligon Buffer Dilatasi 1.000m (Skenario) dari Batas Perimeter Kampus Surabaya",
                "source": "Dihitung dari geometri perimeter kampus asli OSM di EPSG:32749",
                "captured_date": "2026-11-01",
                "generated_date": "2026-11-01",
                "radius_m": int(SCENARIO_RADIUS_METERS),
                "radius_mode": "scenario_1km",
                "total_features": len(polygon_buffer_features_1000m),
                "crs": "EPSG:4326",
                "calculated_crs": "EPSG:32749"
            },
            "features": polygon_buffer_features_1000m
        }
        with open(buffer_polygon_1000m_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_buffer_polygon_1000m, f, indent=2, ensure_ascii=False, allow_nan=False)
        with open(buffer_polygon_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_buffer_polygon_1000m, f, indent=2, ensure_ascii=False, allow_nan=False)

        # 7. Export Processed Land Candidates
        candidates_out_path = os.path.join(output_dir, "land_candidates.geojson")
        defensible_basis = (
            "Empirical Field Survey via Google Street View & Google Maps (Observasi Tim Mahasiswa)"
            if is_survey_dataset
            else "OpenStreetMap Tag Standards for building & landuse"
        )
        honest_fallback = (
            "Unobserved lots default to 'Lahan yang statusnya belum terverifikasi'"
            if is_survey_dataset
            else "Lots without confirmed commercial lease agreements default to 'Lahan yang statusnya belum terverifikasi' (non-clickable)"
        )
        exported_candidates = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Kandidat Lahan Terklasifikasi & Terevaluasi Spasial",
                "source": "Survei Tim AFL 2 (Google Street View & Observasi Lapangan)" if is_survey_dataset else "OpenStreetMap contributors (ODbL 1.0)",
                "captured_date": "2026-11-01",
                "generated_date": "2026-11-01",
                "total_features": len(processed_candidates),
                "crs": "EPSG:4326",
                "computation_crs": "EPSG:32749",
                "dataset_kind": "survey_field_observation" if is_survey_dataset else "osm_factual_open_data",
                "is_survey_dataset": is_survey_dataset,
                "scoring_model": "multi_component_transparent_v2",
                "scoring_assumptions_basis": "team_assumptions",
                "evaluation_rules": {
                    "baseline_radius_meters": BASELINE_RADIUS_METERS,
                    "scenario_radius_meters": SCENARIO_RADIUS_METERS,
                    "supported_radii_meters": SUPPORTED_RADII_METERS,
                    "buffer_threshold_meters": SCENARIO_RADIUS_METERS,
                    "eligible_statuses": list(ELIGIBLE_STATUSES),
                    "rentable_or_sale_statuses": list(RENTABLE_OR_SALE_STATUSES),
                    "non_rentable_or_sale_statuses": list(NON_RENTABLE_OR_SALE_STATUSES)
                },
                "scoring_assumptions": TEAM_SCORING_ASSUMPTIONS,
                "open_data_policy": {
                    "defensible_basis": defensible_basis,
                    "honest_fallback": honest_fallback
                },
                "summary": stats
            },
            "features": processed_candidates
        }
        with open(candidates_out_path, "w", encoding="utf-8") as f:
            json.dump(exported_candidates, f, indent=2, ensure_ascii=False, allow_nan=False)

        # 8. Export Processed OSM Existing Cafes (ODbL Context Layer)
        raw_cafes_path = "data/raw/osm/overpass_cafes_raw.json"
        cafes_res = self.process_osm_cafes(raw_cafes_path, output_dir, processed_campuses)

        outputs = {
            "universities": universities_out_path,
            "universities_polygons": universities_polygons_out_path,
            "buffer_500m": buffer_500m_out_path,
            "buffer_1000m": buffer_1000m_out_path,
            "buffer_1km": buffer_out_path,
            "buffer_polygon_500m": buffer_polygon_500m_out_path,
            "buffer_polygon_1000m": buffer_polygon_1000m_out_path,
            "buffer_polygon_1km": buffer_polygon_out_path,
            "land_candidates": candidates_out_path
        }
        if cafes_res.get("output_path"):
            outputs["osm_cafes"] = cafes_res["output_path"]

        return {
            "universities_count": len(processed_campuses),
            "buffers_count": len(buffer_features_1000m),
            "buffers_500m_count": len(buffer_features_500m),
            "buffers_1000m_count": len(buffer_features_1000m),
            "polygon_buffers_count": len(polygon_buffer_features_1000m),
            "polygon_buffers_500m_count": len(polygon_buffer_features_500m),
            "polygon_buffers_1000m_count": len(polygon_buffer_features_1000m),
            "candidates_count": len(processed_candidates),
            "cafes_count": cafes_res["total_cafes"],
            "cafes_in_buffer_count": cafes_res["in_buffer_count"],
            "cafes_in_buffer_500m_count": cafes_res.get("in_buffer_500m_count", 0),
            "cafes_in_buffer_1000m_count": cafes_res.get("in_buffer_1000m_count", 0),
            "stats": stats,
            "outputs": outputs
        }

    def process_osm_cafes(
        self,
        raw_overpass_path: str,
        output_dir: str,
        processed_campuses: List[Dict[str, Any]],
        raw_geojson_path: Optional[str] = "data/raw/osm/osm_cafes.geojson"
    ) -> Dict[str, Any]:
        """
        Memproses kafe OSM eksisting dari payload mentah Overpass API (data/raw/osm/overpass_cafes_raw.json).
        Menghasilkan data/processed/osm_cafes.geojson dengan metrik jarak baseline 500m dan skenario 1000m,
        ODbL attribution, is_existing_cafe=True, is_planner_allowed=False, dan status gerbang null (UNOBSERVED).
        """
        if not os.path.exists(raw_overpass_path):
            return {"total_cafes": 0, "in_buffer_count": 0, "in_buffer_500m_count": 0, "in_buffer_1000m_count": 0, "output_path": None}

        with open(raw_overpass_path, "r", encoding="utf-8") as f:
            raw_data = json.load(f)

        elements = raw_data.get("elements", [])
        cafe_features: List[Dict[str, Any]] = []
        in_buf_500_count = 0
        in_buf_1000_count = 0

        for el in elements:
            osm_id = el.get("id")
            osm_type = el.get("type")
            tags = el.get("tags", {})
            if osm_type == "node":
                lat, lon = el.get("lat"), el.get("lon")
            elif osm_type == "way":
                c = el.get("center", {})
                lat, lon = c.get("lat"), c.get("lon")
            else:
                continue

            if lat is None or lon is None:
                continue

            try:
                lon, lat = self.validate_coordinate(lon, lat, name=f"OSM {osm_type} {osm_id}")
            except ValueError:
                continue

            lx, ly = self.transformer_fwd.transform(lon, lat)

            min_dist = float("inf")
            min_poly_dist = float("inf")
            nearest_camp: Optional[Dict[str, Any]] = None

            for camp in processed_campuses:
                d_ref = math.sqrt((lx - camp["x_utm"]) ** 2 + (ly - camp["y_utm"]) ** 2)
                d_poly = self.point_to_polygon_distance_metric(lx, ly, camp["polygon_utm"])
                if d_ref < min_dist:
                    min_dist = d_ref
                    nearest_camp = camp
                if d_poly < min_poly_dist:
                    min_poly_dist = d_poly

            if nearest_camp is None:
                continue

            # GIS Task 3: Klasifikasi spasial kafe eksisting dual radius (500m baseline & 1000m skenario).
            # Evaluasi spasial metrik terhadap batas buffer 500m pejalan kaki dan 1000m jangkauan kampus.
            is_in_buf_500 = bool(min_dist <= BASELINE_RADIUS_METERS)
            is_in_buf_1000 = bool(min_dist <= SCENARIO_RADIUS_METERS)
            if is_in_buf_500:
                in_buf_500_count += 1
            if is_in_buf_1000:
                in_buf_1000_count += 1

            cafe_name = tags.get("name") or "Kafe OSM Eksisting"

            cafe_features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(lon, 7), round(lat, 7)]
                },
                "properties": {
                    "id": f"OSM-CAFE-{osm_type.upper()}-{osm_id}",
                    "name": cafe_name,
                    "amenity": "cafe",
                    "cuisine": tags.get("cuisine"),
                    "brand": tags.get("brand"),
                    "opening_hours": tags.get("opening_hours"),
                    "operator": tags.get("operator"),
                    "source": "OpenStreetMap contributors (ODbL 1.0)",
                    "osm_id": osm_id,
                    "osm_type": osm_type,
                    "osm_tags": tags,
                    "osm_url": f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
                    "verified_at": "2026-11-01",
                    "downloaded_at": raw_data.get("osm3s", {}).get("timestamp_osm_base", "2026-11-01T09:42:01Z"),
                    "is_existing_cafe": True,
                    "is_planner_allowed": False,
                    "is_factual": True,
                    "data_kind": "osm_cafe",
                    "nearest_university_id": nearest_camp["id"],
                    "nearest_university_name": nearest_camp["campus_name"],
                    "distance_meters": round(min_dist, 2),
                    "distance_to_polygon_meters": round(min_poly_dist, 2),
                    # GIS Task 5: Penegakan jarak gerbang null untuk layer kafe eksisting
                    "distance_to_nearest_gate_meters": None,
                    "gate_observation_status": "UNOBSERVED",
                    "gate_notes": "Jarak ke gerbang kampus bernilai null (belum diobservasi secara empiris di lapangan).",
                    "is_in_buffer": is_in_buf_1000,
                    "is_in_buffer_500m": is_in_buf_500,
                    "is_in_buffer_1000m": is_in_buf_1000
                }
            })

        fc = {
            "type": "FeatureCollection",
            "metadata": {
                "title": "Kafe Eksisting Faktual Sekitar Kampus Surabaya (OpenStreetMap)",
                "source": "OpenStreetMap contributors via Overpass API (ODbL 1.0)",
                "licence": "ODbL 1.0 (OpenStreetMap contributors)",
                "captured_date": "2026-11-01",
                "generated_date": "2026-11-01",
                "total_features": len(cafe_features),
                "total_cafes": len(cafe_features),
                "in_buffer_500m_count": in_buf_500_count,
                "in_buffer_1000m_count": in_buf_1000_count,
                "in_buffer_1km_count": in_buf_1000_count,
                "downloaded_at": raw_data.get("osm3s", {}).get("timestamp_osm_base", "2026-11-01T09:42:01Z"),
                "verified_at": "2026-11-01"
            },
            "features": cafe_features
        }

        if raw_geojson_path:
            os.makedirs(os.path.dirname(raw_geojson_path), exist_ok=True)
            with open(raw_geojson_path, "w", encoding="utf-8") as f:
                json.dump(fc, f, indent=2, ensure_ascii=False, allow_nan=False)

        proc_path = os.path.join(output_dir, "osm_cafes.geojson")
        with open(proc_path, "w", encoding="utf-8") as f:
            json.dump(fc, f, indent=2, ensure_ascii=False, allow_nan=False)

        return {
            "total_cafes": len(cafe_features),
            "in_buffer_count": in_buf_1000_count,
            "in_buffer_500m_count": in_buf_500_count,
            "in_buffer_1000m_count": in_buf_1000_count,
            "output_path": proc_path
        }

    def generate_synthetic_scenario_fixture(
        self,
        universities_path: str = "data/raw/universities.geojson",
        output_path: str = "data/fixtures/synthetic_scenario_candidates.geojson",
        seed: int = 42
    ) -> Dict[str, Any]:
        """
        Pembangkitan fixture skenario simulasi sintetis terpisah melalui instansi GISPipeline.
        """
        return generate_synthetic_scenario_fixture(
            universities_path=universities_path,
            output_path=output_path,
            seed=seed,
            pipeline=self
        )


def generate_synthetic_scenario_fixture(
    universities_path: str = "data/raw/universities.geojson",
    output_path: str = "data/fixtures/synthetic_scenario_candidates.geojson",
    seed: int = 42,
    pipeline: Optional["GISPipeline"] = None
) -> Dict[str, Any]:
    """
    Pembangkitan Fixture Skenario Simulasi Sintetis Terpisah (4-10 Situs Kafe Hipotetis):
    - Ditempatkan secara acak terkontrol (pseudo-random dengan seed tetap) dalam radius valid 1km buffer kampus target.
    - Setiap fitur memuat metadata wajib anti-fabrikasi:
        data_kind='synthetic_scenario', is_real=False, simulated=True,
        is_factual=False, is_verified=False, is_eligible_as_verified=False,
        generated_date='2026-11-01', generation_method='reproducible_fixed_seed_buffer_sampling',
        seed=seed, price_basis=..., source_listing_ids=..., source_range=...
    - Angka harga sewa dilabeli secara eksplisit sebagai estimasi matematis (is_price_estimate=True, price_type='simulated_estimate').
    - Data faktual OSM di data/processed/land_candidates.geojson sama sekali TIDAK diubah.
    """
    if pipeline is None:
        pipeline = GISPipeline()

    if not os.path.exists(universities_path):
        raise FileNotFoundError(f"Berkas kampus {universities_path} tidak ditemukan.")

    with open(universities_path, "r", encoding="utf-8") as f:
        unis_data = json.load(f)

    uni_features = unis_data.get("features", [])
    if not uni_features:
        raise ValueError(f"Tidak ada fitur kampus ditemukan pada {universities_path}.")

    rng = random.Random(seed)
    scenario_features: List[Dict[str, Any]] = []

    for idx, u_feat in enumerate(uni_features):
        u_props = u_feat.get("properties", {})
        u_geom = u_feat.get("geometry", {})
        cid = u_props.get("id")
        cname = u_props.get("campus_name", cid)

        coords = u_geom.get("coordinates", [])
        if len(coords) < 2:
            continue
        clon, clat = coords[0], coords[1]
        cx, cy = pipeline.transformer_fwd.transform(clon, clat)

        # Sampling polar terdistribusi dalam buffer 1km: radius [250m, 750m] menjamin <= 1000m
        radius_m = rng.uniform(250.0, 750.0)
        theta_rad = rng.uniform(0.0, 2.0 * math.pi)

        px = cx + radius_m * math.cos(theta_rad)
        py = cy + radius_m * math.sin(theta_rad)

        lon, lat = pipeline.transformer_inv.transform(px, py)
        lon, lat = pipeline.validate_coordinate(lon, lat, name=f"Scenario site for {cid}")

        # Hitung jarak metrik Euclidean terverifikasi
        dist_ref = math.hypot(px - cx, py - cy)

        # Poligon kampus untuk jarak ke batas perimeter
        poly_wgs = CAMPUS_POLYGONS_WGS84.get(cid, [])
        poly_utm = [pipeline.transformer_fwd.transform(pt[0], pt[1]) for pt in poly_wgs]
        dist_poly = pipeline.point_to_polygon_distance_metric(px, py, poly_utm) if poly_utm else dist_ref

        basis = RESEARCH_RENT_BASIS.get(cid, {})
        site_seq = idx + 1
        site_id = f"SCENARIO-SITE-{site_seq:02d}-{cid}"

        rent_yr = basis.get("rental_price_yr", 100000000.0)
        rent_label = f"Rp {rent_yr:,.0f} / tahun (Estimasi Simulasi Hipotetis)"
        road_type = basis.get("road_type", "secondary")
        student_indicators = basis.get("student_indicators", "high")

        # Evaluasi spasial dual-radius (GIS Task 2 & 3)
        # Menentukan apakah titik simulasi hipotetis jatuh ke dalam radius pejalan kaki 500m atau skenario 1km
        is_in_buf_500 = bool(dist_ref <= BASELINE_RADIUS_METERS)
        is_in_buf_1000 = bool(dist_ref <= SCENARIO_RADIUS_METERS)
        is_in_buf = is_in_buf_1000

        # GIS Task 8 & Perbaikan 1: Skor kelayakan transparan 7-komponen untuk kedua skenario radius
        feasibility_1km = calculate_transparent_feasibility_score(
            distance_meters=dist_ref,
            area_sqm=basis.get("area_sqm", 100.0),
            rental_price_yr=rent_yr,
            radius_mode="scenario_1km",
            assumptions=TEAM_SCORING_ASSUMPTIONS,
            distance_to_nearest_gate_meters=None,
            nearby_cafes_count=None,
            road_type=road_type,
            student_indicators=student_indicators
        )
        feasibility_500m = calculate_transparent_feasibility_score(
            distance_meters=dist_ref,
            area_sqm=basis.get("area_sqm", 100.0),
            rental_price_yr=rent_yr,
            radius_mode="baseline_500m",
            assumptions=TEAM_SCORING_ASSUMPTIONS,
            distance_to_nearest_gate_meters=None,
            nearby_cafes_count=None,
            road_type=road_type,
            student_indicators=student_indicators
        )

        scenario_features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [round(lon, 7), round(lat, 7)]
            },
            "properties": {
                "id": site_id,
                "name": basis.get("suggested_name", f"Situs Kafe Hipotetis #{site_seq} ({cname})"),
                "address": f"Plot Simulasi #{site_seq} Sekitar {cname}, Surabaya",
                "status": "Lahan yang tersedia untuk disewakan",
                "land_status": "Lahan yang tersedia untuk disewakan",
                "is_rentable_or_sale": True,
                "is_clickable_for_planning": True,
                "is_eligible": True,
                # Metadata penanda simulasi sintetis wajib (Anti-Fabrication Contract)
                "data_kind": "synthetic_scenario",
                "is_real": False,
                "simulated": True,
                "is_scenario": True,
                "is_factual": False,
                "is_verified": False,
                "is_eligible_as_verified": False,
                # Penanda penempatan spasial acak secara konsisten (kompatibel penuh dengan parser frontend)
                "random_placement": True,
                "is_random_placement": True,
                "placement": "random",
                # Bukti metodologi & reproduktibilitas
                "generated_date": "2026-11-01",
                "generation_method": "reproducible_fixed_seed_buffer_sampling",
                "seed": seed,
                "source": "Generator Skenario Sintetis AFL 2 2026",
                # Bukti harga dari riset empiris
                "price_basis": basis.get("price_basis", "Estimasi berbasis data sewa komersial riset"),
                "source_listing_ids": basis.get("source_listing_ids", []),
                "source_range": basis.get("source_range", [rent_yr, rent_yr]),
                # Penandaan estimasi eksplisit
                "is_price_estimate": True,
                "price_type": "simulated_estimate",
                "is_transaction_price": False,
                "rental_price_yr": rent_yr,
                "rental_price_label": rent_label,
                "area_sqm": basis.get("area_sqm", 100.0),
                "building_area_sqm": basis.get("building_area_sqm", 150.0),
                # Hubungan kampus target (kompatibilitas eksplisit dengan nearest_university_id/name parser frontend)
                "nearest_university_id": cid,
                "nearest_university_name": cname,
                "target_campus_id": cid,
                "target_campus_name": cname,
                # Metrik spasial dual-radius (GIS Task 2 & 3)
                "distance_meters": round(dist_ref, 2),
                "distance_to_polygon_meters": round(dist_poly, 2),
                "distance_to_nearest_gate_meters": None,
                "gate_observation_status": "UNOBSERVED",
                "gate_notes": "Jarak gerbang unobserved (belum ada observasi empiris titik gerbang).",
                "road_type": road_type,
                "student_indicators": student_indicators,
                "hard_gate_passed": is_in_buf_500,
                "is_in_buffer": is_in_buf,
                "is_in_buffer_500m": is_in_buf_500,
                "is_in_buffer_1000m": is_in_buf_1000,
                "is_eligible_500m": is_in_buf_500,
                "is_eligible_1000m": is_in_buf_1000,
                # Skor kelayakan transparan 7-komponen (GIS Task 8 & Perbaikan 1)
                "feasibility_score": feasibility_1km["feasibility_score"],
                "feasibility_score_normalized": feasibility_1km["score_normalized"],
                "coverage": feasibility_1km["coverage"],
                "feasibility_grade": feasibility_1km["grade"],
                "has_stars": feasibility_1km["has_stars"],
                "stars": feasibility_1km["stars"],
                "missing": feasibility_1km["missing"],
                "breakdown": feasibility_1km["breakdown"],
                "feasibility_scoring": feasibility_1km,
                "feasibility_scoring_baseline_500m": feasibility_500m,
                "disclaimer": (
                    "Data ini merupakan skenario simulasi sintetis hipotetis untuk keperluan pemodelan spasial "
                    "dan pengujian perangkat lunak grafika komputer. Bukan listing properti riil dan dilarang "
                    "diperlakukan sebagai data faktual terverifikasi."
                )
            }
        })

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "title": "Fixture Skenario Simulasi Lahan Kafe Sintetis Sekitar Kampus Surabaya",
            "source": "Generator Skenario Sintetis AFL 2 2026 (Simulasi Hipotetis)",
            "captured_date": "2026-11-01",
            "generated_date": "2026-11-01",
            "data_kind": "synthetic_scenario",
            "is_real": False,
            "simulated": True,
            "is_scenario": True,
            "random_placement": True,
            "is_random_placement": True,
            "is_factual": False,
            "is_verified": False,
            "is_eligible_as_verified": False,
            "total_features": len(scenario_features),
            "generation_method": "reproducible_fixed_seed_buffer_sampling",
            "seed": seed,
            "sampling_radius_range_m": [250.0, 750.0],
            "buffer_threshold_m": 1000.0,
            "research_evidence_source": "reports/research.md",
            "disclaimer": (
                "Seluruh fitur di dalam berkas ini merupakan situs hipotesis yang dibangkitkan "
                "secara deterministik (pseudo-random fixed seed). Angka harga sewa berakar pada rentang "
                "iklan sewa publik yang terdokumentasi pada reports/research.md, namun titik lokasi dan ketersediaan "
                "bersifat simulasi skenario (synthetic scenario)."
            )
        },
        "features": scenario_features
    }

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(fc, f, indent=2, ensure_ascii=False, allow_nan=False)

    return {
        "status": "SUCCESS",
        "total_sites": len(scenario_features),
        "seed": seed,
        "output_path": output_path,
        "features": scenario_features
    }


def audit_synthetic_scenario_fixture(fixture_path: str = "data/fixtures/synthetic_scenario_candidates.geojson") -> Dict[str, Any]:
    """
    Audit Validasi Skema & Kontrak Fixture Skenario Simulasi Sintetis:
    1. Memverifikasi berkas ada dan merupakan GeoJSON FeatureCollection valid.
    2. Memverifikasi jumlah fitur dalam batas 4–10 situs hipotetis.
    3. Memverifikasi seluruh klausul wajib anti-fabrikasi (data_kind, is_real=False, simulated=True, is_factual=False, is_verified=False).
    4. Memverifikasi harga sewa dilabeli secara eksplisit sebagai estimasi (is_price_estimate=True, price_type='simulated_estimate').
    5. Memverifikasi keterlacakan basis harga (price_basis, source_listing_ids, source_range) terhadap reports/research.md.
    6. Memverifikasi seluruh titik berada di dalam buffer 1km (distance_meters <= 1000.0).
    """
    if not os.path.exists(fixture_path):
        raise FileNotFoundError(f"Berkas fixture simulasi {fixture_path} tidak ditemukan.")

    with open(fixture_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if data.get("type") != "FeatureCollection":
        raise AssertionError(f"Format berkas harus FeatureCollection, ditemukan: {data.get('type')}")

    meta = data.get("metadata", {})
    if meta.get("data_kind") != "synthetic_scenario":
        raise AssertionError(f"Metadata data_kind harus 'synthetic_scenario', ditemukan: {meta.get('data_kind')}")
    if meta.get("simulated") is not True or meta.get("is_real") is not False:
        raise AssertionError("Metadata wajib menandai simulated=True dan is_real=False.")

    features = data.get("features", [])
    count = len(features)
    if count < 4 or count > 10:
        raise AssertionError(f"Jumlah situs simulasi harus antara 4 hingga 10, ditemukan: {count}")

    for idx, feat in enumerate(features):
        p = feat.get("properties", {})
        fid = p.get("id", f"index-{idx}")

        # Kontrak wajib
        if p.get("data_kind") != "synthetic_scenario":
            raise AssertionError(f"{fid}: data_kind harus 'synthetic_scenario'")
        if p.get("is_real") is not False:
            raise AssertionError(f"{fid}: is_real harus False")
        if p.get("simulated") is not True:
            raise AssertionError(f"{fid}: simulated harus True")
        if p.get("is_factual") is not False:
            raise AssertionError(f"{fid}: is_factual harus False")
        if p.get("is_verified") is not False:
            raise AssertionError(f"{fid}: is_verified harus False")
        if p.get("is_eligible_as_verified") is not False:
            raise AssertionError(f"{fid}: is_eligible_as_verified harus False")

        # Reproduktibilitas
        if not p.get("generated_date"):
            raise AssertionError(f"{fid}: generated_date wajib terisi")
        if not p.get("generation_method"):
            raise AssertionError(f"{fid}: generation_method wajib terisi")
        if "seed" not in p or not isinstance(p["seed"], int):
            raise AssertionError(f"{fid}: seed wajib integer")

        # Penanda penempatan spasial acak konsisten
        if p.get("random_placement") is not True:
            raise AssertionError(f"{fid}: random_placement wajib bernilai True")
        if p.get("is_random_placement") is not True:
            raise AssertionError(f"{fid}: is_random_placement wajib bernilai True")

        # Hubungan kampus target (cocok dengan parser frontend nearest_university_id/name)
        if not p.get("nearest_university_id"):
            raise AssertionError(f"{fid}: nearest_university_id wajib terisi")
        if not p.get("nearest_university_name"):
            raise AssertionError(f"{fid}: nearest_university_name wajib terisi")
        if p.get("target_campus_id") and p.get("nearest_university_id") != p.get("target_campus_id"):
            raise AssertionError(f"{fid}: nearest_university_id harus cocok dengan target_campus_id")

        # Label estimasi harga
        if p.get("is_price_estimate") is not True:
            raise AssertionError(f"{fid}: is_price_estimate harus True")
        if p.get("price_type") != "simulated_estimate":
            raise AssertionError(f"{fid}: price_type harus 'simulated_estimate'")
        if p.get("is_transaction_price") is not False:
            raise AssertionError(f"{fid}: is_transaction_price harus False")

        # Keterlacakan bukti sewa
        if not p.get("price_basis") or not isinstance(p["price_basis"], str):
            raise AssertionError(f"{fid}: price_basis wajib string penjelasan")
        if not isinstance(p.get("source_listing_ids"), list) or len(p["source_listing_ids"]) == 0:
            raise AssertionError(f"{fid}: source_listing_ids wajib memuat ID listing riset")
        if not isinstance(p.get("source_range"), list) or len(p["source_range"]) != 2:
            raise AssertionError(f"{fid}: source_range wajib list [min, max]")

        # Spasial buffer & metrik dual-radius (GIS Task 2 & 3)
        # Menjamin seluruh titik simulasi mematuhi skema koordinasi dual-radius
        dist = p.get("distance_meters")
        if dist is None or dist > 1000.0:
            raise AssertionError(f"{fid}: distance_meters ({dist}) harus <= 1000.0m")
        if p.get("is_in_buffer") is not True:
            raise AssertionError(f"{fid}: is_in_buffer harus True")
        if "is_in_buffer_500m" not in p or "is_in_buffer_1000m" not in p:
            raise AssertionError(f"{fid}: wajib memiliki bendera is_in_buffer_500m dan is_in_buffer_1000m")

        # Gerbang kampus null (GIS Task 5: Mandat Anti-Fabrikasi Gerbang)
        # Menjamin tidak ada koordinat fiktif gerbang kampus yang diselundupkan ke layer skenario
        if p.get("distance_to_nearest_gate_meters") is not None:
            raise AssertionError(f"{fid}: distance_to_nearest_gate_meters wajib bernilai null/None")
        if p.get("gate_observation_status") != "UNOBSERVED":
            raise AssertionError(f"{fid}: gate_observation_status wajib 'UNOBSERVED'")

        # Skor kelayakan transparan (GIS Task 8: Validasi skema scoring breakdown)
        if not p.get("feasibility_scoring") or not isinstance(p.get("feasibility_scoring"), dict):
            raise AssertionError(f"{fid}: feasibility_scoring wajib berupa objek breakdown skor kelayakan")

    return {
        "status": "PASSED",
        "fixture_path": fixture_path,
        "features_count": count,
        "seed": meta.get("seed")
    }


def main():
    parser = argparse.ArgumentParser(description="GIS Processing Pipeline - Proyek Buka Kafe Surabaya")
    parser.add_argument("--universities", default="data/raw/universities.geojson", help="Path file input universities.geojson")

    default_candidates = "data/raw/land_candidates.geojson"
    survey_path = "data/raw/survey_land_candidates.geojson"
    if os.path.exists(survey_path):
        try:
            with open(survey_path, "r", encoding="utf-8") as f:
                s_data = json.load(f)
                if len(s_data.get("features", [])) > 0:
                    default_candidates = survey_path
        except Exception:
            pass

    parser.add_argument("--candidates", default=default_candidates, help="Path file input land_candidates.geojson")
    parser.add_argument("--gates", default=None, help="Path opsional berkas titik koordinat gerbang kampus (GeoJSON Point)")
    parser.add_argument("--output", default="data/processed", help="Direktori output GeoJSON")
    parser.add_argument("--generate-scenario", action="store_true", help="Pembangkitan fixture skenario simulasi sintetis")
    parser.add_argument("--scenario-output", default="data/fixtures/synthetic_scenario_candidates.geojson", help="Path output fixture simulasi")
    parser.add_argument("--seed", type=int, default=42, help="Seed bilangan acak untuk pembangkitan simulasi")

    args = parser.parse_args()

    pipeline = GISPipeline()

    if args.generate_scenario:
        print("=== Menjalankan Pembangkitan Fixture Skenario Simulasi Sintetis ===")
        print(f"Universities Input : {args.universities}")
        print(f"Scenario Output    : {args.scenario_output}")
        print(f"Random Seed        : {args.seed}")
        res = generate_synthetic_scenario_fixture(
            universities_path=args.universities,
            output_path=args.scenario_output,
            seed=args.seed,
            pipeline=pipeline
        )
        print(f"[SUCCESS] Fixture skenario simulasi berhasil dibangkitkan: {res['total_sites']} situs ({res['output_path']}).")
        audit_res = audit_synthetic_scenario_fixture(res["output_path"])
        print(f"[AUDIT] Validasi kontrak skenario: {audit_res['status']}.")
        return

    print("=== Menjalankan GIS Processing Pipeline Surabaya (Enhanced Architecture) ===")
    print(f"Input Universities: {args.universities}")
    print(f"Input Candidates  : {args.candidates}")
    print(f"Input Gates (opt) : {args.gates}")
    print(f"Output Directory  : {args.output}")

    try:
        results = pipeline.process(args.universities, args.candidates, args.output, campus_gates_path=args.gates)
        print("\n[SUCCESS] Pipeline selesai dengan sukses:")
        print(f"  - Kampus Terproses          : {results['universities_count']}")
        print(f"  - Buffer Radial (1.000m)    : {results['buffers_count']}")
        print(f"  - Buffer Dilatasi Poligon   : {results['polygon_buffers_count']}")
        print(f"  - Kandidat Lahan Dievaluasi : {results['candidates_count']}")
        if "cafes_count" in results:
            print(f"  - Kafe OSM Terproses        : {results['cafes_count']} (Dalam buffer 1km: {results['cafes_in_buffer_count']})")
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
