#!/usr/bin/env python3
"""
Antigravity Context Token Limit Manager CLI
Configures max_token_limit thresholds (128K, 256K, 320K, 384K, 512K) for language_server.
Supports updating all models simultaneously or targeting specific models (Flash, Argon).
Cross-platform compatible: macOS (ARM64) and Windows (x86_64).
Zero-dependency using Python standard library.
"""

from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys

IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"

# Model-specific exact strategy prefixes in language_server binary
FLASH_PREFIX = rb'\"strategy\": \"CHECKPOINT_STRATEGY_SINGLE_PROMPT\",\n    \"max_token_limit\": \"'
ARGON_PREFIX = rb'\"strategy\": \"CHECKPOINT_STRATEGY_SAME_MODEL\",\n    \"max_token_limit\": \"'

SUPPORTED_LIMITS: dict[str, bytes] = {
    "128k": b"128000",
    "256k": b"256000",
    "320k": b"320000",
    "384k": b"384000",
    "512k": b"512000",
}

SUPPORTED_LIMITS_INT: dict[str, int] = {
    "128k": 128000,
    "256k": 256000,
    "320k": 320000,
    "384k": 384000,
    "512k": 512000,
}

TRIGGER_THRESHOLDS: dict[str, str] = {
    "128k": "~108.8K tokens (~85% watermark)",
    "256k": "~217.6K tokens (~85% watermark)",
    "320k": "~272.0K tokens (~85% watermark)",
    "384k": "~326.4K tokens (~85% watermark)",
    "512k": "~435.2K tokens (~85% watermark)",
}

VALUE_TO_LABEL: dict[bytes, str] = {
    b"128000": "128K",
    b"256000": "256K",
    b"320000": "320K",
    b"384000": "384K",
    b"512000": "512K",
}

INT_TO_LABEL: dict[int, str] = {
    128000: "128K",
    256000: "256K",
    320000: "320K",
    384000: "384K",
    512000: "512K",
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


def inspect_model_values(data: bytes, prefix: bytes) -> tuple[str, int]:
    """Inspect current 6-byte token limit value and occurrence count for a given prefix."""
    pos = 0
    values: set[bytes] = set()
    count = 0
    while True:
        idx = data.find(prefix, pos)
        if idx == -1:
            break
        val_start = idx + len(prefix)
        val = data[val_start : val_start + 6]
        # Preserve claude-1m_840k so it does not skew Argon metrics
        if val == b"840000":
            pos = val_start + 6
            continue
        values.add(val)
        count += 1
        pos = val_start + 6

    if not values:
        return "Not found", 0
    if len(values) == 1:
        v = next(iter(values))
        return VALUE_TO_LABEL.get(v, v.decode("ascii", errors="ignore")), count
    return "Mixed (" + ", ".join(VALUE_TO_LABEL.get(v, v.decode("ascii", errors="ignore")) for v in values) + ")", count


def replace_model_limit(data: bytes, prefix: bytes, new_val: bytes) -> tuple[bytes, int]:
    """Replace 6-byte token limit following the exact model prefix in-place."""
    pos = 0
    count = 0
    out = bytearray(data)
    while True:
        idx = out.find(prefix, pos)
        if idx == -1:
            break
        val_start = idx + len(prefix)
        val = bytes(out[val_start : val_start + 6])
        # Preserve claude-1m_840k without downgrading
        if val == b"840000":
            pos = val_start + 6
            continue
        out[val_start : val_start + 6] = new_val
        count += 1
        pos = val_start + 6
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


def replace_binary_clamp(data: bytes, limit_key: str) -> tuple[bytes, int, str]:
    """
    Patch hardcoded binary clamp thresholds in machine code to match desired limit.
    Bypasses cmovb down-clamping for limits > 256K to ensure full context utilization.
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

    arch = "x86_64" if count > 0 else "unknown"
    return bytes(out), count, arch


def check_status(target_path: str, backup_path: str) -> bool:
    """Inspect and report current token limit configuration, model thresholds, clamp status, and signature status."""
    if not os.path.exists(target_path):
        print(f"Error: Target file not found: {target_path}")
        return False

    with open(target_path, "rb") as fp:
        data = fp.read()

    flash_val, flash_count = inspect_model_values(data, FLASH_PREFIX)
    argon_val, argon_count = inspect_model_values(data, ARGON_PREFIX)
    clamp_status, clamp_vals, clamp_arch, is_unclamped = inspect_binary_clamp(data)

    line_sep = "=" * 60
    print(line_sep)
    print("Antigravity Language Server Token Limit Status")
    print(line_sep)
    print(f"Platform: {sys.platform} ({clamp_arch})")
    print(f"Target file: {target_path}")
    print(f"File size: {len(data):,} bytes")
    print(f"Backup exists: {'Yes (' + backup_path + ')' if os.path.exists(backup_path) else 'No'}")

    flash_key = flash_val.lower()
    argon_key = argon_val.lower()
    flash_trig = TRIGGER_THRESHOLDS.get(flash_key, "custom threshold")
    argon_trig = TRIGGER_THRESHOLDS.get(argon_key, "custom threshold")

    print(f"\nModel Token Limits (JSON Config):")
    print(f"  - Gemini Flash: {flash_val} ({flash_count} markers) -> trigger: {flash_trig}")
    print(f"  - Gemini Argon: {argon_val} ({argon_count} markers) -> trigger: {argon_trig}")

    print(f"\nBinary Clamp Status (Machine Code):")
    if clamp_arch == "x86_64":
        if clamp_status.upper() in ("384K", "512K"):
            unclamp_tag = " [Hard Floor & Ceiling Locked: cmovb clamp bypassed]" if is_unclamped else ""
            print(f"  - x86_64 Clamp: {clamp_status} ({len(clamp_vals)} locations patched){unclamp_tag} -> Hard ceiling raised successfully")
        elif clamp_status.upper() == "256K":
            if flash_val.upper() in ("384K", "512K") or argon_val.upper() in ("384K", "512K"):
                print(f"  - x86_64 Clamp: 256K [WARNING: Hard ceiling clamp active at 256K; will truncate models configured for >256K!]")
            else:
                print(f"  - x86_64 Clamp: 256K (Official default baseline)")
        else:
            print(f"  - x86_64 Clamp: {clamp_status} (Values: {clamp_vals})")
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
    Set max_token_limit to 128k, 256k, 320k, 384k, or 512k.
    Can update all models simultaneously or target 'flash' or 'argon' specifically.
    Automatically synchronizes machine-code clamp limits to prevent truncation.
    """
    limit_key = limit.lower()
    if limit_key not in SUPPORTED_LIMITS:
        print(f"Error: Unsupported limit '{limit}'. Choose from: 128k, 256k, 320k, 384k, 512k.")
        sys.exit(1)

    model_target = model.lower()
    if model_target not in ("all", "flash", "argon"):
        print(f"Error: Unsupported model scope '{model}'. Choose from: 'all', 'flash', 'argon'.")
        sys.exit(1)

    if not os.path.exists(target_path):
        print(f"Error: Target file not found: {target_path}")
        sys.exit(1)

    # 1. Ensure original baseline backup exists
    if not os.path.exists(backup_path):
        print(f"Creating original binary backup: {backup_path} ...")
        shutil.copy2(target_path, backup_path)
        print("Backup created successfully.")

    # 2. Read target binary
    with open(target_path, "rb") as fp:
        data = fp.read()

    new_val_bytes = SUPPORTED_LIMITS[limit_key]
    updated_data = data
    summary_messages: list[str] = []

    # Apply to Flash
    if model_target in ("all", "flash"):
        updated_data, c_flash = replace_model_limit(updated_data, FLASH_PREFIX, new_val_bytes)
        summary_messages.append(f"Gemini Flash: updated {c_flash} JSON markers to {limit_key.upper()} ({TRIGGER_THRESHOLDS[limit_key]})")

    # Apply to Argon
    if model_target in ("all", "argon"):
        updated_data, c_argon = replace_model_limit(updated_data, ARGON_PREFIX, new_val_bytes)
        summary_messages.append(f"Gemini Argon: updated {c_argon} JSON markers to {limit_key.upper()} ({TRIGGER_THRESHOLDS[limit_key]})")

    # Apply Machine-Code Clamp Patch
    updated_data, c_clamp, c_arch = replace_binary_clamp(updated_data, limit_key)
    if c_clamp > 0:
        summary_messages.append(f"Binary Clamp ({c_arch}): patched {c_clamp} machine-code clamp locations to {limit_key.upper()}")

    if len(updated_data) != len(data):
        print("Error: Modified binary size mismatch. Aborting for safety!")
        sys.exit(1)

    # 3. Write modified binary
    try:
        with open(target_path, "wb") as fp:
            fp.write(updated_data)
    except PermissionError as e:
        if IS_WINDOWS:
            old_path = target_path + ".old"
            if os.path.exists(old_path):
                try:
                    os.remove(old_path)
                except Exception:
                    pass
            try:
                os.rename(target_path, old_path)
                with open(target_path, "wb") as fp:
                    fp.write(updated_data)
                print("Notice: Binary was updated via atomic rename because language_server is running.")
            except Exception as rename_err:
                print(f"Error: Failed to write to target file ({e}) and atomic rename fallback also failed ({rename_err}).")
                sys.exit(1)
        else:
            print(f"Error: Failed to write to target file ({e}). Please ensure the file is not locked and has write permissions.")
            sys.exit(1)

    # 4. Re-sign binary on macOS
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


def restore_official_defaults(target_path: str, backup_path: str) -> None:
    """Restore official default baseline (Flash 128K, Argon 256K, Clamp 256K) from backup or in-place."""
    if os.path.exists(backup_path):
        with open(backup_path, "rb") as fp:
            bdata = fp.read()
        f_val, _ = inspect_model_values(bdata, FLASH_PREFIX)
        a_val, _ = inspect_model_values(bdata, ARGON_PREFIX)
        c_status, _, _, _ = inspect_binary_clamp(bdata)
        if f_val == "128K" and a_val == "256K" and c_status == "256K":
            print(f"Restoring clean binary from official backup: {backup_path} -> {target_path} ...")
            try:
                shutil.copy2(backup_path, target_path)
            except PermissionError:
                if IS_WINDOWS:
                    old_path = target_path + ".old"
                    if os.path.exists(old_path):
                        try:
                            os.remove(old_path)
                        except Exception:
                            pass
                    os.rename(target_path, old_path)
                    shutil.copy2(backup_path, target_path)
                else:
                    raise
            if IS_MACOS:
                print("Verifying official signature ...")
                try:
                    subprocess.check_call(["codesign", "-v", target_path])
                    print("Official signature valid.")
                except Exception:
                    print("Re-applying ad-hoc signature ...")
                    subprocess.call(["codesign", "-f", "-s", "-", target_path])
            print("Successfully restored official baseline: Flash 128K (~108.8K trigger), Argon 256K (~217.6K trigger), Clamp 256K.")
            print("Please restart the Antigravity application.")
            return

    # Fallback to in-place replacement
    set_token_limit(target_path, backup_path, limit="128k", model="flash")
    set_token_limit(target_path, backup_path, limit="256k", model="argon")
    # Clamp restore to 256k
    with open(target_path, "rb") as fp:
        cur_d = fp.read()
    cur_d, _, _ = replace_binary_clamp(cur_d, "256k")
    try:
        with open(target_path, "wb") as fp:
            fp.write(cur_d)
    except PermissionError:
        if IS_WINDOWS:
            old_path = target_path + ".old"
            if os.path.exists(old_path):
                try:
                    os.remove(old_path)
                except Exception:
                    pass
            os.rename(target_path, old_path)
            with open(target_path, "wb") as fp:
                fp.write(cur_d)


def main() -> None:
    """CLI entry point for context token limit manager."""
    default_target, default_backup = get_default_paths()
    parser = argparse.ArgumentParser(
        description="Antigravity Context Token Limit Manager CLI (Switch between 128K, 256K, 320K, 384K, and 512K)"
    )
    parser.add_argument(
        "--set",
        "--limit",
        dest="limit",
        choices=["128k", "256k", "320k", "384k", "512k"],
        help="Target context window limit to configure: 128k, 256k, 320k, 384k, or 512k",
    )
    parser.add_argument(
        "--model",
        choices=["all", "flash", "argon"],
        default="all",
        help="Model scope to apply the limit: 'all' (default, updates all models), 'flash' (Flash only), or 'argon' (Argon only)",
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
