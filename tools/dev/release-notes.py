#!/usr/bin/env python3
"""A release's GitHub title and notes, from its CHANGELOG.md section.

    tools/dev/release-notes.py v0.12.3 --title   # "v0.12.3 — The images build again"
    tools/dev/release-notes.py v0.12.3           # the section's body, Markdown

`just gh-release vX.Y.Z` feeds both to `gh release create`, so the release
page says what the changelog says. Exits 1 when the version has no section:
a release is cut only after its changelog entry is written.
"""

import re
import sys
from pathlib import Path

CHANGELOG = Path(__file__).resolve().parents[2] / "CHANGELOG.md"
HEADING = re.compile(r"^## (\d+\.\d+\.\d+)(?: — (.*?))?(?: \((\d{4}-\d{2}-\d{2})\))?\s*$")


def section(version: str) -> tuple[str, str]:
    """The section's title (after the version) and body (up to the next section)."""
    lines = CHANGELOG.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        m = HEADING.match(line)
        if m is None or m.group(1) != version:
            continue
        end = next(
            (j for j in range(i + 1, len(lines)) if lines[j].startswith("## ")), len(lines)
        )
        body = "\n".join(lines[i + 1 : end]).strip()
        # A trailing rule separates sections in some places; not part of the notes.
        body = re.sub(r"\n+---\s*$", "", body).strip()
        return (m.group(2) or "").strip(), body
    raise LookupError(version)


def main() -> int:
    args = sys.argv[1:]
    if not args or not re.fullmatch(r"v?\d+\.\d+\.\d+", args[0]):
        print("usage: release-notes.py vX.Y.Z [--title]", file=sys.stderr)
        return 2
    version = args[0].lstrip("v")
    try:
        title, body = section(version)
    except LookupError:
        print(f"release-notes: CHANGELOG.md has no section for {version}", file=sys.stderr)
        return 1
    if "--title" in args[1:]:
        print(f"v{version} — {title}" if title else f"v{version}")
    else:
        print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
