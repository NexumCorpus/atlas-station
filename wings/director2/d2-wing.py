"""Wing Protocol v1 adapter for director2-harness.

Runs whitelisted `director` CLI commands as subprocesses (cwd = the harness
repo, so its local `director` package shadows any installed one) and streams
results as protocol events. Discovery runs (`evolve`) are deliberately not
whitelisted in v1 — missions arrive in Phase 5 with proper claim bundles.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HARNESS = Path(os.environ.get("D2_HARNESS", "E:/director2-harness"))
SPOOL = Path(os.environ["WING_SPOOL"])
WHITELIST = {"init", "status", "new", "advance", "tasks", "modules", "risks", "history"}
OUTPUT_TAIL = 4000


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def run_cmd(cmd, args):
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    proc = subprocess.run(
        [sys.executable, "-m", "director", cmd, *args],
        cwd=str(HARNESS), env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=300,
    )
    out = (proc.stdout + proc.stderr).strip()
    return proc.returncode, out[-OUTPUT_TAIL:]


def main():
    emit({"t": "status", "state": "ready", "harness": str(HARNESS)})
    while True:
        for f in sorted(p for p in SPOOL.iterdir() if p.suffix == ".json"):
            cmd_obj = json.loads(f.read_text(encoding="utf-8"))
            f.unlink()
            op = cmd_obj.get("op")
            if op == "stop":
                emit({"t": "status", "state": "stopped"})
                return
            if op == "exec":
                cmd = cmd_obj.get("cmd", "")
                if cmd not in WHITELIST:
                    emit({"t": "need", "reason": "refused", "cmd": cmd,
                          "detail": "not in v1 whitelist"})
                    continue
                emit({"t": "status", "state": "running", "cmd": cmd})
                try:
                    exit_code, output = run_cmd(cmd, cmd_obj.get("args", []))
                except Exception as e:  # surfaced, never swallowed
                    emit({"t": "status", "state": "ready", "cmd": cmd,
                          "exit": -1, "output": f"wing error: {e}"})
                    continue
                emit({"t": "status", "state": "ready", "cmd": cmd,
                      "exit": exit_code, "output": output})
        time.sleep(0.1)


if __name__ == "__main__":
    main()
