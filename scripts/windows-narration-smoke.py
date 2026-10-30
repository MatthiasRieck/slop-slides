"""Real-model smoke test for a Windows SlopSlide executable (Python standard library only).

python scripts/windows-narration-smoke.py --exe path/to/slopslide.exe --download
The model, WAVs, stderr, and measurements stay in --work for inspection/listening.
"""
import argparse
import ctypes
import hashlib
import json
import os
import platform
import queue
import re
import subprocess
import threading
import time
import urllib.request
import wave
from pathlib import Path


def model_files():
    source = (Path(__file__).resolve().parents[1] / "src-tauri/src/narration/mod.rs").read_text()
    repo = re.search(r'const MODEL_REPO: &str = "([^"]+)"', source)[1]
    revision = re.search(r'const MODEL_REVISION: &str = "([^"]+)"', source)[1]
    files = re.findall(r'ModelFile \{ path: "([^"]+)", bytes: ([\d_]+), sha256: "([a-f0-9]+)"', source)
    assert len(files) == 11, "model manifest changed; update smoke-test parser"
    return repo, revision, [(p, int(n.replace("_", "")), h) for p, n, h in files]


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def prepare_model(directory, download):
    repo, revision, files = model_files()
    for name, size, digest in files:
        dest = directory / name
        if dest.exists() and dest.stat().st_size == size and sha256(dest) == digest:
            continue
        if not download:
            raise RuntimeError(f"Missing or damaged {dest}; pass --download")
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_suffix(".part")
        print(f"Downloading and checking {name}", flush=True)
        try:
            with urllib.request.urlopen(f"https://huggingface.co/{repo}/resolve/{revision}/{name}", timeout=60) as response, part.open("wb") as out:
                while chunk := response.read(1024 * 1024):
                    out.write(chunk)
            if part.stat().st_size != size or sha256(part) != digest:
                raise RuntimeError(f"Checksum/size mismatch: {name}")
            part.replace(dest)
        finally:
            part.unlink(missing_ok=True)
    return revision


def peak_memory(process):
    # Query the OS high-water mark, not a sampling estimate that can miss peaks.
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("faults", ctypes.c_ulong)] + [
            (name, ctypes.c_size_t) for name in (
                "peak_working_set", "working_set", "peak_paged", "paged",
                "peak_nonpaged", "nonpaged", "pagefile", "peak_pagefile")]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
    handle = kernel.OpenProcess(0x410, False, process.pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            raise ctypes.WinError(ctypes.get_last_error())
        return counters.peak_working_set
    finally:
        kernel.CloseHandle(handle)


def run(args):
    if os.name != "nt":
        raise RuntimeError("Run this smoke test on Windows to measure the Windows engine")
    work = args.work.resolve()
    work.mkdir(parents=True, exist_ok=True)
    model = work / "voice model 模型"
    revision = prepare_model(model, args.download)
    report = {"platform": platform.platform(), "cpu": platform.processor(),
              "logical_cpus": os.cpu_count(), "model_revision": revision, "renders": []}
    with (work / "worker-stderr.log").open("wb") as log:
        start = time.perf_counter()
        proc = subprocess.Popen([str(args.exe.resolve()), "--narration-worker", str(model)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                                text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW)
        answers = queue.Queue()
        def read_answers():
            for line in proc.stdout:
                answers.put(line)
            answers.put(None)
        threading.Thread(target=read_answers, daemon=True).start()
        def answer():
            line = answers.get(timeout=args.timeout)
            if line is None:
                raise RuntimeError("worker exited; inspect worker-stderr.log")
            return json.loads(line)
        def send(request):
            proc.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
            proc.stdin.flush()
        try:
            assert answer() == {"ready": True}, "engine did not load"
            report["load_seconds"] = time.perf_counter() - start
            for index, (speaker, language, text) in enumerate([
                ("ryan", "English", "Welcome to SlopSlide. This narration is generated locally on Windows."),
                ("aiden", "German", "Diese Präsentation wird direkt auf diesem Computer vorgelesen."),
            ]):
                output = work / f"slide {index} ä.wav"
                start = time.perf_counter()
                send(dict(text=text, speaker=speaker, language=language, output=str(output)))
                result = answer()
                elapsed = time.perf_counter() - start
                assert result.get("samples", 0) > 0, result
                with wave.open(str(output)) as wav:
                    assert wav.getnchannels() == 1 and wav.getframerate() == 24000
                    assert wav.getnframes() == result["samples"]
                    samples = wav.readframes(wav.getnframes())
                    assert any(samples), "silent output"
                    seconds = wav.getnframes() / wav.getframerate()
                report["renders"].append(dict(speaker=speaker, language=language, text=text,
                    wall_seconds=elapsed, audio_seconds=seconds, real_time_factor=elapsed / seconds))
            bad = work / "invalid.wav"
            bad.unlink(missing_ok=True)
            send(dict(text="Hello", speaker="nonexistent", language="English", output=str(bad)))
            assert "error" in answer() and not bad.exists()
            report["peak_working_set_bytes"] = peak_memory(proc)
            proc.stdin.close()
            assert proc.wait(timeout=30) == 0, "worker did not exit cleanly on EOF"
            report["clean_shutdown"] = True
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=30)
            proc.stdout.close()
    (work / "measurements.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--work", type=Path, default=Path("narration smoke 空間"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--timeout", type=int, default=900)
    run(parser.parse_args())
