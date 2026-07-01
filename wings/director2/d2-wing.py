"""Wing Protocol v1 adapter for director2-harness.

Runs whitelisted `director` CLI commands as subprocesses (cwd = the harness
repo, so its local `director` package shadows any installed one) and streams
results as protocol events. Discovery runs arrive via the Phase 5 `mission`
op (never through the exec whitelist): dispatch a campaign, then emit a claim
carrying a real audit bundle — trusted-oracle check + verbatim verdict.
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HARNESS = Path(os.environ.get("D2_HARNESS", "E:/director2-harness"))
SPOOL = Path(os.environ["WING_SPOOL"])
WHITELIST = {"init", "status", "new", "advance", "tasks", "modules", "risks", "history"}
OUTPUT_TAIL = 4000
MISSION_TIMEOUT = 600  # a campaign takes ~40s+ even on the mock backend
_TRUTHY = {"1", "true", "yes", "on"}  # mirrors director.config._TRUTHY
# Diagnoses-only ethos: qualitative fields cross the seam VERBATIM; raw valence
# floats (valence, peak_valence, ...) stay in trusted code and NEVER cross.
_FELT_FIELDS = ("narrative", "trajectory", "duration_cycles")


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


# --- mission: dispatch a discovery campaign, build an audit bundle ----------
#
# The bundle's check.py is a TRUSTED-ORACLE check: it imports the harness's
# own domain module and calls the domain's oracle / workload generator /
# verdict verbatim — it never reimplements any of that logic. The grader can
# therefore exercise the bundled artifact itself on seeds the claimant never
# chose.
_CHECK_TEMPLATE = '''\
"""Trusted-oracle check for this audit bundle (grader contract).

Usage: python check.py <seed>
Exits 0 iff the bundled best_solution.py's output matches the domain's own
trusted oracle on every workload shape the domain declares, regenerated with
the given seed. All oracle/generator/verdict logic is imported from the
harness — nothing is reimplemented here.
"""
import sys
from pathlib import Path

HARNESS = __HARNESS__
DOMAIN = __DOMAIN__


def main():
    seed = int(sys.argv[1])
    sys.path.insert(0, HARNESS)
    from director.evolve.domains import get_domain
    spec = get_domain(DOMAIN).spec()

    trusted = {}
    exec(spec.oracle_src, trusted)           # the domain's own oracle
    exec(spec.workload_gen_src, trusted)     # the domain's own generator
    if spec.verdict_src:
        exec(spec.verdict_src, trusted)      # the domain's own comparator
    oracle = trusted["oracle"]
    gen_workload = trusted["gen_workload"]
    verdict = trusted.get("verdict")

    sol_ns = {}
    src = (Path(__file__).resolve().parent / "best_solution.py").read_text(
        encoding="utf-8")
    exec(src, sol_ns)
    solve = sol_ns[spec.func_name]

    for w in spec.workloads:
        items = gen_workload(w["n"], w["dist"], seed)
        k = w.get("k")
        expected = oracle(list(items), k)
        got = solve(list(items), k)
        if verdict is not None:
            ok, quality = verdict(got, expected, items, k)
        else:
            ok = list(got) == list(expected)
            quality = 1.0 if ok else 0.0
        if not ok:
            print(f"FAIL {w['name']} seed={seed} quality={quality}")
            return 1
        print(f"ok {w['name']} seed={seed} quality={quality}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
'''


def _mission_env():
    return {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}


def _find_run_dir(output):
    """Locate the campaign's artifact dir: the CLI prints 'artifacts: <path>';
    fall back to the newest directory under <DIRECTOR_HOME>/runs/."""
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("artifacts:"):
            p = Path(line.split("artifacts:", 1)[1].strip())
            if p.is_dir():
                return p
    home = os.environ.get("DIRECTOR_HOME", "")
    runs = Path(home) / "runs" if home else None
    if runs and runs.is_dir():
        dirs = [d for d in runs.iterdir() if d.is_dir()]
        if dirs:
            return max(dirs, key=lambda d: d.stat().st_mtime)
    raise RuntimeError("campaign artifact directory not found "
                       "(no 'artifacts:' line, no runs/ dir)")


def _claimed_seeds(domain):
    """The domain's own benchmark seeds, read from its spec — never invented."""
    snippet = (
        "import json, sys; from director.evolve.domains import get_domain; "
        f"spec = get_domain({domain!r}).spec(); "
        "print(json.dumps([w['seed'] for w in spec.workloads if 'seed' in w]))")
    proc = subprocess.run(
        [sys.executable, "-c", snippet],
        cwd=str(HARNESS), env=_mission_env(), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"could not read domain benchmark seeds: "
                           f"{(proc.stdout + proc.stderr).strip()[-500:]}")
    seeds = json.loads(proc.stdout.strip())
    if not seeds:
        raise RuntimeError(f"domain '{domain}' declares no benchmark seeds")
    return seeds


def run_mission(domain):
    """Run one campaign, build the audit bundle, return the claim event."""
    proc = subprocess.run(
        [sys.executable, "-m", "director", "evolve", "run", domain],
        cwd=str(HARNESS), env=_mission_env(), capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=MISSION_TIMEOUT,
    )
    out = proc.stdout + proc.stderr
    if proc.returncode != 0:
        raise RuntimeError(f"evolve run exited {proc.returncode}: "
                           f"{out.strip()[-OUTPUT_TAIL:]}")
    run_dir = _find_run_dir(out)
    result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))

    artifact = run_dir / "best_solution.py"
    if not artifact.is_file():
        raise RuntimeError(f"run has no best_solution.py: {run_dir}")

    # Statement quotes the DECLARED verdict verbatim — never inflated.
    statement = (
        f'campaign {result["domain"]}: declared verdict "{result["verdict"]}", '
        f'best_quality {result["best_quality"]} vs baseline '
        f'{result["baseline_quality"]}')

    bundle = run_dir / "bundle"
    bundle.mkdir(exist_ok=True)
    shutil.copy2(artifact, bundle / "best_solution.py")
    check_src = (_CHECK_TEMPLATE
                 .replace("__HARNESS__", repr(str(HARNESS)))
                 .replace("__DOMAIN__", repr(result["domain"])))
    (bundle / "check.py").write_text(check_src, encoding="utf-8")
    (bundle / "claim.json").write_text(json.dumps({
        "statement": statement,
        "check": ["python", "check.py", "{seed}"],
        "claimed_seeds": _claimed_seeds(result["domain"]),
    }, indent=1), encoding="utf-8")

    return {"t": "claim", "id": result.get("run_id"),
            "bundle": str(bundle.resolve()), "statement": statement}


def felt_state():
    """Read each project's persisted self_state and relay it without invention."""
    nervous = os.environ.get(
        "DIRECTOR_NERVOUS_ENABLED", "").strip().lower() in _TRUTHY
    projects = []
    home = os.environ.get("DIRECTOR_HOME", "")
    proj_root = Path(home) / "projects" if home else None
    if proj_root and proj_root.is_dir():
        for d in sorted(proj_root.iterdir()):
            snap = d / "project.json"
            if not d.is_dir() or not snap.is_file():
                continue
            try:
                data = json.loads(snap.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue  # unreadable snapshot: skip, never invent
            ss = data.get("self_state") or {}
            entry = {"id": d.name}
            for k in _FELT_FIELDS:  # verbatim relay, whitelisted keys only
                entry[k] = ss.get(k)
            projects.append(entry)
    return {"t": "felt-state", "nervous": nervous, "projects": projects}


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
            if op == "felt":
                emit(felt_state())
                continue
            if op == "mission":
                emit({"t": "status", "state": "running", "cmd": "mission"})
                try:
                    claim = run_mission(cmd_obj.get("domain", ""))
                except Exception as e:  # no claim without a real bundle
                    emit({"t": "need", "reason": "mission-failed",
                          "detail": str(e)[-OUTPUT_TAIL:]})
                    emit({"t": "status", "state": "ready", "cmd": "mission",
                          "exit": -1})
                    continue
                emit(claim)
                emit({"t": "status", "state": "ready", "cmd": "mission",
                      "exit": 0})
                continue
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
