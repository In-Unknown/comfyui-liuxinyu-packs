"""Local, bounded WPR flight recorder. Never sends window or input commands."""
from collections import deque
from datetime import datetime, timezone
import json
import importlib.util
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import threading
import time

INSTANCE = "LiuxinyuFocus"
PROFILE = Path(__file__).with_name("diagnostics") / "focus.wprp"


class FocusRecorder:
    def __init__(self, directory, emit, run=None, snapshot=None):
        self.directory = Path(directory)
        self.emit = emit
        self.run = run or self._command
        self.snapshot = snapshot or self._snapshot
        self.status = "not_started"
        self.last_capture = None
        self.last_capture_result = None
        state_path = self.directory / "focus-recorder-state.json"
        if state_path.is_file():
            try:
                previous = json.loads(state_path.read_text(encoding="utf-8"))
                self.last_capture = previous.get("lastCapture")
                self.last_capture_result = previous.get("lastCaptureResult")
            except (OSError, ValueError):
                pass
        self.pending = queue.Queue(maxsize=1)
        self.recent = deque(maxlen=2000)
        self.minimized = {}
        self.last_trigger = -float("inf")
        self.lock = threading.Lock()

    @staticmethod
    def _command(args):
        result = subprocess.run(args, capture_output=True, text=True, errors="replace",
                                timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return result.returncode, (result.stdout + result.stderr)[-12000:]

    def _wpr(self, *args):
        return self.run(["wpr", *map(str, args), "-instancename", INSTANCE])

    @staticmethod
    def _snapshot(prefix, reason):
        spec = importlib.util.spec_from_file_location("liuxinyu_focus_snapshot", PROFILE.with_name("focus_snapshot.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # Flush first: evidence must survive errors in later module collection or WPR merging.
        result = {"buffers": module.save_buffers(prefix), "processes": []}
        event = reason.get("event", {})
        pids = {event.get(key, {}).get("pid", 0) for key in ("window", "foreground")}
        for pid in sorted(pids - {0}):
            try:
                result["processes"].append(module.snapshot_modules(pid))
            except OSError as exc:
                result["processes"].append({"pid": pid, "error": repr(exc)})
        return result

    def _state(self, state, **details):
        self.status = state
        self.directory.mkdir(parents=True, exist_ok=True)
        data = {"state": state, "pid": os.getpid(), "time": datetime.now(timezone.utc).isoformat(),
                "lastCapture": self.last_capture, "lastCaptureResult": self.last_capture_result, **details}
        temporary = self.directory / "focus-recorder-state.tmp"
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.directory / "focus-recorder-state.json")
        self.emit("recorder", {"kind": "recorder-state", **data})

    def start(self):
        if os.name != "nt":
            self.status = "unsupported_platform"
            return
        threading.Thread(target=self._worker, name="liuxinyu-focus-recorder", daemon=True).start()

    def arm(self):
        code, status = self._wpr("-status", "collectors", "-details")
        # Adopt our named session after a backend restart. Never stop another WPR instance.
        if code == 0 and "Microsoft-Windows-Win32k" in status and "Stack" in status:
            self._state("recording", adopted=True, collectors=status)
            return True
        code, output = self._wpr("-start", str(PROFILE) + "!LiuxinyuFocus")
        if code:
            self._state("start_failed", returnCode=code, output=output)
            return False
        code, status = self._wpr("-status", "collectors", "-details")
        if code or "Microsoft-Windows-Win32k" not in status or "Stack" not in status:
            self._state("provider_unverified", returnCode=code, output=status)
            return False
        self._state("recording", collectors=status)
        return True

    def observe(self, source, event):
        now = time.monotonic()
        record = {"receivedAt": datetime.now(timezone.utc).isoformat(), "source": source, **event}
        with self.lock:
            self.recent.append(record)
            if source != "windows":
                return
            kind, window = event.get("kind"), event.get("window", {})
            hwnd, tick = window.get("hwnd"), event.get("systemTickMs")
            if kind == "minimize-start" and tick is not None:
                self.minimized[hwnd] = (tick, now)
                self.minimized = {h: v for h, v in self.minimized.items() if now - v[1] < 60}
                return
            reason = None
            if kind in ("foreground", "minimize-end") and hwnd in self.minimized and tick is not None:
                elapsed = (tick - self.minimized[hwnd][0]) & 0xffffffff
                if 0 <= elapsed <= 2000 and not window.get("minimized"):
                    reason = {"kind": "rapid-restore", "elapsedMs": elapsed, "event": record}
                    del self.minimized[hwnd]
            if kind == "shell-flash" and event.get("foreground", {}).get("hwnd") != hwnd:
                reason = {"kind": "background-taskbar-flash", "event": record}
            if reason and now - self.last_trigger >= 60:
                try:
                    self.pending.put_nowait(reason)
                    self.last_trigger = now
                except queue.Full:
                    pass

    def capture(self, reason):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        prefix = self.directory / ("focus-incident-" + stamp)
        with self.lock:
            recent = list(self.recent)
        self.directory.mkdir(parents=True, exist_ok=True)
        report = {"reason": reason, "recent": recent, "profile": PROFILE.read_text(encoding="utf-8")}
        report_path = prefix.with_suffix(".json")
        # Commit the incident before any potentially failing or timing-out export.
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            report["rawSnapshot"] = self.snapshot(prefix, reason)
        except (OSError, ValueError) as exc:
            report["rawSnapshot"] = {"error": repr(exc)}
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            code, before = self._wpr("-status", "collectors", "-details")
        except (OSError, subprocess.SubprocessError) as exc:
            code, before = -1, repr(exc)
        report.update(collectorStatusBeforeSave=before, statusReturnCode=code)
        # Preserve page evidence even if the WPR stop/export fails.
        for name in ("focus.jsonl", "focus.jsonl.1"):
            source = self.directory / name
            if source.is_file():
                shutil.copyfile(source, str(prefix) + "-" + name)
        # Native call records are a separate stream; keep them with this incident too.
        for name in ("focus-calls.jsonl", "focus-calls.jsonl.1", "focus-calls-state.json"):
            source = self.directory / name
            if source.is_file():
                shutil.copyfile(source, str(prefix) + "-" + name)
        try:
            code, output = self._wpr("-stop", str(prefix) + ".etl", "-skipPdbGen")
        except (OSError, subprocess.SubprocessError) as exc:
            code, output = -1, repr(exc)
        report.update(saveReturnCode=code, saveOutput=output)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        self.last_capture = str(report_path)
        raw_ok = any(item.get("flushCode") == 0 and item.get("bytes", 0) > 0
                     and item.get("path", "").endswith(".events.etl")
                     for item in report.get("rawSnapshot", {}).get("buffers", []))
        self.last_capture_result = {"mergeReturnCode": code, "rawEventsSaved": raw_ok,
                                    "state": "saved" if code == 0 else "raw_saved" if raw_ok else "save_failed"}
        self._state("saved" if code == 0 else "save_failed", returnCode=code, output=output)
        # Retire hot entries into durable folders; never delete incident evidence automatically.
        incidents = sorted(p for p in self.directory.glob("focus-incident-*.json")
                           if not p.name.endswith((".summary.json", "-focus-calls-state.json")))
        for old in incidents[:-8]:
            archive = self.directory / "focus-preserved" / old.stem
            archive.mkdir(parents=True, exist_ok=True)
            for suffix in (".json", ".etl", ".events.etl", ".images.etl", ".summary.json",
                           ".events.summary.json", "-focus.jsonl", "-focus.jsonl.1", ".decoding.xml", ".events.decoding.xml",
                           "-focus-calls.jsonl", "-focus-calls.jsonl.1", "-focus-calls-state.json"):
                source = self.directory / (old.stem + suffix)
                if source.is_file():
                    source.replace(archive / source.name)
        armed = self.arm()
        if code == 0 or raw_ok:
            window = reason.get("event", {}).get("window", {})
            result, output = self.run([sys.executable, str(PROFILE.with_name("focus_report.py")),
                                       str(prefix) + (".etl" if code == 0 else ".events.etl"), "--pid", str(window.get("pid", 0)),
                                       "--hwnd", str(window.get("hwnd", 0))])
            self.emit("recorder", {"kind": "incident-decoded", "report": str(report_path),
                                   "returnCode": result, "output": output})
        return armed

    def _worker(self):
        armed = False
        while True:
            try:
                if not armed:
                    armed = self.arm()
                try:
                    reason = self.pending.get(timeout=60)
                except queue.Empty:
                    # A visible health record includes dropped event counts and provider identity.
                    armed = self.arm()
                    continue
                time.sleep(3)  # Collect the repeated flashes/restores in this burst.
                armed = self.capture(reason)
            except (OSError, subprocess.SubprocessError) as exc:
                self._state("recorder-error", error=repr(exc))
                armed = False
                time.sleep(60)
