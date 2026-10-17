import os
import unittest
from unittest.mock import patch
from native_target import native_macos_arch


class NativeTargetTests(unittest.TestCase):
    def check_target(self, host, target, expected):
        env = {} if target is None else {"TAURI_ENV_TARGET_TRIPLE": target}
        with patch.dict(os.environ, env, clear=True), patch("platform.machine", return_value=host):
            if expected is None:
                with self.assertRaisesRegex(SystemExit, "matching architecture"):
                    native_macos_arch()
            else:
                self.assertEqual(native_macos_arch(), expected)

    def test_matching_and_direct_builds(self):
        for host, target in [("arm64", "aarch64-apple-darwin"), ("x86_64", "x86_64-apple-darwin")]:
            with self.subTest(host=host):
                self.check_target(host, target, host)
                self.check_target(host, None, host)

    def test_rejects_cross_and_universal_builds(self):
        for host, target in [("arm64", "x86_64-apple-darwin"), ("x86_64", "aarch64-apple-darwin"), ("arm64", "universal-apple-darwin"), ("arm64", "aarch64-unknown-linux-gnu")]:
            with self.subTest(host=host, target=target):
                self.check_target(host, target, None)


if __name__ == "__main__":
    unittest.main()
