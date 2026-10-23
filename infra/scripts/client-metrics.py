#!/usr/bin/env python3
"""client-metrics.py — percentiles of the editor's session reports (plan G4).

Reads either source on stdin (or the files named) and prints, per metric and
label set, the number of reports and p50 / p75 / p95:

  * the server's logs: one JSON line per report, message `client session
    metrics` (routes/clientMetrics.ts) — exact percentiles, every report since
    the logs begin;
        docker logs narrative-server 2>&1 | infra/scripts/client-metrics.py
  * `/metrics` (Prometheus text): the in-memory histograms since the server
    started — percentiles interpolated inside the buckets, as Prometheus'
    histogram_quantile does;
        docker exec narrative-server sh -c \\
          'wget -qO- --header "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3001/metrics' \\
          | infra/scripts/client-metrics.py
    (on the VM: the token expands inside the container; docs/ops.md "Metrics")

Options: --since ISO-8601 (log lines only: reports at or after it).
docs/ops.md "Client session metrics" explains each metric.
"""

from __future__ import annotations

import argparse
import fileinput
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

QUANTILES = (0.5, 0.75, 0.95)

# Log report field → metric name, in the order printed.
FIELDS = [
    ("nav.ttfbMs", "nav ttfb"),
    ("nav.fcpMs", "nav fcp"),
    ("nav.domContentLoadedMs", "nav domContentLoaded"),
    ("deckLoad.wsConnectedMs", "deck wsConnected"),
    ("deckLoad.wsSyncedMs", "deck wsSynced"),
    ("deckLoad.pixiReadyMs", "deck pixiReady"),
    ("deckLoad.firstPaintMs", "deck firstPaint"),
    ("deckLoad.longTaskMs", "deck longTask ms"),
    ("longTasks.count", "session longTasks"),
    ("longTasks.totalMs", "session longTask ms"),
    ("longTasks.maxMs", "session longest task"),
    ("inp.inpMs", "inp"),
]


def exact_quantile(values: list[float], q: float) -> float:
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo, hi = math.floor(pos), math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def bucket_quantile(buckets: list[tuple[float, float]], q: float) -> float:
    """histogram_quantile: cumulative (le, count) pairs, +Inf last."""
    total = buckets[-1][1]
    if total == 0:
        return math.nan
    rank = q * total
    prev_le, prev_count = 0.0, 0.0
    for le, count in buckets:
        if count >= rank:
            if math.isinf(le):
                return prev_le  # beyond the last finite bound
            if count == prev_count:
                return le
            return prev_le + (le - prev_le) * (rank - prev_count) / (count - prev_count)
        prev_le, prev_count = le, count
    return prev_le


def dig(obj: dict, path: str):
    for key in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(key)
    return obj


def from_logs(lines: list[str], since: datetime | None) -> dict[tuple[str, str], list[float]]:
    series: dict[tuple[str, str], list[float]] = defaultdict(list)
    for line in lines:
        start = line.find("{")
        if start < 0:
            continue
        try:
            entry = json.loads(line[start:])
        except json.JSONDecodeError:
            continue
        if entry.get("msg") != "client session metrics":
            continue
        if since is not None and isinstance(entry.get("time"), (int, float)):
            if datetime.fromtimestamp(entry["time"] / 1000, timezone.utc) < since:
                continue
        report = entry.get("clientMetrics") or {}
        route = report.get("route", "?")
        deck = report.get("deckLoad") or {}
        load = "cold" if deck.get("cold") else "warm"
        for path, name in FIELDS:
            value = dig(report, path)
            if value is None:
                continue
            labels = f"route={route}" + (f" load={load}" if path.startswith("deckLoad.") else "")
            series[(name, labels)].append(float(value))
    return series


SAMPLE = re.compile(r"^(narrative_client_[a-z_]+)_bucket\{(.*)\} (\S+)$")


def from_prometheus(lines: list[str]) -> dict[tuple[str, str], list[tuple[float, float]]]:
    series: dict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    for line in lines:
        m = SAMPLE.match(line.strip())
        if not m:
            continue
        name, raw_labels, value = m.groups()
        labels = dict(re.findall(r'(\w+)="([^"]*)"', raw_labels))
        le = labels.pop("le")
        key = (name.removeprefix("narrative_client_"), " ".join(f"{k}={v}" for k, v in labels.items()))
        series[key].append((math.inf if le == "+Inf" else float(le), float(value)))
    return series


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("files", nargs="*", help="log or /metrics files (default: stdin)")
    parser.add_argument("--since", help="ISO-8601; log lines only")
    args = parser.parse_args()
    since = datetime.fromisoformat(args.since).astimezone(timezone.utc) if args.since else None

    lines = list(fileinput.input(args.files or ["-"]))
    header = f"{'metric':<24} {'labels':<26} {'n':>6} " + " ".join(f"{'p' + str(int(q * 100)):>8}" for q in QUANTILES)

    if any(SAMPLE.match(l.strip()) for l in lines):
        hist = from_prometheus(lines)
        print("source: /metrics histograms (since the server started; interpolated)")
        print(header)
        for (name, labels), buckets in sorted(hist.items()):
            total = buckets[-1][1]
            if total == 0:
                continue
            qs = " ".join(f"{bucket_quantile(buckets, q):>8.0f}" for q in QUANTILES)
            print(f"{name:<24} {labels:<26} {int(total):>6} {qs}")
        return 0

    logs = from_logs(lines, since)
    if not logs:
        print("no client session metrics found (neither report log lines nor /metrics histograms)", file=sys.stderr)
        return 1
    print("source: server log lines (exact)")
    print(header)
    order = {name: i for i, (_, name) in enumerate(FIELDS)}
    for (name, labels), values in sorted(logs.items(), key=lambda kv: (order[kv[0][0]], kv[0][1])):
        qs = " ".join(f"{exact_quantile(values, q):>8.0f}" for q in QUANTILES)
        print(f"{name:<24} {labels:<26} {len(values):>6} {qs}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
