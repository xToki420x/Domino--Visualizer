#!/usr/bin/env bash
# Parses the release workflow and prints its shape.
#
# A workflow with a YAML mistake is only discovered by pushing, which costs a
# full build; parsing it locally costs nothing.
set -uo pipefail
python3 - "$@" <<'PY'
import sys
try:
    import yaml
except ImportError:
    print("PyYAML not available; skipping parse")
    sys.exit(0)

path = sys.argv[1] if len(sys.argv) > 1 else "/mnt/e/milkytoy/.github/workflows/release.yml"
with open(path) as handle:
    doc = yaml.safe_load(handle)

print("permissions:", doc.get("permissions"))
for name, job in doc["jobs"].items():
    needs = job.get("needs")
    print(f"{name}: runs-on={job.get('runs-on')} needs={needs} steps={len(job.get('steps', []))}")
    for step in job.get("steps", []):
        label = step.get("name") or step.get("uses")
        print(f"   - {label}")
PY
