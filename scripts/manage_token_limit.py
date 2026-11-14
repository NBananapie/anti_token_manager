#!/usr/bin/env python3
"""
Antigravity Context Token Limit Manager CLI
Configures max_token_limit thresholds (128K, 256K, 320K, 384K, 512K, 768K, 1M) for language_server.
Supports updating all models simultaneously or targeting specific model groups
(Flash, Argon, Carbon, Hydrogen, Orchestrator).
Cross-platform compatible: macOS (ARM64) and Windows (x86_64).
Zero-dependency using Python standard library.
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import struct
import subprocess
import sys

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

# Model-specific exact strategy key prefixes in language_server binary (.rdata snapshotmendelfp JSON).
# Anchored on '"CASCADE_USE_EXPERIMENT_CHECKPOINTER": "' so 'CASCADE_USE_EXPERIMENT_CHECKPOINTER/claude-1m_840k'
# is never matched or overwritten.
FLASH_PREFIX = rb'"CASCADE_USE_EXPERIMENT_CHECKPOINTER": "{\n    \"strategy\": \"CHECKPOINT_STRATEGY_SINGLE_PROMPT\",\n    \"max_token_limit\"'
ARGON_PREFIX = rb'"CASCADE_USE_EXPERIMENT_CHECKPOINTER": "{\n    \"strategy\": \"CHECKPOINT_STRATEGY_SAME_MODEL\",\n    \"max_token_limit\"'

# Profile-anchored prefixes inside snapshotmendelfp.model_profiles:
# - M124: Gemini 3.8 Flash (M317..M322 -> M124)
# - M400: Claude Opus/Sonnet 5.5 base slot (M400..M405 -> M400)
# - M408: Static Gemini 4 Argon / Carbon slots (M408..M431 -> M408)
# Note: Cloud-pushed models not in snapshotmendelfp.models — including Gemini 4 Hydrogen
# (Low/Medium/High/XHigh), Orchestrator (Carbon / Argon), and Gemini 4 Carbon (M427) —
# bypass JSON slots and inherit the machine-code baseline in utils.GetCheckpointConfig (Pattern 1 & 2),
# clamped safely at runtime by ClampCheckpointConfigForModelInfo to min(limit, MaxTokens - reserve).
M124_FLASH38_PREFIX = (
    b'"MODEL_PLACEHOLDER_M124": {\n      ' + ARGON_PREFIX
)
M400_CLAUDE_PREFIX = (
    b'"MODEL_PLACEHOLDER_M400": {\n      ' + ARGON_PREFIX
)
M408_GEMINI4_PREFIX = (
    b'"MODEL_PLACEHOLDER_M408": {\n      ' + ARGON_PREFIX
)
M432_PREFIX = (
    b'"MODEL_PLACEHOLDER_M432": {\n      ' + ARGON_PREFIX
)
M667_PREFIX = (
    b'"MODEL_PLACEHOLDER_M667": {\n      ' + ARGON_PREFIX
)
SLOT_BYTE_LEN = 12

# Note on 1M context window models ('1m' / '840k'):
# ValidateCheckpointConfig (0x1827600) enforces:
#   config.MaxTokenLimit <= plannerModel.MaxTokens - plannerModel.MaxOutputTokens
# where MaxTokens is 1,000,000 (or 1,048,576) and MaxOutputTokens is 65,536 (or 128,000 -> max allowed 872,000 / 934,464).
# Setting MaxTokenLimit to raw 1,000,000 fails ValidateCheckpointConfig and leaves zero room for single-turn tool growth
# + checkpoint summary output. Following Google's built-in 'claude-1m_840k' profile, '1m' (and '840k') sets
# max_token_limit to 840,000 (840K), leaving 160K tokens for MaxOutputTokens (65,536) and in-step tool output.
SUPPORTED_LIMITS: dict[str, bytes] = {
    "128k": b"128000",
    "256k": b"256000",
    "320k": b"320000",
    "384k": b"384000",
    "512k": b"512000",
    "768k": b"768000",
    "840k": b"840000",
    "1m": b"840000",
}

SUPPORTED_LIMITS_INT: dict[str, int] = {
    "128k": 128000,
    "256k": 256000,
    "320k": 320000,
    "384k": 384000,
    "512k": 512000,
    "768k": 768000,
    "840k": 840000,
    "1m": 840000,
}

TRIGGER_THRESHOLDS: dict[str, str] = {
    "128k": "128,000 tokens (100% max_token_limit)",
    "256k": "256,000 tokens (100% max_token_limit)",
    "320k": "320,000 tokens (100% max_token_limit)",
    "384k": "384,000 tokens (100% max_token_limit)",
    "512k": "512,000 tokens (100% max_token_limit)",
    "768k": "768,000 tokens (100% max_token_limit)",
    "840k": "840,000 tokens (1M-Window Safe Cap, 160K reserved)",
    "1m": "840,000 tokens (1M-Window Safe Cap, 160K reserved)",
    "1m (840k)": "840,000 tokens (1M-Window Safe Cap, 160K reserved)",
}

VALUE_TO_LABEL: dict[bytes, str] = {
    b"128000": "128K",
    b"256000": "256K",
    b"320000": "320K",
    b"384000": "384K",
    b"512000": "512K",
    b"768000": "768K",
    b"840000": "1M (840K)",
}

INT_TO_LABEL: dict[int, str] = {
    128000: "128K",
    256000: "256K",
    320000: "320K",
    384000: "384K",
    512000: "512K",
    768000: "768K",
    840000: "1M (840K)",
}

# ---------------------------------------------------------------------------
# x86_64 Machine Code Signatures for Hardcoded Context Clamp (Windows / Linux)
# ---------------------------------------------------------------------------
# Pattern 1: Dynamic Clamp in single_prompt / checkpoint strategy evaluation
# mov edx, [rsp+0x4c]; cmp edx, <LIMIT>; mov esi, <LIMIT>; cmovb esi, edx; mov [rsp+0x50], esi; mov edx, [rsp+0x5c]
X86_CLAMP_P1_PREFIX = b"\x8b\x54\x24\x4c\x81\xfa"
X86_CLAMP_P1_MID = b"\xbe"
X86_CLAMP_P1_SUFFIX_CMOVB = b"\x0f\x42\xf2\x89\x74\x24\x50\x8b\x54\x24\x5c"
X86_CLAMP_P1_SUFFIX_NOP = b"\x90\x90\x90\x89\x74\x24\x50\x8b\x54\x24\x5c"
X86_CLAMP_P1_SUFFIX = X86_CLAMP_P1_SUFFIX_CMOVB

# Pattern 2: Fallback default write to checkpointConfig.MaxTokenLimit (offset 0x0c)
# cmp dword ptr [rdx+0x14], 0; jg +7; mov dword ptr [rax+0x0c], <LIMIT>; xor ebx, ebx; xor ecx, ecx
X86_CLAMP_P2_PREFIX = b"\x83\x7a\x14\x00\x7f\x07\xc7\x40\x0c"
X86_CLAMP_P2_SUFFIX = b"\x31\xdb\x31\xc9"

# Pattern 3: Cloud MendelStateCache GetProto override in (*overlayFeatureProvider).GetProto
# test bl, bl; je +0x29 (74 29 -> eb 29); mov rdx, [rsp+0x38]; mov r8, [rdx+0x10]; mov rax, [rdx+0x18]; mov rdx, [r8+0x38]
X86_OVERLAY_P3_PREFIX = b"\x84\xdb"
X86_OVERLAY_P3_JE = b"\x74\x29"
X86_OVERLAY_P3_JMP = b"\xeb\x29"
X86_OVERLAY_P3_SUFFIX = b"\x48\x8b\x54\x24\x38\x4c\x8b\x42\x10\x48\x8b\x42\x18\x49\x8b\x50\x38"

# Pattern 4: (*snapshotFallbackFactory).NewProvider HasNoCCPAAccess check bypass
# Legacy build: mov rdx, [rax+0x28]; mov rax, [rdx]; call rax; test al, al; je +0x57 (74 57 -> 90 90); mov rdx, [rsp+0x40]; mov rsi, [rdx+0x10]
# Newer build:  mov rdx, [rax+0x38]; mov rax, [rdx]; call rax; test al, al; je +0x87 (0f 84 87 00 00 00 -> 6x 90); mov rax, [rsp+0x50]; mov rdx, [rax+0x40]; mov rcx, [rdx]
X86_FALLBACK_P4_PREFIX = b"\x48\x8b\x50\x28\x48\x8b\x02\xff\xd0\x84\xc0"
X86_FALLBACK_P4_JE = b"\x74\x57"
X86_FALLBACK_P4_NOP = b"\x90\x90"
X86_FALLBACK_P4_SUFFIX = b"\x48\x8b\x54\x24\x40\x48\x8b\x72\x10"

X86_FALLBACK_P4_VARIANTS: tuple[tuple[bytes, bytes, bytes, bytes], ...] = (
    (
        b"\x48\x8b\x50\x38\x48\x8b\x02\xff\xd0\x84\xc0",
        b"\x0f\x84\x87\x00\x00\x00",
        b"\x90\x90\x90\x90\x90\x90",
        b"\x48\x8b\x44\x24\x50\x48\x8b\x50\x40\x48\x8b\x0a",
    ),
    (
        X86_FALLBACK_P4_PREFIX,
        X86_FALLBACK_P4_JE,
        X86_FALLBACK_P4_NOP,
        X86_FALLBACK_P4_SUFFIX,
    ),
)


def get_default_paths() -> tuple[str, str]:
    """Detect default target and backup paths based on operating system."""
    if IS_WINDOWS:
        local_appdata = os.environ.get("LOCALAPPDATA", os.path.expanduser(os.path.join("~", "AppData", "Local")))
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        candidates = [
            os.path.join(local_appdata, "Programs", "antigravity", "resources", "bin", "language_server.exe"),
            os.path.join(local_appdata, "Programs", "Antigravity", "resources", "bin", "language_server.exe"),
            os.path.join(local_appdata, "Programs", "Antigravity", "resources", "app", "bin", "language_server.exe"),
            os.path.join(local_appdata, "Antigravity", "bin", "language_server.exe"),
            os.path.join(program_files, "Antigravity", "resources", "app", "bin", "language_server.exe"),
        ]
        for c in candidates:
            if os.path.exists(c):
                return c, c + ".backup_128k"
        return candidates[0], candidates[0] + ".backup_128k"
    else:
        target = "/Applications/Antigravity.app/Contents/Resources/bin/language_server"
        backup = target + ".backup_128k"
        return target, backup


def is_process_running(proc_name: str = "language_server") -> bool:
    """Check if target process is currently running across Windows and POSIX."""
    try:
        if IS_WINDOWS:
            target_exe = proc_name if proc_name.endswith(".exe") else f"{proc_name}.exe"
            res = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {target_exe}", "/NH"],
                capture_output=True,
                text=True,
            )
            return res.returncode == 0 and target_exe.lower() in res.stdout.lower()
        else:
            res = subprocess.run(["pgrep", "-f", proc_name], capture_output=True, text=True)
            return res.returncode == 0 and bool(res.stdout.strip())
    except Exception:
        return False


def verify_codesign(file_path: str) -> tuple[bool, str]:
    """Verify codesign status (macOS only; skipped on Windows)."""
    if not IS_MACOS:
        return True, "Skipped (Non-macOS environment does not require code signature)"
    try:
        res = subprocess.run(["codesign", "-v", file_path], capture_output=True, text=True)
        if res.returncode == 0:
            return True, "Valid"
        err = res.stderr.strip() or "Signature mismatch"
        return False, f"Invalid ({err})"
    except Exception as e:
        return False, f"Verification error: {e}"


def _extract_slot_digits(slot: bytes) -> bytes | None:
    """Extract 6-digit or 7-digit ASCII token limit from a 12-byte JSON slot."""
    if len(slot) != SLOT_BYTE_LEN:
        return None
    if slot.startswith(rb': \"') and slot.endswith(rb'\"'):
        return slot[4:10]
    if slot.startswith(rb':\"') and slot.endswith(rb'\"'):
        return slot[3:10]
    return None


def _encode_slot_digits(val_bytes: bytes) -> bytes:
    """Encode 6-digit or 7-digit ASCII token limit into an exact 12-byte JSON slot."""
    if len(val_bytes) == 6:
        return rb': \"' + val_bytes + rb'\"'
    if len(val_bytes) == 7:
        return rb':\"' + val_bytes + rb'\"'
    raise ValueError(f"Unsupported token limit byte length: {len(val_bytes)}")


def inspect_model_values(data: bytes, prefix: bytes) -> tuple[str, int]:
    """Inspect current 12-byte token limit slot and occurrence count for a given prefix."""
    pos = 0
    values: set[bytes] = set()
    count = 0
    while True:
        idx = data.find(prefix, pos)
        if idx == -1:
            break
        val_start = idx + len(prefix)
        slot = data[val_start : val_start + SLOT_BYTE_LEN]
        val = _extract_slot_digits(slot)
        if val is None:
            pos = val_start + SLOT_BYTE_LEN
            continue
        values.add(val)
        count += 1
        pos = val_start + SLOT_BYTE_LEN

    if not values:
        return "Not found", 0
    if len(values) == 1:
        v = next(iter(values))
        return VALUE_TO_LABEL.get(v, v.decode("ascii", errors="ignore")), count
    return "Mixed (" + ", ".join(VALUE_TO_LABEL.get(v, v.decode("ascii", errors="ignore")) for v in values) + ")", count


def replace_model_limit(data: bytes, prefix: bytes, new_val: bytes) -> tuple[bytes, int]:
    """Replace 12-byte token limit slot following the exact model prefix in-place."""
    pos = 0
    count = 0
    out = bytearray(data)
    new_slot = _encode_slot_digits(new_val)
    while True:
        idx = out.find(prefix, pos)
        if idx == -1:
            break
        val_start = idx + len(prefix)
        slot = bytes(out[val_start : val_start + SLOT_BYTE_LEN])
        val = _extract_slot_digits(slot)
        if val is None:
            pos = val_start + SLOT_BYTE_LEN
            continue
        out[val_start : val_start + SLOT_BYTE_LEN] = new_slot
        count += 1
        pos = val_start + SLOT_BYTE_LEN
    return bytes(out), count


def inspect_binary_clamp(data: bytes) -> tuple[str, list[int], str, bool]:
    """
    Inspect the status of machine-code hardcoded context clamp across architectures.
    Returns: (status_label, values_list, architecture_name, is_unclamped)
    """
    values: list[int] = []
    is_unclamped = False

    # 1. Check x86_64 Pattern 1 (Dynamic clamp cmp & mov)
    idx1 = data.find(X86_CLAMP_P1_PREFIX)
    if idx1 != -1:
        v1_start = idx1 + len(X86_CLAMP_P1_PREFIX)
        v1_end = v1_start + 4
        mid = data[v1_end : v1_end + len(X86_CLAMP_P1_MID)]
        v2_start = v1_end + len(X86_CLAMP_P1_MID)
        v2_end = v2_start + 4
        suffix = data[v2_end : v2_end + len(X86_CLAMP_P1_SUFFIX_CMOVB)]
        if mid == X86_CLAMP_P1_MID:
            if suffix == X86_CLAMP_P1_SUFFIX_NOP:
                is_unclamped = True
                v1 = struct.unpack("<I", data[v1_start:v1_end])[0]
                v2 = struct.unpack("<I", data[v2_start:v2_end])[0]
                values.extend([v1, v2])
            elif suffix == X86_CLAMP_P1_SUFFIX_CMOVB:
                v1 = struct.unpack("<I", data[v1_start:v1_end])[0]
                v2 = struct.unpack("<I", data[v2_start:v2_end])[0]
                values.extend([v1, v2])

    # Check x86_64 Pattern 2 (Default write)
    idx2 = data.find(X86_CLAMP_P2_PREFIX)
    if idx2 != -1:
        v3_start = idx2 + len(X86_CLAMP_P2_PREFIX)
        v3_end = v3_start + 4
        suffix2 = data[v3_end : v3_end + len(X86_CLAMP_P2_SUFFIX)]
        if suffix2 == X86_CLAMP_P2_SUFFIX:
            v3 = struct.unpack("<I", data[v3_start:v3_end])[0]
            values.append(v3)

    if values:
        unique_vals = set(values)
        if len(unique_vals) == 1:
            lbl = INT_TO_LABEL.get(next(iter(unique_vals)), f"{next(iter(unique_vals))}")
            return lbl, values, "x86_64", is_unclamped
        labels = [INT_TO_LABEL.get(v, f"{v}") for v in unique_vals]
        return "Mixed (" + ", ".join(labels) + ")", values, "x86_64", is_unclamped

    return "Not found", [], "unknown", False


def _find_fallback_p4(data: bytes | bytearray) -> tuple[int, bytes, bytes, bytes] | None:
    """Locate (*snapshotFallbackFactory).NewProvider HasNoCCPAAccess branch across supported builds."""
    for prefix, je_bytes, nop_bytes, suffix in X86_FALLBACK_P4_VARIANTS:
        idx = data.find(prefix + je_bytes + suffix)
        if idx != -1:
            return idx + len(prefix), je_bytes, nop_bytes, je_bytes
        idx = data.find(prefix + nop_bytes + suffix)
        if idx != -1:
            return idx + len(prefix), je_bytes, nop_bytes, nop_bytes
    return None


def inspect_mendel_overlay_details(data: bytes) -> tuple[bool, bool, bool, bool]:
    """
    Inspect (*overlayFeatureProvider).GetProto (P3) and (*snapshotFallbackFactory).NewProvider (P4)
    cloud MendelStateCache override status.
    Returns: (p3_found, p3_bypassed, p4_found, p4_bypassed)
    """
    pat3_je = X86_OVERLAY_P3_PREFIX + X86_OVERLAY_P3_JE + X86_OVERLAY_P3_SUFFIX
    pat3_jmp = X86_OVERLAY_P3_PREFIX + X86_OVERLAY_P3_JMP + X86_OVERLAY_P3_SUFFIX

    p3_bypassed = data.find(pat3_jmp) != -1
    p3_found = p3_bypassed or (data.find(pat3_je) != -1)

    p4_match = _find_fallback_p4(data)
    p4_found = p4_match is not None
    p4_bypassed = p4_match is not None and p4_match[3] == p4_match[2]
    return p3_found, p3_bypassed, p4_found, p4_bypassed


def inspect_mendel_overlay(data: bytes) -> tuple[bool, bool]:
    """
    Inspect (*overlayFeatureProvider).GetProto and (*snapshotFallbackFactory).NewProvider
    cloud MendelStateCache override status.
    Returns: (pattern_found, is_bypassed)
    """
    p3_found, p3_bypassed, p4_found, p4_bypassed = inspect_mendel_overlay_details(data)
    return (p3_found or p4_found), (p3_found and p4_found and p3_bypassed and p4_bypassed)


def replace_binary_clamp(data: bytes, limit_key: str, restore_overlay: bool = False) -> tuple[bytes, int, str]:
    """
    Patch hardcoded binary clamp thresholds in machine code to match desired limit.
    Bypasses cmovb down-clamping for limits > 256K and bypasses cloud Mendel GetProto
    and snapshotFallbackFactory HasNoCCPAAccess checks so local snapshotmendelfp JSON
    limits take effect at runtime.
    Returns: (modified_bytes, replaced_count, architecture_name)
    """
    target_int = SUPPORTED_LIMITS_INT.get(limit_key.lower())
    if target_int is None:
        return data, 0, "unknown"

    target_bytes = struct.pack("<I", target_int)
    out = bytearray(data)
    count = 0
    desired_unclamped = target_int > 256000
    target_suffix = X86_CLAMP_P1_SUFFIX_NOP if desired_unclamped else X86_CLAMP_P1_SUFFIX_CMOVB

    # 1. Patch x86_64 Pattern 1
    idx1 = out.find(X86_CLAMP_P1_PREFIX)
    if idx1 != -1:
        v1_start = idx1 + len(X86_CLAMP_P1_PREFIX)
        v1_end = v1_start + 4
        mid = out[v1_end : v1_end + len(X86_CLAMP_P1_MID)]
        v2_start = v1_end + len(X86_CLAMP_P1_MID)
        v2_end = v2_start + 4
        suffix = out[v2_end : v2_end + len(X86_CLAMP_P1_SUFFIX_CMOVB)]
        if mid == X86_CLAMP_P1_MID and (suffix == X86_CLAMP_P1_SUFFIX_CMOVB or suffix == X86_CLAMP_P1_SUFFIX_NOP):
            out[v1_start:v1_end] = target_bytes
            out[v2_start:v2_end] = target_bytes
            out[v2_end : v2_end + len(X86_CLAMP_P1_SUFFIX_CMOVB)] = target_suffix
            count += 2

    # 2. Patch x86_64 Pattern 2
    idx2 = out.find(X86_CLAMP_P2_PREFIX)
    if idx2 != -1:
        v3_start = idx2 + len(X86_CLAMP_P2_PREFIX)
        v3_end = v3_start + 4
        suffix2 = out[v3_end : v3_end + len(X86_CLAMP_P2_SUFFIX)]
        if suffix2 == X86_CLAMP_P2_SUFFIX:
            out[v3_start:v3_end] = target_bytes
            count += 1

    # 3. Patch x86_64 Pattern 3: (*overlayFeatureProvider).GetProto cloud Mendel override
    pat_je = X86_OVERLAY_P3_PREFIX + X86_OVERLAY_P3_JE + X86_OVERLAY_P3_SUFFIX
    pat_jmp = X86_OVERLAY_P3_PREFIX + X86_OVERLAY_P3_JMP + X86_OVERLAY_P3_SUFFIX
    idx3 = out.find(pat_je)
    if idx3 == -1:
        idx3 = out.find(pat_jmp)
    if idx3 != -1:
        br_start = idx3 + len(X86_OVERLAY_P3_PREFIX)
        br_end = br_start + 2
        out[br_start:br_end] = X86_OVERLAY_P3_JE if restore_overlay else X86_OVERLAY_P3_JMP
        count += 1

    # 4. Patch x86_64 Pattern 4: (*snapshotFallbackFactory).NewProvider HasNoCCPAAccess check
    p4_match = _find_fallback_p4(out)
    if p4_match is not None:
        br4_start, p4_je, p4_nop, _ = p4_match
        out[br4_start : br4_start + len(p4_je)] = p4_je if restore_overlay else p4_nop
        count += 1

    arch = "x86_64" if count > 0 else "unknown"
    return bytes(out), count, arch


def _is_backup_compatible(target_data: bytes, backup_data: bytes) -> bool:
    """
    Verify that backup_data belongs to the exact same language_server build as target_data.
    Checks exact byte size and immutable executable headers (PE COFF TimeDateStamp / Mach-O header)
    in the first 4096 bytes before .text patch offsets.
    """
    if len(target_data) != len(backup_data) or len(target_data) < 4096:
        return False
    return target_data[:4096] == backup_data[:4096]


def _inspect_slot_int_values(data: bytes, prefix: bytes) -> list[int]:
    """Return integer token limits extracted from all matching JSON slots for prefix."""
    pos = 0
    nums: list[int] = []
    while True:
        idx = data.find(prefix, pos)
        if idx == -1:
            break
        val_start = idx + len(prefix)
        slot = data[val_start : val_start + SLOT_BYTE_LEN]
        val = _extract_slot_digits(slot)
        if val is not None:
            try:
                nums.append(int(val.decode("ascii")))
            except ValueError:
                pass
        pos = val_start + SLOT_BYTE_LEN
    return nums


def _cleanup_stale_old_binaries(target_path: str) -> None:
    """Remove unlocked stale language_server.exe.old* files left from previous online atomic updates."""
    if not IS_WINDOWS:
        return
    for old_file in glob.glob(f"{target_path}.old*"):
        try:
            os.remove(old_file)
        except Exception:
            pass


def check_status(target_path: str, backup_path: str) -> bool:
    """Inspect and report current token limit configuration, model thresholds, clamp status, and signature status."""
    _cleanup_stale_old_binaries(target_path)
    if not os.path.exists(target_path):
        print(f"Error: Target file not found: {target_path}")
        return False

    with open(target_path, "rb") as fp:
        data = fp.read()

    backup_state = "No"
    if os.path.exists(backup_path):
        try:
            with open(backup_path, "rb") as bfp:
                b_head = bfp.read(4096)
            b_size = os.path.getsize(backup_path)
            if b_size == len(data) and len(data) >= 4096 and data[:4096] == b_head:
                backup_state = f"Yes ({backup_path}, build matched)"
            else:
                backup_state = f"Stale ({backup_path}, different binary build — will use safe in-place operations)"
        except Exception:
            backup_state = f"Yes ({backup_path})"

    flash38_val, flash38_count = inspect_model_values(data, M124_FLASH38_PREFIX)
    m408_val, m408_count = inspect_model_values(data, M408_GEMINI4_PREFIX)
    m400_val, m400_count = inspect_model_values(data, M400_CLAUDE_PREFIX)
    m432_val, m432_count = inspect_model_values(data, M432_PREFIX)
    m667_val, m667_count = inspect_model_values(data, M667_PREFIX)
    legacy_flash_val, legacy_flash_count = inspect_model_values(data, FLASH_PREFIX)
    argon_all_val, argon_all_count = inspect_model_values(data, ARGON_PREFIX)
    clamp_status, clamp_vals, clamp_arch, is_unclamped = inspect_binary_clamp(data)
    p3_found, p3_bypassed, p4_found, p4_bypassed = inspect_mendel_overlay_details(data)
    overlay_found = p3_found or p4_found
    overlay_bypassed = p3_found and p4_found and p3_bypassed and p4_bypassed

    line_sep = "=" * 68
    print(line_sep)
    print("Antigravity Language Server Token Limit Status")
    print(line_sep)
    print(f"Platform: {sys.platform} ({clamp_arch})")
    print(f"Target file: {target_path}")
    print(f"File size: {len(data):,} bytes")
    print(f"Backup exists: {backup_state}")

    f38_disp = flash38_val if flash38_count > 0 else legacy_flash_val
    m408_disp = m408_val if m408_count > 0 else argon_all_val
    f38_trig = TRIGGER_THRESHOLDS.get(f38_disp.lower(), "custom threshold")
    m408_trig = TRIGGER_THRESHOLDS.get(m408_disp.lower(), "custom threshold")
    dyn_trig = TRIGGER_THRESHOLDS.get(clamp_status.lower(), "min(clamp, model.MaxTokens - reserve)")

    print("\n1. Static JSON Model Profiles (snapshotmendelfp):")
    if flash38_count > 0:
        print(f"  - Gemini 3.8 Flash (M124):              {flash38_val} ({flash38_count} slot)  -> trigger: {f38_trig}")
    if m408_count > 0:
        print(f"  - Gemini 4 Argon / Carbon (M408):       {m408_val} ({m408_count} slot)  -> trigger: {m408_trig}")
    elif argon_all_count > 0:
        print(f"  - Gemini 4 Same-Model Profiles:         {argon_all_val} ({argon_all_count} slots) -> trigger: {m408_trig}")
    if m400_count > 0:
        print(f"  - Claude Opus / Sonnet 5.5 (M400):      {m400_val} (+ claude-1m_840k variant)")
    if m432_count > 0:
        print(f"  - Model Profile (M432):                 {m432_val} ({m432_count} slot)")
    if m667_count > 0:
        print(f"  - Model Profile (M667):                 {m667_val} ({m667_count} slot)")
    if legacy_flash_count > 0:
        print(f"  - Legacy Gemini 2.5 Flash/Pro:          {legacy_flash_val} ({legacy_flash_count} slots)")

    print("\n2. Dynamic Cloud Models & Modes (utils.GetCheckpointConfig Baseline):")
    if clamp_arch == "x86_64":
        overlay_note = (
            f"{clamp_status} -> trigger: {dyn_trig}"
            if overlay_bypassed
            else "Cloud Mendel Active [WARNING: Cloud MendelStateCache may override to 256K!]"
        )
        print(f"  - Gemini 4 Hydrogen (Low/Med/High/XHigh): {overlay_note}")
        print(f"  - Orchestrator (Carbon / Argon):          {overlay_note}")
        print(f"  - Gemini 4 Carbon (New M427):             {overlay_note}")
    else:
        print(f"  - Dynamic Models Fallback:                {clamp_status}")

    elevated_labels = ("320K", "384K", "512K", "768K", "840K", "1M", "1M (840K)")
    print("\n3. Binary Clamp & Cloud Override Status (Machine Code):")
    if clamp_arch == "x86_64":
        if clamp_status.upper() in elevated_labels:
            unclamp_tag = " [cmovb clamp bypassed; ClampCheckpointConfigForModelInfo safe-guards window]" if is_unclamped else ""
            print(f"  - x86_64 Clamp: {clamp_status} ({len(clamp_vals)} locations patched){unclamp_tag}")
        elif clamp_status.upper() == "256K":
            if f38_disp.upper() in elevated_labels or m408_disp.upper() in elevated_labels:
                print("  - x86_64 Clamp: 256K [WARNING: Hard ceiling clamp active at 256K; will truncate models configured for >256K!]")
            else:
                print("  - x86_64 Clamp: 256K (Official default baseline)")
        else:
            print(f"  - x86_64 Clamp: {clamp_status} (Values: {clamp_vals})")
        if overlay_found:
            if overlay_bypassed:
                print("  - Cloud Mendel Override: Bypassed (eb 29 + P4 nop -> Local config & Pattern 1 authoritative)")
            elif p3_found and p3_bypassed and not p4_found:
                print("  - Cloud Mendel Override: Partial (P3 bypassed, P4 signature not matched in this build) [WARNING: Authenticated sessions may still be overridden!]")
            elif p3_found and p3_bypassed and not p4_bypassed:
                print("  - Cloud Mendel Override: Partial (P3 bypassed, P4 still active) [WARNING: Authenticated sessions may still be overridden!]")
            else:
                print("  - Cloud Mendel Override: Active [WARNING: Cloud MendelStateCache will override local limits to 256K!]")
    else:
        print(f"  - Status: {clamp_status}")

    # Code signature verification
    valid, sign_msg = verify_codesign(target_path)
    print(f"\nCode signature: {sign_msg}")

    # Running process check
    if is_process_running("language_server"):
        print("Process notice: language_server process is currently running. Antigravity must be completely restarted after modifications.")

    print(line_sep)
    return True


def set_token_limit(
    target_path: str,
    backup_path: str,
    limit: str = "256k",
    model: str = "all",
) -> None:
    """
    Set max_token_limit to 128k, 256k, 320k, 384k, 512k, 768k, 840k, or 1m (maps to 840K safe ceiling).
    Can update all models simultaneously or target 'flash', 'argon', 'carbon', 'hydrogen', or 'orchestrator'.
    Protects shared machine-code baseline from accidental downward truncation when updating a single JSON profile.
    """
    _cleanup_stale_old_binaries(target_path)
    limit_key = limit.lower()
    if limit_key not in SUPPORTED_LIMITS:
        print(f"Error: Unsupported limit '{limit}'. Choose from: 128k, 256k, 320k, 384k, 512k, 768k, 840k, 1m.")
        sys.exit(1)

    valid_scopes = ("all", "flash", "argon", "carbon", "hydrogen", "orchestrator")
    model_target = model.lower()
    if model_target not in valid_scopes:
        print(f"Error: Unsupported model scope '{model}'. Choose from: {', '.join(valid_scopes)}.")
        sys.exit(1)

    if not os.path.exists(target_path):
        print(f"Error: Target file not found: {target_path}")
        sys.exit(1)

    # 1. Read target binary first and verify/create build-matched backup
    with open(target_path, "rb") as fp:
        data = fp.read()

    need_backup = not os.path.exists(backup_path)
    if not need_backup:
        try:
            with open(backup_path, "rb") as bfp:
                bdata = bfp.read()
            if not _is_backup_compatible(data, bdata):
                _, cur_clamp_vals, _, cur_unclamped = inspect_binary_clamp(data)
                _, cur_bypassed = inspect_mendel_overlay(data)
                if not cur_unclamped and not cur_bypassed and set(cur_clamp_vals) in ({256000}, set()):
                    print(f"Refreshing stale backup to match updated language_server build: {backup_path} ...")
                    need_backup = True
                else:
                    print("Notice: Existing backup belongs to an older language_server build; preserving current state without overwriting.")
        except Exception:
            pass

    if need_backup:
        print(f"Creating binary backup: {backup_path} ...")
        shutil.copy2(target_path, backup_path)
        print("Backup created successfully.")

    new_val_bytes = SUPPORTED_LIMITS[limit_key]
    target_int = SUPPORTED_LIMITS_INT[limit_key]
    display_lbl = VALUE_TO_LABEL.get(new_val_bytes, limit_key.upper())
    updated_data = data
    summary_messages: list[str] = []

    # 2. Update targeted JSON slots
    if model_target == "all":
        updated_data, c_flash_leg = replace_model_limit(updated_data, FLASH_PREFIX, new_val_bytes)
        updated_data, c_same = replace_model_limit(updated_data, ARGON_PREFIX, new_val_bytes)
        summary_messages.append(
            f"All Static JSON Profiles (Flash 3.8 M124, Argon/Carbon M408, Claude M400, Legacy 2.5): "
            f"updated {c_flash_leg + c_same} slots to {display_lbl}"
        )
    elif model_target == "flash":
        updated_data, c_m124 = replace_model_limit(updated_data, M124_FLASH38_PREFIX, new_val_bytes)
        updated_data, c_leg = replace_model_limit(updated_data, FLASH_PREFIX, new_val_bytes)
        summary_messages.append(
            f"Gemini 3.8 Flash (M124) & Legacy Flash: updated {c_m124 + c_leg} JSON slots to {display_lbl} ({TRIGGER_THRESHOLDS[limit_key]})"
        )
    elif model_target in ("argon", "carbon"):
        updated_data, c_m408 = replace_model_limit(updated_data, M408_GEMINI4_PREFIX, new_val_bytes)
        if c_m408 == 0:
            updated_data, c_m408 = replace_model_limit(updated_data, ARGON_PREFIX, new_val_bytes)
        summary_messages.append(
            f"Gemini 4 Argon / Carbon (M408 JSON): updated {c_m408} slot(s) to {display_lbl} ({TRIGGER_THRESHOLDS[limit_key]})"
        )

    # 3. Determine safe Machine-Code Clamp & Dynamic Model Baseline (Pattern 1..4)
    # Cloud-pushed models (Hydrogen, Orchestrator, Carbon M427) rely directly on Pattern 1.
    # Also, Pattern 1 must never be lower than the highest active JSON slot, otherwise it would truncate that JSON slot.
    _, existing_clamp_vals, _, _ = inspect_binary_clamp(updated_data)
    cur_clamp_max = max(existing_clamp_vals) if existing_clamp_vals else 256000
    all_json_ints = (
        _inspect_slot_int_values(updated_data, FLASH_PREFIX)
        + _inspect_slot_int_values(updated_data, ARGON_PREFIX)
    )
    max_json_int = max(all_json_ints) if all_json_ints else 256000

    if model_target in ("all", "carbon", "hydrogen", "orchestrator"):
        desired_clamp_int = max(target_int, max_json_int)
        if desired_clamp_int > target_int:
            summary_messages.append(
                f"Notice: Machine-code baseline kept at {INT_TO_LABEL.get(desired_clamp_int, str(desired_clamp_int))} "
                f"to avoid truncating higher static JSON profile ({INT_TO_LABEL.get(max_json_int, str(max_json_int))}); "
                f"use '--model all' to lower all models together."
            )
    else:
        # 'flash' or 'argon' only: raise clamp if needed, but NEVER lower existing dynamic baseline (protects Hydrogen/Orchestrator/M427)
        desired_clamp_int = max(target_int, cur_clamp_max, max_json_int)

    int_to_key = {v: k for k, v in SUPPORTED_LIMITS_INT.items() if k != "840k"}
    clamp_key = int_to_key.get(desired_clamp_int, limit_key)
    clamp_disp = INT_TO_LABEL.get(desired_clamp_int, clamp_key.upper())

    updated_data, c_clamp, c_arch = replace_binary_clamp(updated_data, clamp_key)
    if c_clamp > 0:
        summary_messages.append(
            f"Dynamic Models & Binary Clamp ({c_arch} — Hydrogen / Orchestrator / Carbon M427): "
            f"patched {c_clamp} locations to {clamp_disp}"
        )

    if len(updated_data) != len(data):
        print("Error: Modified binary size mismatch. Aborting for safety!")
        sys.exit(1)

    # 4. Write modified binary
    _atomic_write_binary(target_path, updated_data)

    # 5. Re-sign binary on macOS
    if IS_MACOS:
        print("Re-signing binary (codesign -f -s -) ...")
        try:
            subprocess.check_call(["codesign", "-f", "-s", "-", target_path])
            print("Code re-signing successful.")
        except Exception as e:
            print(f"Warning: Code re-signing failed: {e}")
            print("If application fails to launch, restore via: python3 manage_token_limit.py --restore")
            sys.exit(1)
    else:
        print("Non-macOS platform; code signing skipped.")

    print("\nSuccessfully updated context limits:")
    for msg in summary_messages:
        print(f"  * {msg}")
    print("Please fully quit and restart the Antigravity application for changes to take effect.")


def _atomic_write_binary(target_path: str, data: bytes) -> None:
    """Write binary data to target_path, falling back to atomic rename on Windows if locked."""
    try:
        with open(target_path, "wb") as fp:
            fp.write(data)
    except PermissionError as e:
        if IS_WINDOWS:
            for suffix in ["", ".1", ".2", ".3", ".4"]:
                cand = f"{target_path}.old{suffix}"
                if os.path.exists(cand):
                    try:
                        os.remove(cand)
                    except Exception:
                        continue
                try:
                    os.rename(target_path, cand)
                    with open(target_path, "wb") as fp:
                        fp.write(data)
                    print("Notice: Binary was updated via atomic rename because language_server is running.")
                    return
                except Exception:
                    continue
            print(f"Error: Failed to write to target file ({e}) and atomic rename fallback also failed.")
            sys.exit(1)
        else:
            print(f"Error: Failed to write to target file ({e}). Please ensure the file is not locked and has write permissions.")
            sys.exit(1)


def restore_official_defaults(target_path: str, backup_path: str) -> None:
    """Restore official default baseline (Legacy Flash 128K, Same-Model 256K, Clamp 256K) from build-matched backup or in-place."""
    _cleanup_stale_old_binaries(target_path)
    if not os.path.exists(target_path):
        print(f"Error: Target file not found: {target_path}")
        sys.exit(1)

    with open(target_path, "rb") as fp:
        cur_d = fp.read()

    if os.path.exists(backup_path):
        with open(backup_path, "rb") as fp:
            bdata = fp.read()
        if _is_backup_compatible(cur_d, bdata):
            f_val, _ = inspect_model_values(bdata, FLASH_PREFIX)
            a_val, _ = inspect_model_values(bdata, ARGON_PREFIX)
            m408_val, m408_cnt = inspect_model_values(bdata, M408_GEMINI4_PREFIX)
            c_status, _, _, b_unclamped = inspect_binary_clamp(bdata)
            p3_f, p3_b, p4_f, p4_b = inspect_mendel_overlay_details(bdata)
            any_bypassed = (p3_f and p3_b) or (p4_f and p4_b)
            argon_ok = (m408_val == "256K") if m408_cnt > 0 else (a_val == "256K")
            if f_val == "128K" and argon_ok and c_status == "256K" and not b_unclamped and not any_bypassed:
                print(f"Restoring clean binary from build-matched official backup: {backup_path} -> {target_path} ...")
                _atomic_write_binary(target_path, bdata)
                if IS_MACOS:
                    print("Verifying official signature ...")
                    try:
                        subprocess.check_call(["codesign", "-v", target_path])
                        print("Official signature valid.")
                    except Exception:
                        print("Re-applying ad-hoc signature ...")
                        subprocess.call(["codesign", "-f", "-s", "-", target_path])
                print("Successfully restored official baseline: Legacy Flash 128K, Gemini 3.8/4 & Dynamic Models 256K, Cloud Mendel Active.")
                print("Please restart the Antigravity application.")
                return
        else:
            print("Notice: Backup file belongs to a different language_server build; performing safe in-place restore instead of overwriting binary.")

    # Safe in-place restore on current binary build
    restored, _ = replace_model_limit(cur_d, FLASH_PREFIX, SUPPORTED_LIMITS["128k"])
    restored, _ = replace_model_limit(restored, ARGON_PREFIX, SUPPORTED_LIMITS["256k"])
    restored, _, _ = replace_binary_clamp(restored, "256k", restore_overlay=True)
    if len(restored) != len(cur_d):
        print("Error: Restored binary size mismatch. Aborting for safety!")
        sys.exit(1)
    _atomic_write_binary(target_path, restored)
    if IS_MACOS:
        subprocess.call(["codesign", "-f", "-s", "-", target_path])
    print("Successfully restored official baseline in-place: Legacy Flash 128K, Gemini 3.8/4 & Dynamic Models 256K, Cloud Mendel Active.")
    print("Please restart the Antigravity application.")


def main() -> None:
    """CLI entry point for context token limit manager."""
    default_target, default_backup = get_default_paths()
    parser = argparse.ArgumentParser(
        description="Antigravity Context Token Limit Manager CLI (Switch between 128K, 256K, 320K, 384K, 512K, 768K, and 1M/840K)"
    )
    parser.add_argument(
        "--set",
        "--limit",
        dest="limit",
        choices=["128k", "256k", "320k", "384k", "512k", "768k", "840k", "1m"],
        help="Target context window limit to configure: 128k, 256k, 320k, 384k, 512k, 768k, 840k, or 1m (sets 840K safe ceiling for 1M models)",
    )
    parser.add_argument(
        "--model",
        choices=["all", "flash", "argon", "carbon", "hydrogen", "orchestrator"],
        default="all",
        help=(
            "Model scope to apply the limit: 'all' (default, updates all static & dynamic models), "
            "'flash' (Gemini 3.8 Flash M124), 'argon' (M408), or 'carbon'/'hydrogen'/'orchestrator'"
        ),
    )
    parser.add_argument(
        "--patch",
        action="store_true",
        help="Convenience alias to set Flash limit to 256K",
    )
    parser.add_argument(
        "--restore",
        action="store_true",
        help="Restore official defaults (Flash 128K, Argon 256K, Clamp 256K)",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Inspect current token limits, model thresholds, clamp status, and code signature",
    )
    parser.add_argument("--target", default=default_target, help=f"Target binary path (default: {default_target})")
    parser.add_argument("--backup", default=default_backup, help=f"Backup file path (default: {default_backup})")

    args = parser.parse_args()

    if args.limit:
        set_token_limit(args.target, args.backup, limit=args.limit, model=args.model)
    elif args.patch:
        set_token_limit(args.target, args.backup, limit="256k", model="flash")
    elif args.restore:
        restore_official_defaults(args.target, args.backup)
    elif args.status:
        check_status(args.target, args.backup)
    else:
        # Default action: check status
        check_status(args.target, args.backup)


if __name__ == "__main__":
    main()
