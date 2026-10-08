"""Validate production-generated wire payloads against Codex's generated JSON schemas."""
import json
import sys
from pathlib import Path

from jsonschema import validators


def property_names(schema):
    names = set(schema.get("properties", {}))
    for keyword in ("oneOf", "anyOf", "allOf"):
        for branch in schema.get(keyword, []):
            names.update(property_names(branch))
    return names


def validate_cases(schema_dir, cases):
    failures = []
    if not cases:
        return ["No contract cases were exported."]
    for index, case in enumerate(cases):
        name, payload = case["schema"], case["payload"]
        files = list(schema_dir.rglob(name + ".json"))
        label = f"case {index + 1} ({name})"
        if len(files) != 1:
            failures.append(f"{label}: expected one schema, found {len(files)}")
            continue
        schema = json.loads(files[0].read_text())
        validator_type = validators.validator_for(schema)
        validator_type.check_schema(schema)
        # Codex accepts unknown fields; reject typos and removed field names in our payloads.
        unknown = set(payload) - property_names(schema)
        if unknown:
            failures.append(f"{label}: unknown fields: {sorted(unknown)}")
        for error in validator_type(schema).iter_errors(payload):
            location = ".".join(map(str, error.absolute_path)) or "<root>"
            failures.append(f"{label} at {location}: {error.message}")
    return failures


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: check_codex_contracts.py SCHEMA_DIRECTORY CONTRACT_CASES_JSON")
    cases = json.loads(Path(sys.argv[2]).read_text())
    failures = validate_cases(Path(sys.argv[1]), cases)
    if failures:
        sys.exit("\n".join(failures))
    print(f"Validated {len(cases)} Codex protocol payloads.")
