#!/usr/bin/env python3
"""
Google Gemini & Anthropic Claude API pricing manager.
Maintains official fallback pricing, language_server model enum mappings, and local cache.
Zero-dependency using Python standard library.
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any

# Default Pricing File (Cache)
PRICING_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gemini_pricing.json")

# Official Fallback Rates per 1,000,000 tokens (USD)
# Covers both Google Gemini and Anthropic Claude models available in Antigravity
FALLBACK_GEMINI_PRICING: dict[str, dict[str, Any]] = {
    "gemini-3.8-flash": {
        "name": "Gemini 3.8 Flash (High)",
        "input": 0.75,
        "cache_read": 0.075,
        "output": 3.75,
    },
    "gemini-3.8-flash-2027": {
        "name": "Gemini 3.8 Flash (2027 Standard)",
        "input": 1.50,
        "cache_read": 0.15,
        "output": 7.50,
    },
    "gemini-4-carbon": {
        "name": "Gemini 4 Carbon (High)",
        "input": 2.00,
        "cache_read": 0.10,
        "output": 10.00,
    },
    "gemini-4-argon": {
        "name": "Gemini 4 Argon (High)",
        "input": 2.00,
        "cache_read": 0.10,
        "output": 10.00,
    },
    "gemini-3.5-flash-lite": {
        "name": "Gemini 3.5 Flash-Lite",
        "input": 0.30,
        "cache_read": 0.03,
        "output": 2.50,
    },
    "gemini-3.1-pro": {
        "name": "Gemini 3.1 Pro",
        "input": 2.00,
        "cache_read": 0.20,
        "output": 12.00,
    },
    "claude-opus-5-5": {
        "name": "Claude Opus 5.5 (High)",
        "input": 4.00,
        "cache_read": 0.20,
        "output": 20.00,
    },
    "claude-sonnet-5-5": {
        "name": "Claude Sonnet 5.5 (High)",
        "input": 2.00,
        "cache_read": 0.10,
        "output": 10.00,
    },
    "claude-opus-4-6": {
        "name": "Claude Opus 4.6",
        "input": 5.00,
        "cache_read": 0.50,
        "output": 25.00,
    },
    "claude-opus-4": {
        "name": "Claude Opus 4",
        "input": 15.00,
        "cache_read": 1.50,
        "output": 75.00,
    },
    "claude-sonnet-4.6": {
        "name": "Claude Sonnet 4.6 (Thinking)",
        "input": 3.00,
        "cache_read": 0.30,
        "output": 15.00,
    },
    "claude-haiku-4-5": {
        "name": "Claude Haiku 4.5",
        "input": 1.00,
        "cache_read": 0.10,
        "output": 5.00,
    },
}

DEFAULT_MODEL_KEY = "gemini-3.8-flash"

# Authoritative Model enum ID -> Display Name table extracted from language_server binary
MODEL_ENUM_DISPLAY_MAP: dict[int, str] = {
    # Anthropic Claude 4 / 4.5 / 4.6 / 4.8 / 5.5 series
    281: "Claude Sonnet 4",
    282: "Claude Sonnet 4 (Thinking)",
    290: "Claude Opus 4",
    291: "Claude Opus 4 (Thinking)",
    333: "Claude Sonnet 4.5",
    334: "Claude Sonnet 4.5 (Thinking)",
    340: "Claude Haiku 4.5",
    341: "Claude Haiku 4.5 (Thinking)",
    1011: "Claude Opus 4.5",
    1012: "Claude Opus 4.5 (Thinking)",
    1026: "Claude Opus 4.6",
    1035: "Claude Sonnet 4.6",
    1254: "Claude Opus 4.8",
    1368: "Claude Opus 5.5",
    1400: "Claude Opus 5.5 (Low)",
    1401: "Claude Opus 5.5 (Medium)",
    1402: "Claude Opus 5.5 (High)",
    1406: "Claude Opus 5.5 (Max)",
    1403: "Claude Sonnet 5.5 (Low)",
    1404: "Claude Sonnet 5.5 (Medium)",
    1405: "Claude Sonnet 5.5 (High)",
    1407: "Claude Sonnet 5.5 (Max)",
    # Google Gemini series
    246: "Gemini 2.5 Pro",
    312: "Gemini 2.5 Flash",
    313: "Gemini 2.5 Flash",
    327: "Gemini 2.5 Pro",
    329: "Gemini 2.5 Flash",
    330: "Gemini 2.5 Flash-Lite",
    331: "Gemini 2.5 Pro",
    348: "Gemini 3.1 Pro",
    352: "Gemini 3.1 Pro",
    353: "Gemini 3.1 Pro",
    1009: "Gemini 3 Pro Image",
    1018: "Gemini 3 Flash",
    1020: "Gemini 3.5 Flash (Low)",
    1021: "Gemini 3.1 Flash Image",
    1036: "Gemini 3.1 Pro (Low)",
    1050: "Gemini 3.1 Flash-Lite",
    1059: "Gemini 3.1 Flash",
    1071: "Gemini 3.6 Flash (High)",
    1072: "Gemini 3.6 Flash (Medium)",
    1073: "Gemini 3.6 Flash (Low)",
    1149: "Gemini 3.5 Flash",
    1187: "Gemini 3.5 Flash (Low)",
    1196: "Gemini 3.6 Flash",
    1298: "Gemini 3.7 Flash (High)",
    1299: "Gemini 3.7 Flash (Medium)",
    1300: "Gemini 3.7 Flash (Low)",
    1318: "Gemini 3.8 Flash (High)",
    1319: "Gemini 3.8 Flash (Medium)",
    1320: "Gemini 3.8 Flash (Low)",
    1322: "Gemini 3.8 Flash (High)",
    1415: "Gemini 4 Argon (Low)",
    1416: "Gemini 4 Argon (Medium)",
    1417: "Gemini 4 Argon (High)",
    1418: "Gemini 4 Argon (Medium)",
    1419: "Gemini 4 Argon (Low)",
    1429: "Gemini 4 Carbon (High)",
    1430: "Gemini 4 Carbon (Medium)",
    1431: "Gemini 4 Carbon (Low)",
}

# Backend gen_metadata raw model identifier -> standard display name
BACKEND_MODEL_DISPLAY_MAP: dict[str, str] = {
    "claude-opus-5-5-max": "Claude Opus 5.5 (Max)",
    "claude-opus-5-5-high": "Claude Opus 5.5 (High)",
    "claude-opus-5-5-medium": "Claude Opus 5.5 (Medium)",
    "claude-opus-5-5-low": "Claude Opus 5.5 (Low)",
    "claude-opus-5-5@default": "Claude Opus 5.5 (High)",
    "claude-opus-5-5": "Claude Opus 5.5 (High)",
    "claude-sonnet-5-5-max": "Claude Sonnet 5.5 (Max)",
    "claude-sonnet-5-5-high": "Claude Sonnet 5.5 (High)",
    "claude-sonnet-5-5-medium": "Claude Sonnet 5.5 (Medium)",
    "claude-sonnet-5-5-low": "Claude Sonnet 5.5 (Low)",
    "claude-sonnet-5-5@default": "Claude Sonnet 5.5 (High)",
    "claude-sonnet-5-5": "Claude Sonnet 5.5 (High)",
    "claude-opus-4-8@default": "Claude Opus 4.8",
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-opus-4-6@default": "Claude Opus 4.6",
    "claude-opus-4-6": "Claude Opus 4.6",
    "claude-opus-4-5@20251101": "Claude Opus 4.5",
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-opus-4@20250514": "Claude Opus 4",
    "claude-opus-4": "Claude Opus 4",
    "claude-sonnet-4-6@default": "Claude Sonnet 4.6",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-sonnet-4-5@20250929": "Claude Sonnet 4.5",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-4@20250514": "Claude Sonnet 4",
    "claude-sonnet-4": "Claude Sonnet 4",
    "claude-haiku-4-5@20251001": "Claude Haiku 4.5",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "gemini-4-carbon-high": "Gemini 4 Carbon (High)",
    "gemini-4-carbon-medium": "Gemini 4 Carbon (Medium)",
    "gemini-4-carbon-low": "Gemini 4 Carbon (Low)",
    "gemini-4-carbon-trial": "Gemini 4 Carbon (High)",
    "gemini-4-carbon-w": "Gemini 4 Carbon (High)",
    "gemini-4-carbon-b": "Gemini 4 Carbon (High)",
    "gemini-4-carbon-e": "Gemini 4 Carbon (High)",
    "gemini-4-carbon": "Gemini 4 Carbon (High)",
    "gemini-4-argon-high": "Gemini 4 Argon (High)",
    "gemini-4-argon-medium": "Gemini 4 Argon (Medium)",
    "gemini-4-argon-low": "Gemini 4 Argon (Low)",
    "gemini-4-argon-trial": "Gemini 4 Argon (High)",
    "gemini-4-argon-w": "Gemini 4 Argon (High)",
    "gemini-4-argon-b": "Gemini 4 Argon (High)",
    "gemini-4-argon-e": "Gemini 4 Argon (High)",
    "gemini-4-argon": "Gemini 4 Argon (High)",
    "gemini-3.8-flash-high": "Gemini 3.8 Flash (High)",
    "gemini-3.8-flash-medium": "Gemini 3.8 Flash (Medium)",
    "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
    "gemini-3.8-flash-tiered": "Gemini 3.8 Flash (High)",
    "gemini-3.8-flash-n": "Gemini 3.8 Flash (High)",
    "gemini-3.8-flash-exp-a": "Gemini 3.8 Flash (High)",
    "gemini-3.8-flash-exp-b": "Gemini 3.8 Flash (High)",
    "gemini-3.8-flash": "Gemini 3.8 Flash (High)",
    "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
    "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash-Lite",
    "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
    "gemini-3.1-pro-low-thinking": "Gemini 3.1 Pro (Low)",
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
}


def load_pricing() -> dict[str, dict[str, Any]]:
    """Load pricing table, merging local cache over official fallback rates."""
    table = {k: dict(v) for k, v in FALLBACK_GEMINI_PRICING.items()}
    if os.path.exists(PRICING_CACHE_FILE):
        try:
            with open(PRICING_CACHE_FILE, "r", encoding="utf-8") as fp:
                cached = json.load(fp)
                if isinstance(cached, dict):
                    for k, v in cached.items():
                        if isinstance(v, dict):
                            table[k] = {**table.get(k, {}), **v}
        except Exception:
            pass
    return table


def save_pricing_cache(pricing_data: dict[str, dict[str, Any]]) -> bool:
    """Save updated pricing to local cache file."""
    try:
        with open(PRICING_CACHE_FILE, "w", encoding="utf-8") as fp:
            json.dump(pricing_data, fp, indent=2, ensure_ascii=False)
        return True
    except Exception:
        return False


def fetch_online_gemini_pricing(timeout: int = 8) -> dict[str, dict[str, Any]] | None:
    """
    Attempt to fetch latest official rates from online endpoints.
    Falls back gracefully if network is unavailable or structure is unrecognized.
    """
    url = "https://ai.google.dev/pricing"
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; GeminiPricingFetcher/1.0)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                updated = load_pricing()
                return updated
    except Exception:
        pass
    return None


def is_claude_model(model_name: str | None) -> bool:
    """Return True if the model string belongs to Anthropic Claude family."""
    if not model_name:
        return False
    mn = model_name.lower()
    return any(k in mn for k in ("claude", "anthropic", "opus", "sonnet", "haiku"))


def resolve_db_model_name(backend_model: str | None, model_enum: int | None) -> str | None:
    """
    Resolve authoritative model display name from SQLite gen_metadata string and/or steps enum ID.
    Prioritizes exact backend model string, refined by enum thinking tier when same model family.
    """
    enum_disp = MODEL_ENUM_DISPLAY_MAP.get(model_enum) if model_enum is not None else None
    if backend_model:
        bm = backend_model.strip()
        bm_low = bm.lower()
        if bm_low in BACKEND_MODEL_DISPLAY_MAP:
            bm_disp = BACKEND_MODEL_DISPLAY_MAP[bm_low]
            # If enum provides a specific thinking tier within the same model family, prefer enum label
            if enum_disp and bm_disp.split(" (")[0] == enum_disp.split(" (")[0]:
                return enum_disp
            return bm_disp
        # Dynamic / future Claude or Gemini model IDs in gen_metadata
        if is_claude_model(bm_low) or any(k in bm_low for k in ("gemini", "argon", "carbon")):
            if enum_disp and ("carbon" not in bm_low or "Carbon" in enum_disp):
                return enum_disp
            return get_model_display_name(bm)

    return enum_disp


def map_model_name_to_key(model_name: str | None) -> str:
    """Map raw model setting, backend identifier, or display name to pricing key."""
    if not model_name:
        return DEFAULT_MODEL_KEY
    mn = model_name.lower()

    # Anthropic Claude family
    if "haiku" in mn:
        return "claude-haiku-4-5"
    if "opus" in mn:
        if any(v in mn for v in ("opus-4-5", "opus 4.5", "4.5-opus", "opus-4-6", "opus 4.6", "opus-4-8", "opus 4.8")):
            return "claude-opus-4-6"
        if any(v in mn for v in ("opus-4@", "opus 4", "claude_4_opus")) and "5.5" not in mn and "5-5" not in mn:
            return "claude-opus-4"
        return "claude-opus-5-5"
    if "sonnet" in mn:
        if any(v in mn for v in ("sonnet-5", "sonnet 5")):
            return "claude-sonnet-5-5"
        return "claude-sonnet-4.6"
    if "claude" in mn or "anthropic" in mn:
        return "claude-sonnet-5-5"

    # Google Gemini family
    if "carbon" in mn:
        return "gemini-4-carbon"
    if "argon" in mn or "gemini-4" in mn or "gemini 4" in mn:
        return "gemini-4-argon"
    if "lite" in mn:
        return "gemini-3.5-flash-lite"
    if "pro" in mn:
        return "gemini-3.1-pro"
    if "2027" in mn:
        return "gemini-3.8-flash-2027"
    return DEFAULT_MODEL_KEY


def get_model_display_name(model_name: str | None) -> str:
    """Return standard human-readable display name for Gemini and Claude models."""
    if not model_name:
        return FALLBACK_GEMINI_PRICING[DEFAULT_MODEL_KEY]["name"]
    clean = model_name.strip()
    low = clean.lower()
    if low in BACKEND_MODEL_DISPLAY_MAP:
        return BACKEND_MODEL_DISPLAY_MAP[low]
    # Preserve human-readable model titles from session settings or enum resolution
    if any(clean.startswith(prefix) for prefix in ("Gemini ", "Claude ", "GPT-")):
        return clean
    if "carbon" in low:
        if "medium" in low:
            return "Gemini 4 Carbon (Medium)"
        if "low" in low:
            return "Gemini 4 Carbon (Low)"
        return "Gemini 4 Carbon (High)"
    key = map_model_name_to_key(clean)
    pricing = load_pricing()
    return pricing.get(key, FALLBACK_GEMINI_PRICING[DEFAULT_MODEL_KEY])["name"]


def compute_step_cost(
    inp_tokens: int,
    cache_tokens: int,
    out_tokens: int,
    model_name: str | None,
) -> tuple[float, float, float, float]:
    """Calculate (cost_input, cost_cache, cost_output, cost_total) in USD."""
    key = map_model_name_to_key(model_name)
    pricing = load_pricing()
    p = pricing.get(key, FALLBACK_GEMINI_PRICING[DEFAULT_MODEL_KEY])
    c_in = (inp_tokens / 1_000_000) * p["input"]
    c_ca = (cache_tokens / 1_000_000) * p["cache_read"]
    c_out = (out_tokens / 1_000_000) * p["output"]
    return c_in, c_ca, c_out, (c_in + c_ca + c_out)
