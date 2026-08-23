#!/usr/bin/env python3
"""Validate the JSONL seed against the benchmark's Draft 2020-12 schema."""

from __future__ import annotations

import json
from copy import deepcopy
from itertools import chain
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


BENCHMARK_ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = BENCHMARK_ROOT / "schema" / "item.schema.json"
DATA_PATH = BENCHMARK_ROOT / "data" / "raw" / "synthetic-seed-v0.1.jsonl"


def load_jsonl(path: Path) -> tuple[dict[str, Any], ...]:
    """Load non-empty JSONL records without mutating the raw file."""
    return tuple(map(json.loads, filter(str.strip, path.read_text(encoding="utf-8").splitlines())))


def format_errors(
    indexed_item: tuple[int, dict[str, Any]],
    validator: Draft202012Validator,
) -> tuple[str, ...]:
    """Return stable, line-addressed validation errors for one item."""
    line_number, item = indexed_item
    errors = sorted(validator.iter_errors(item), key=lambda error: tuple(error.absolute_path))
    return tuple(
        map(
            lambda error: (
                f"line {line_number} at "
                f"{'.'.join(map(str, error.absolute_path)) or '<root>'}: {error.message}"
            ),
            errors,
        )
    )


def main() -> None:
    """Validate the schema and every seed record, then emit a compact report."""
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    records = load_jsonl(DATA_PATH)
    errors = tuple(
        chain.from_iterable(
            map(lambda pair: format_errors(pair, validator), enumerate(records, start=1))
        )
    )
    probes: list[tuple[str, dict[str, Any]]] = []
    inconsistent_synthetic = deepcopy(records[0])
    inconsistent_synthetic["synthetic"] = False
    probes.append(("synthetic/provenance contradiction", inconsistent_synthetic))
    pass_contradicted = deepcopy(records[0])
    pass_contradicted["expected"]["support_status"] = "CONTRADICTED"
    probes.append(("PASS/CONTRADICTED contradiction", pass_contradicted))
    abstain_without_error = deepcopy(records[3])
    abstain_without_error["expected"]["error_tags"] = []
    probes.append(("ABSTAIN without error tag", abstain_without_error))
    accepted_invalid_probes = tuple(
        name for name, probe in probes if not tuple(validator.iter_errors(probe))
    )
    if accepted_invalid_probes:
        errors += tuple(
            f"schema accepted invalid probe: {name}" for name in accepted_invalid_probes
        )
    if errors:
        raise SystemExit("SCHEMA_VALIDATION_FAILED\n" + "\n".join(errors))
    print(json.dumps({"status": "PASS", "records": len(records)}, sort_keys=True))


if __name__ == "__main__":
    main()
