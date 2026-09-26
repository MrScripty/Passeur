import subprocess
import sys
import unittest
from pathlib import Path

ENTRY = Path(__file__).with_name("main.py")


class QuoteCliTest(unittest.TestCase):
    def run_quote(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(ENTRY), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_normal(self) -> None:
        result = self.run_quote("1250", "3", "1000")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "subtotal_cents=3750\ndiscount_cents=375\ntotal_cents=3375\n")

    def test_zero_quantity(self) -> None:
        result = self.run_quote("1250", "0", "1000")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "subtotal_cents=0\ndiscount_cents=0\ntotal_cents=0\n")

    def test_invalid(self) -> None:
        result = self.run_quote("1250", "-1", "1000")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr, "error: expected unsigned decimal integer\n")

    def test_maximum(self) -> None:
        result = self.run_quote("1000000", "1000", "0")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "subtotal_cents=1000000000\ndiscount_cents=0\ntotal_cents=1000000000\n")


if __name__ == "__main__":
    unittest.main()
