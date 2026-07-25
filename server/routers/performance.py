import os
import platform
import subprocess
from dataclasses import asdict

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..performance import (
    get_performance_settings,
    get_runtime_stats,
    update_performance_settings,
)

router = APIRouter()


class PerformanceUpdateRequest(BaseModel):
    max_concurrent_tasks: int = Field(ge=1, le=12)
    translate_concurrency: int = Field(ge=1, le=8)
    translate_batch_size: int = Field(ge=5, le=50)
    tts_concurrency: int = Field(ge=1, le=16)


def _memory_gb() -> int | None:
    try:
        if platform.system() == "Darwin":
            result = subprocess.run(
                ["sysctl", "-n", "hw.memsize"],
                capture_output=True,
                text=True,
                check=True,
                timeout=2,
            )
            return round(int(result.stdout.strip()) / 1024 ** 3)
        if platform.system() == "Windows":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [
                    ("length", ctypes.c_ulong),
                    ("memory_load", ctypes.c_ulong),
                    ("total_physical", ctypes.c_ulonglong),
                    ("available_physical", ctypes.c_ulonglong),
                    ("total_page_file", ctypes.c_ulonglong),
                    ("available_page_file", ctypes.c_ulonglong),
                    ("total_virtual", ctypes.c_ulonglong),
                    ("available_virtual", ctypes.c_ulonglong),
                    ("available_extended_virtual", ctypes.c_ulonglong),
                ]

            status = MemoryStatus()
            status.length = ctypes.sizeof(MemoryStatus)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return None
            return round(status.total_physical / 1024 ** 3)
        if not hasattr(os, "sysconf"):
            return None
        pages = os.sysconf("SC_PHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
        return round(pages * page_size / 1024 ** 3)
    except (AttributeError, OSError, ValueError, subprocess.SubprocessError):
        return None


def _chip_name() -> str:
    sys_name = platform.system()
    if sys_name == "Darwin":
        try:
            result = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                capture_output=True,
                text=True,
                check=True,
                timeout=2,
            )
            if result.stdout.strip():
                return result.stdout.strip()
        except subprocess.SubprocessError:
            pass
        return "Apple Silicon"
    elif sys_name == "Windows":
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            )
            cpu_name, _ = winreg.QueryValueEx(key, "ProcessorNameString")
            winreg.CloseKey(key)
            if cpu_name and cpu_name.strip():
                return cpu_name.strip()
        except Exception:
            pass
        proc_id = os.environ.get("PROCESSOR_IDENTIFIER")
        if proc_id and proc_id.strip():
            return proc_id.strip()

    return platform.processor() or platform.machine() or "Generic CPU"


def _response() -> dict:
    return {
        "settings": asdict(get_performance_settings()),
        "runtime": get_runtime_stats(),
        "hardware": {
            "chip": _chip_name(),
            "logical_cores": os.cpu_count() or 1,
            "memory_gb": _memory_gb(),
            "platform": platform.platform(),
        },
    }


@router.get("/performance")
async def performance_settings() -> dict:
    return _response()


@router.put("/performance")
async def save_performance_settings(req: PerformanceUpdateRequest) -> dict:
    await update_performance_settings(req.model_dump())
    return _response()
