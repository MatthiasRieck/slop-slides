"""Ensure the compatibility gate fails on malformed or obsolete wire payloads."""
import json
import tempfile
import unittest
from pathlib import Path

from check_codex_contracts import validate_cases


class ContractCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        schema = {
            "type": "object",
            "properties": {"action": {"enum": ["accept", "decline"]}},
            "required": ["action"],
        }
        (self.root / "Approval.json").write_text(json.dumps(schema))

    def check(self, payload):
        return validate_cases(self.root, [{"schema": "Approval", "payload": payload}])

    def test_valid_response_passes(self):
        self.assertEqual(self.check({"action": "accept"}), [])

    def test_wrong_response_shape_fails(self):
        self.assertTrue(self.check({"decision": "accept"}))

    def test_invalid_decision_fails(self):
        self.assertTrue(self.check({"action": "acceptForSession"}))

    def test_unknown_fields_fail_even_when_upstream_ignores_them(self):
        self.assertTrue(self.check({"action": "accept", "persist": "always"}))

    def test_removed_schema_and_empty_export_fail(self):
        self.assertTrue(validate_cases(self.root, []))
        self.assertTrue(validate_cases(self.root, [{"schema": "Removed", "payload": {}}]))


if __name__ == "__main__":
    unittest.main()
