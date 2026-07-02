"""Wrap a completed RDE campaign run as a station audit bundle (lane B).

Usage: python scripts/rde-claim-wrap.py <rde_run_dir>

Builds <run_dir>/bundle/ per the grader contract (grader.cjs):
  best_solution.py  -- the run's artifact, byte-verified against result.json
  check.py          -- trusted-oracle check: imports the RDE domain module and
                       uses its OWN generator/driver/verdict verbatim
  claim.json        -- statement quotes the run's DECLARED verdict; the
                       reproducible bar (weighted competitive ratio floor) is
                       calibrated by MEASURING on the domain's declared
                       benchmark seeds, then left for the grader to test on
                       holdout seeds the claimant never chose.

Mirrors wings/director2/d2-wing.py run_mission() for RDE runs. The claimant
(this script) never runs the grader; certification happens only through
scripts/claim-gate.mjs -> grader.cjs.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

RDE = Path("E:/recursive-discovery-engine")
FLOOR_MARGIN = 0.03          # honest slack under the worst claimed-seed measurement

CHECK_TEMPLATE = '''\
"""Trusted-oracle check for this audit bundle (grader contract).

Usage: python check.py <seed> [--measure]
Exits 0 iff the bundled best_solution.py, run through the RDE domain's OWN
driver on every workload of the domain's DECLARED benchmark suite regenerated
with the given seed, (a) yields a valid verdict on each workload (the domain's
own anti-cheat comparator) and (b) reaches weighted competitive ratio vs
Belady >= FLOOR. All generator/driver/verdict logic is imported from the RDE
repo -- nothing is reimplemented here. --measure reports without enforcing.
"""
import importlib.util
import sys
from pathlib import Path

RDE = __RDE__
DOMAIN = __DOMAIN__
FLOOR = __FLOOR__


def main():
    seed = int(sys.argv[1])
    measure = "--measure" in sys.argv
    sys.path.insert(0, RDE)
    import importlib
    dom = importlib.import_module("rde.domains." + DOMAIN)

    here = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(
        "candidate", here / "best_solution.py")
    cand = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cand)
    sys.modules["candidate"] = cand          # the domain driver imports this name

    acc = 0.0
    total_w = 0.0
    for w in dom.BENCHMARK_SUITE:
        items = dom.gen_workload(w["n"], w["dist"], seed)
        got = dom._driver_solve(list(items), w["k"])
        expected = dom.oracle(list(items), w["k"])
        ok, quality = dom.verdict(got, expected, items, w["k"])
        if not ok:
            print("FAIL {0} seed={1}: domain verdict rejected".format(
                w["name"], seed))
            return 1
        acc += w["weight"] * quality
        total_w += w["weight"]
        print("ok {0} seed={1} cr={2}".format(w["name"], seed, quality))
    wcr = acc / total_w
    print("weighted_cr={0:.6f} floor={1}".format(wcr, FLOOR))
    if measure:
        return 0
    return 0 if wcr >= FLOOR else 1


if __name__ == "__main__":
    sys.exit(main())
'''


def main():
    run_dir = Path(sys.argv[1]).resolve()
    claims = json.loads((run_dir / "claims.json").read_text(encoding="utf-8"))
    result = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    domain = claims["domain"]

    artifact = run_dir / "best_solution.py"
    if not artifact.is_file():
        raise SystemExit(f"run has no best_solution.py: {run_dir}")
    # Honest bundling: the artifact must BE the run's recorded best candidate.
    if artifact.read_text(encoding="utf-8").strip() != result["best"]["code"].strip():
        raise SystemExit("best_solution.py does not match result.json best.code")

    # claimed_seeds: the domain's own declared benchmark seeds -- never invented.
    sys.path.insert(0, str(RDE))
    import importlib
    dom = importlib.import_module("rde.domains." + domain)
    claimed_seeds = list(dom.BENCH_SEEDS)

    bundle = run_dir / "bundle"
    bundle.mkdir(exist_ok=True)
    shutil.copy2(artifact, bundle / "best_solution.py")

    def write_check(floor):
        (bundle / "check.py").write_text(
            CHECK_TEMPLATE
            .replace("__RDE__", repr(str(RDE)))
            .replace("__DOMAIN__", repr(domain))
            .replace("__FLOOR__", repr(floor)),
            encoding="utf-8")

    # Calibrate the floor by measuring on the claimed seeds (floor 0 first).
    write_check(0.0)
    measured = []
    for seed in claimed_seeds:
        proc = subprocess.run(
            [sys.executable, "check.py", str(seed), "--measure"],
            cwd=str(bundle), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=120)
        if proc.returncode != 0:
            raise SystemExit(
                f"measure failed on claimed seed {seed}:\n{proc.stdout}{proc.stderr}")
        m = re.search(r"weighted_cr=([0-9.]+)", proc.stdout)
        if not m:
            raise SystemExit(f"no weighted_cr in check output for seed {seed}")
        measured.append(float(m.group(1)))
        print(f"[measure] seed={seed} weighted_cr={m.group(1)}")
    floor = round(min(measured) - FLOOR_MARGIN, 2)
    write_check(floor)

    # Statement quotes the run's DECLARED verdict verbatim -- never inflated.
    statement = (
        f'campaign {claims["run_id"]} ({domain}, status {claims["status"]}): '
        f'declared "{claims["recommended"]}", grade '
        f'{claims["recommended_grade"]["static"]} '
        f'(static_margin {claims["recommended_grade"]["static_margin"]}), '
        f'robust_beats {claims["robust_beats"]}; reproducible fact: weighted '
        f'competitive ratio vs Belady >= {floor} on the domain\'s declared '
        f'benchmark suite (measured min {min(measured):.4f} over claimed seeds)')

    (bundle / "claim.json").write_text(json.dumps({
        "id": claims["run_id"],
        "statement": statement,
        "check": ["python", "check.py", "{seed}"],
        "claimed_seeds": claimed_seeds,
    }, indent=1), encoding="utf-8")

    print(f"[bundle] {bundle}")
    print(f"[claim] {statement}")


if __name__ == "__main__":
    main()
