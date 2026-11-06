#!/usr/bin/env python3
"""
Terminal and Markdown table formatting utilities with East Asian character support.
Zero-dependency using Python standard library.
"""

from __future__ import annotations

import unicodedata
from typing import Any


def display_width(text: Any) -> int:
    """Calculate terminal display width considering East Asian Fullwidth characters."""
    return sum(2 if unicodedata.east_asian_width(c) in ("F", "W") else 1 for c in str(text))


def pad_text(text: Any, width: int, align: str = "left") -> str:
    """Pad string to exact terminal display width."""
    s = str(text)
    pad = max(0, width - display_width(s))
    return s + (" " * pad) if align == "left" else (" " * pad) + s


def format_token_unit(n: int | float) -> str:
    """Format token count into compact human-readable unit (e.g. 1.25M, 350.2K)."""
    val = float(n)
    abs_val = abs(val)
    if abs_val >= 1_000_000_000:
        return f"{val / 1_000_000_000:.2f}M" if abs_val < 1_000_000_000 else f"{val / 1_000_000_000:.2f}B"
    elif abs_val >= 1_000_000:
        return f"{val / 1_000_000:.2f}M"
    elif abs_val >= 1_000:
        return f"{val / 1_000:.1f}K"
    else:
        return f"{int(val)}"


def format_token_dual(n: int | float) -> str:
    """Format token count with both exact raw integer and human-readable unit, e.g. '44,890,997 (44.89M)'."""
    num_int = int(n)
    unit_str = format_token_unit(num_int)
    if abs(num_int) >= 1_000:
        return f"{num_int:,} ({unit_str})"
    return f"{num_int:,}"


def format_table(
    headers: list[str],
    rows: list[list[Any]],
    alignments: list[str] | None = None,
) -> str:
    """Render perfectly aligned Markdown/terminal table with full East Asian character support."""
    if not rows and not headers:
        return ""
    if not alignments:
        alignments = ["left"] + ["right"] * (len(headers) - 1)

    col_widths = [display_width(h) for h in headers]
    for r in rows:
        for i, val in enumerate(r):
            if i < len(col_widths):
                col_widths[i] = max(col_widths[i], display_width(val))

    header_cells = [pad_text(h, col_widths[i], alignments[i]) for i, h in enumerate(headers)]
    header_line = "| " + " | ".join(header_cells) + " |"

    sep_cells = [
        (":" + "-" * (col_widths[i] - 1)) if alignments[i] == "left" else ("-" * (col_widths[i] - 1) + ":")
        for i in range(len(headers))
    ]
    separator_line = "| " + " | ".join(sep_cells) + " |"

    data_lines = []
    for r in rows:
        cells = [pad_text(val, col_widths[i], alignments[i]) for i, val in enumerate(r)]
        data_lines.append("| " + " | ".join(cells) + " |")

    return "\n".join([header_line, separator_line] + data_lines)
