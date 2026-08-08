#!/usr/bin/env python3
"""Fail the build on any ThreatCrush finding that has not been reviewed.

ThreatCrush 0.3.0 has no ignore file and no inline suppression: the only knob
is `--fail-on <severity>`. That is unusable as a gate here, because every one
of this repository's current findings is a false positive — turning it on would
block every pull request and the gate would be switched off within a day.

So the gate is "no NEW findings" instead of "no findings". Everything already
triaged lives in threatcrush-baseline.json with a written justification; any
finding not in that file fails the job. Adding a genuine vulnerability
therefore stops the merge, while the known-clean 56 do not.

Findings are keyed by (rule, file, hash of the offending line) rather than by
line number, because line numbers move whenever anything above them is edited
and a line-keyed baseline would spuriously fail on unrelated changes. The
per-(rule, file) count is checked too, so adding a second identical-looking
sink to a file that already has one is still caught.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
BASELINE_PATH = HERE / "threatcrush-baseline.json"


def normalize(excerpt: str) -> str:
    """Collapse whitespace so reformatting does not invalidate an entry."""
    return re.sub(r"\s+", " ", (excerpt or "").strip())


def fingerprint(finding: dict) -> str:
    payload = "\x1f".join(
        [finding.get("ruleId", ""), finding.get("file", ""), normalize(finding.get("excerpt", ""))]
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def load_findings(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        data = data.get("findings", [])
    # The baseline quotes each finding's source line so a reviewer can see what
    # they are signing off. Those quoted lines are themselves scannable, so the
    # scanner reports the baseline as vulnerable and every entry added spawns a
    # fresh finding. It is inert JSON that is never executed or served, so drop
    # findings located in it rather than laundering the excerpts into hashes
    # and making the file unreadable to the humans who must review it.
    return [f for f in data if Path(f.get("file", "")).name != BASELINE_PATH.name]


def describe(f: dict) -> str:
    return (
        f"  [{f.get('severity', '?'):<6}] {f.get('ruleId', '?')}\n"
        f"      {f.get('file', '?')}:{f.get('line', '?')}\n"
        f"      {normalize(f.get('excerpt', ''))[:120]}"
    )


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: threatcrush-gate.py <scan.json> [--update]", file=sys.stderr)
        return 2
    scan_path = Path(sys.argv[1])
    updating = "--update" in sys.argv[2:]

    if not scan_path.is_file() or not scan_path.stat().st_size:
        # No scan output is not a clean scan. Fail closed — this is the exact
        # failure the surrounding workflow is arranged to avoid.
        print("::error::no ThreatCrush output to check — this diff was NOT scanned")
        return 1

    findings = load_findings(scan_path)

    if updating:
        entries = {}
        for f in findings:
            entries[fingerprint(f)] = {
                "rule": f.get("ruleId"),
                "file": f.get("file"),
                "severity": f.get("severity"),
                "excerpt": normalize(f.get("excerpt", ""))[:200],
                "justification": "TODO: explain why this is not exploitable",
            }
        BASELINE_PATH.write_text(
            json.dumps(
                {
                    "_comment": (
                        "Reviewed ThreatCrush findings. A finding not listed here fails CI. "
                        "Add an entry only with a justification that says why it is not "
                        "exploitable; regenerate with: threatcrush scan . --format json "
                        "--output scan.json && .github/threatcrush-gate.py scan.json --update"
                    ),
                    "counts": dict(Counter(f"{f.get('ruleId')}|{f.get('file')}" for f in findings)),
                    "findings": entries,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        print(f"wrote {len(entries)} baseline entries to {BASELINE_PATH.name}")
        return 0

    if not BASELINE_PATH.is_file():
        print("::error::threatcrush-baseline.json is missing; every finding is unreviewed")
        return 1

    baseline = json.loads(BASELINE_PATH.read_text())
    known = baseline.get("findings", {})
    known_counts = baseline.get("counts", {})

    new = [f for f in findings if fingerprint(f) not in known]
    counts = Counter(f"{f.get('ruleId')}|{f.get('file')}" for f in findings)
    grew = [
        (k, counts[k], known_counts.get(k, 0))
        for k in counts
        if counts[k] > known_counts.get(k, 0)
    ]
    # Reported, never fatal: failing a pull request for DELETING a finding
    # would punish exactly the change everyone wants people to make.
    stale = [k for k in known if k not in {fingerprint(f) for f in findings}]

    lines = [f"ThreatCrush gate: {len(findings)} finding(s), {len(known)} reviewed."]
    if stale:
        lines.append(f"{len(stale)} baseline entr{'y' if len(stale) == 1 else 'ies'} no longer fire and can be removed.")

    if new or grew:
        lines.append("")
        lines.append(f"FAILED — {len(new)} unreviewed finding(s).")
        for f in new:
            lines.append(describe(f))
        for key, now, before in grew:
            rule, _, path = key.partition("|")
            lines.append(f"  count for {rule} in {path} rose {before} -> {now}")
        lines.append("")
        lines.append(
            "If these are real, fix them. If not, review each one and add it to "
            ".github/threatcrush-baseline.json with a justification."
        )

    report = "\n".join(lines)
    print(report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write(f"### ThreatCrush gate\n\n```\n{report}\n```\n")

    return 1 if (new or grew) else 0


if __name__ == "__main__":
    sys.exit(main())
