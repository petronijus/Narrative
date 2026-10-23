#!/usr/bin/env python3
"""availability-probe.py — what a visitor saw during a deploy (plan D3).

Polls the public health endpoint (and /version.json, more slowly) from the
workstation while `just deploy` runs, writes every probe to a JSON-lines
file and, when stopped (Ctrl-C, or --duration), prints the outage: the
longest stretch without a 200 from /api/health, first failure to first
success after it, and when the new version started to answer.

Read-only and public: the same requests any browser makes, through
Cloudflare, two to four a second. Nothing on the VM is touched.

    infra/scripts/availability-probe.py --out ~/deploy-v0.16.0.jsonl &
    just deploy v0.16.0
    kill -INT %1                                  # prints the summary

    infra/scripts/availability-probe.py --summary ~/deploy-v0.16.0.jsonl

The VM side of the same restart (container start → first log → listening →
first /health) is infra/scripts/boot-timing.py, run on the VM.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DOMAIN = "narrative.bastla.com"


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds")


def probe(url: str, timeout: float) -> tuple[int, str, float]:
    """(status, body head, seconds); status 0 = no HTTP answer."""
    t0 = time.monotonic()
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "narrative-availability-probe"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read(200).decode("utf-8", "replace")
            return res.status, body, time.monotonic() - t0
    except urllib.error.HTTPError as exc:
        return exc.code, "", time.monotonic() - t0
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, type(exc).__name__, time.monotonic() - t0


def summarise(rows: list[dict]) -> None:
    health = [r for r in rows if r["kind"] == "health"]
    versions = [r for r in rows if r["kind"] == "version" and r["status"] == 200]
    if not health:
        print("no health probes recorded")
        return
    bad = [r for r in health if r["status"] != 200]
    print(f"health probes: {len(health)} from {health[0]['at']} to {health[-1]['at']}, {len(bad)} without a 200")

    # Outages: maximal runs of non-200 probes, bounded by the last good probe
    # before and the first good one after (the outage is at most that long).
    outages = []
    start = None
    last_ok = None
    for r in health:
        if r["status"] == 200:
            if start is not None:
                outages.append((last_ok, start, r))
                start = None
            last_ok = r
        elif start is None:
            start = r
    if start is not None:
        outages.append((last_ok, start, None))
    for last_good, first_bad, first_good in outages:
        statuses = sorted({r["status"] for r in health if first_bad["t"] <= r["t"] <= (first_good or health[-1])["t"] and r["status"] != 200})
        if first_good is None:
            print(f"  outage from {first_bad['at']} — still failing at the end ({statuses})")
            continue
        lo = first_good["t"] - first_bad["t"]
        hi = first_good["t"] - (last_good["t"] if last_good else first_bad["t"])
        print(f"  outage {first_bad['at']} → {first_good['at']}: {lo:.1f}–{hi:.1f} s (statuses {statuses})")
    slow = sorted(health, key=lambda r: r["s"], reverse=True)[:3]
    print("  slowest answers: " + ", ".join(f"{r['s']:.2f} s ({r['status']}) at {r['at']}" for r in slow))

    seen: list[tuple[str, str]] = []
    for r in versions:
        if not seen or seen[-1][1] != r["body"]:
            seen.append((r["at"], r["body"]))
    for at, body in seen:
        print(f"  version {body.strip()} from {at}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--domain", default=DEFAULT_DOMAIN)
    ap.add_argument("--interval", type=float, default=0.5, help="seconds between health probes (default 0.5)")
    ap.add_argument("--timeout", type=float, default=5.0)
    ap.add_argument("--duration", type=float, help="stop after this many seconds")
    ap.add_argument("--out", type=Path, help="JSON-lines file of every probe")
    ap.add_argument("--summary", type=Path, help="summarise an earlier --out file and exit")
    args = ap.parse_args()

    if args.summary:
        summarise([json.loads(line) for line in args.summary.read_text().splitlines() if line.strip()])
        return

    stop = False

    def on_signal(*_: object) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    health_url = f"https://{args.domain}/api/health"
    version_url = f"https://{args.domain}/version.json"
    rows: list[dict] = []
    out = args.out.open("a", encoding="utf-8") if args.out else None
    began = time.time()
    next_version = 0.0
    print(f"probing {health_url} every {args.interval} s (Ctrl-C to stop)", file=sys.stderr)
    while not stop and (args.duration is None or time.time() - began < args.duration):
        tick = time.time()
        targets = [("health", health_url)]
        if tick >= next_version:
            targets.append(("version", version_url))
            next_version = tick + 2.0
        for kind, url in targets:
            t = time.time()
            status, body, secs = probe(url, args.timeout)
            row = {"kind": kind, "t": round(t, 3), "at": iso(t), "status": status, "s": round(secs, 3), "body": body if kind == "version" else ""}
            rows.append(row)
            if out:
                out.write(json.dumps(row) + "\n")
                out.flush()
        time.sleep(max(0.0, args.interval - (time.time() - tick)))
    if out:
        out.close()
    summarise(rows)


if __name__ == "__main__":
    main()
