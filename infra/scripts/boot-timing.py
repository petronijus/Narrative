#!/usr/bin/env python3
"""boot-timing.py — how long the server took to come up, read afterwards (plan D3).

Read-only: it runs `docker inspect` and `docker logs --timestamps` for the
server container and prints, from the container's start, when each step of
the boot happened:

  created → started              Docker: the container created, its process started
  first log line                 module loading done (nothing logs before it in production)
  restore check                  ADR 0017's boot check (instanceGeneration.ts), and what it said
  MCP server ready               the tool catalogue built
  Hocuspocus listening           the sync server's port open
  Fastify listening              the API's port open
  first GET /health 200          the first health probe answered (the server's request log)
  Docker healthy                 the first passing healthcheck Docker still remembers

Timestamps are the Docker daemon's (when each line reached it), so every step
is measured on one clock. Run it on the VM after a deploy or a restart:

    infra/scripts/boot-timing.py                    # narrative-server
    infra/scripts/boot-timing.py --json             # the same, for the Log
    docker logs -t narrative-server > boot.log      # or keep the lines and read them later:
    infra/scripts/boot-timing.py --logs boot.log --started-at 2026-10-23T10:00:00.123Z

The restart's other half — the old container's stop — is in the logs
deploy.sh keeps of the outgoing server (backups/logs/server-<tag>-<time>.log.gz):

    infra/scripts/boot-timing.py --previous /opt/narrative/backups/logs/server-v0.15.0-….log.gz

adds SIGTERM → last line of the old process (the documents stored, the
connections closed) and the gap from there to the new container's start.

Docker keeps the last five healthcheck results only (every 15 s), so read
the "Docker healthy" row within a minute of the start; the request-log row
does not expire with it. It also reports whether /metrics was registered
(the METRICS_TOKEN warning absent) and whether the boot found a restore
marker — the two settings this release adds.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any

TS_RE = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$")


def parse_ts(value: str) -> datetime:
    """RFC 3339 with up to nanoseconds (Docker's format) → aware datetime (µs)."""
    m = TS_RE.match(value.strip())
    if not m:
        raise ValueError(f"not an RFC 3339 timestamp: {value!r}")
    base, frac, zone = m.groups()
    frac = (frac or "0")[:6].ljust(6, "0")
    zone = "+00:00" if zone == "Z" else zone
    return datetime.fromisoformat(f"{base}.{frac}{zone}").astimezone(timezone.utc)


def docker(*args: str) -> str:
    try:
        out = subprocess.run(
            ["docker", *args], check=True, capture_output=True, text=True
        )
    except FileNotFoundError:
        sys.exit("boot-timing.py: docker is not on PATH")
    except subprocess.CalledProcessError as exc:
        sys.exit(f"boot-timing.py: docker {' '.join(args[:2])} failed: {exc.stderr.strip()}")
    return out.stdout


def docker_logs(container: str, since: str) -> list[str]:
    # Both streams, interleaved by the daemon's timestamps.
    proc = subprocess.run(
        ["docker", "logs", "--timestamps", "--since", since, container],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    return proc.stdout.splitlines()


def split_line(line: str) -> tuple[datetime, str] | None:
    """`<timestamp> <payload>` as `docker logs -t` prints it."""
    stamp, _, payload = line.partition(" ")
    try:
        return parse_ts(stamp), payload
    except ValueError:
        return None


def message(payload: str) -> tuple[str, dict[str, Any] | None]:
    """The log message and, for a pino JSON line, the whole record."""
    text = payload.strip()
    if text.startswith("{"):
        try:
            record = json.loads(text)
        except json.JSONDecodeError:
            return text, None
        if isinstance(record, dict):
            return str(record.get("msg", "")), record
    return text, None


def analyse(lines: list[str], started: datetime) -> dict[str, Any]:
    steps: dict[str, dict[str, Any]] = {}
    health_requests: set[Any] = set()
    notes: dict[str, Any] = {"metrics_registered": True, "restore_check": None}

    def mark(name: str, at: datetime, **extra: Any) -> None:
        if name not in steps:
            steps[name] = {"at": at, **extra}

    for raw in lines:
        parsed = split_line(raw)
        if parsed is None:
            continue
        at, payload = parsed
        if at < started:
            continue
        msg, record = message(payload)
        mark("first log line", at)
        if "METRICS_TOKEN is unset" in msg:
            notes["metrics_registered"] = False
        if (
            "restore marker" in msg
            or "instance generation was missing" in msg
        ) and notes["restore_check"] is None:
            notes["restore_check"] = msg
            mark("restore check", at, detail=msg)
        if msg == "MCP server ready":
            mark("MCP server ready", at, detail=f"{(record or {}).get('tools', '?')} tools")
        if msg.startswith("[server] Hocuspocus WS running"):
            mark("Hocuspocus listening", at)
        if msg.startswith("Server listening at") or msg.startswith("[server] Fastify API running"):
            mark("Fastify listening", at)
        if record is not None:
            req = record.get("req")
            if msg == "incoming request" and isinstance(req, dict) and str(req.get("url", "")).split("?")[0] == "/health":
                health_requests.add(record.get("reqId"))
            if msg == "request completed" and record.get("reqId") in health_requests:
                res = record.get("res") or {}
                if res.get("statusCode") == 200:
                    rt = record.get("responseTime")
                    mark(
                        "first GET /health 200",
                        at,
                        detail=f"responseTime {rt:.1f} ms" if isinstance(rt, (int, float)) else None,
                    )

    if notes["restore_check"] is None:
        # A boot without any of the three messages found a marker and a
        # database that is not behind it: the quiet, normal case.
        notes["restore_check"] = "marker found, database not behind it (no message)" if "first log line" in steps else None
    return {"steps": steps, "notes": notes}


def previous_stop(path: str) -> dict[str, datetime]:
    """SIGTERM and the last line of the outgoing server's kept logs (plain or .gz)."""
    import gzip

    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as fh:  # type: ignore[operator]
        parsed = [p for p in map(split_line, fh.read().splitlines()) if p]
    if not parsed:
        sys.exit(f"boot-timing.py: no timestamped line in {path} (deploy.sh keeps `docker logs -t`)")
    out: dict[str, datetime] = {"last line": parsed[-1][0]}
    sigterm = next((at for at, payload in parsed if "Received SIGTERM" in payload), None)
    if sigterm is not None:
        out["SIGTERM"] = sigterm
    return out


ORDER = [
    "first log line",
    "MCP server ready",
    "restore check",
    "Hocuspocus listening",
    "Fastify listening",
    "first GET /health 200",
    "Docker healthy",
]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--container", default="narrative-server")
    ap.add_argument("--logs", help="read `docker logs -t` output from this file instead of Docker")
    ap.add_argument("--started-at", help="the container's start (RFC 3339); with --logs")
    ap.add_argument("--previous", help="the outgoing server's kept logs (deploy.sh: backups/logs/*.log.gz)")
    ap.add_argument("--json", action="store_true", help="print JSON")
    args = ap.parse_args()

    info: dict[str, Any] = {"container": args.container}
    health_log: list[dict[str, Any]] = []
    if args.logs:
        with open(args.logs, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
        if args.started_at:
            started = parse_ts(args.started_at)
        else:
            first = next((p for p in map(split_line, lines) if p), None)
            if first is None:
                sys.exit("boot-timing.py: no timestamped line in the file (use docker logs -t)")
            started = first[0]
            info["note"] = "no --started-at: measured from the first log line"
        created = None
    else:
        state = json.loads(docker("inspect", args.container))[0]
        if state["State"]["StartedAt"].startswith("0001-"):
            sys.exit(f"boot-timing.py: {args.container} has never started (status {state['State']['Status']})")
        started = parse_ts(state["State"]["StartedAt"])
        created = parse_ts(state["Created"])
        info.update(
            image=state["Config"]["Image"],
            status=state["State"]["Status"],
            health=(state["State"].get("Health") or {}).get("Status"),
            restarts=state.get("RestartCount"),
        )
        health_log = (state["State"].get("Health") or {}).get("Log") or []
        lines = docker_logs(args.container, state["State"]["StartedAt"])

    result = analyse(lines, started)
    steps = result["steps"]
    passing = [h for h in health_log if h.get("ExitCode") == 0 and h.get("Start")]
    if passing:
        first_ok = min(passing, key=lambda h: parse_ts(h["Start"]))
        older = len(health_log) >= 5 and parse_ts(health_log[0]["Start"]) > started
        steps["Docker healthy"] = {
            "at": parse_ts(first_ok["End"]),
            "detail": "earlier checks already rotated out — read within a minute of the start" if older else None,
        }

    def rel(at: datetime) -> float:
        return round((at - started).total_seconds(), 3)

    prev = previous_stop(args.previous) if args.previous else None
    stop: dict[str, Any] | None = None
    if prev is not None:
        stop = {
            "sigterm": prev["SIGTERM"].isoformat() if "SIGTERM" in prev else None,
            "last_line": prev["last line"].isoformat(),
            "sigterm_to_last_line_s": round((prev["last line"] - prev["SIGTERM"]).total_seconds(), 3) if "SIGTERM" in prev else None,
            "last_line_to_started_s": round((started - prev["last line"]).total_seconds(), 3),
        }

    if args.json:
        out = {
            **info,
            "created": created.isoformat() if created else None,
            "started": started.isoformat(),
            "created_to_started_s": None if created is None else round((started - created).total_seconds(), 3),
            "steps": {
                name: {"at": s["at"].isoformat(), "s": rel(s["at"]), **({"detail": s["detail"]} if s.get("detail") else {})}
                for name, s in sorted(steps.items(), key=lambda kv: ORDER.index(kv[0]))
            },
            **result["notes"],
            **({"previous_stop": stop} if stop is not None else {}),
        }
        print(json.dumps(out, indent=2))
        return

    print(f"{info['container']}  {info.get('image', '')}  status={info.get('status', '?')} health={info.get('health', '?')}")
    if stop is not None:
        if stop["sigterm"] is not None:
            print(f"  previous: SIGTERM  {stop['sigterm']}  ({stop['sigterm_to_last_line_s']} s to its last line)")
        print(f"  previous: last line {stop['last_line']}  ({stop['last_line_to_started_s']} s before this start)")
    if created is not None:
        print(f"  created            {created.isoformat()}  (start {round((started - created).total_seconds(), 3)} s later)")
    print(f"  started            {started.isoformat()}  +0.000 s")
    # In the order they happened; the steps that never did, last.
    for name, s in sorted(steps.items(), key=lambda kv: kv[1]["at"]):
        detail = f"  ({s['detail']})" if s.get("detail") else ""
        print(f"  {name:<22} +{rel(s['at']):.3f} s{detail}")
    for name in ORDER:
        if name not in steps:
            print(f"  {name:<22} —")
    notes = result["notes"]
    print(f"  /metrics registered: {'yes' if notes['metrics_registered'] else 'NO (METRICS_TOKEN unset in the container)'}")
    print(f"  restore check: {notes['restore_check'] or '—'}")
    if "note" in info:
        print(f"  note: {info['note']}")


if __name__ == "__main__":
    main()
