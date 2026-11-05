"""Gives the analyzer access to the look-away rule in analysis/common.py (imported, never copied).

common.py only uses the standard library. In a container image, copy analysis/common.py next to the analyzer
package (or anywhere on PYTHONPATH). On a laptop the analysis folder next to server/ is found automatically.
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    import common  # noqa: F401
except ImportError:
    _analysis = Path(__file__).resolve().parent.parent.parent / "analysis"
    if not (_analysis / "common.py").exists():
        raise ImportError(
            "analysis/common.py not found. Put it on PYTHONPATH (the look-away rule lives there and is not copied)."
        ) from None
    sys.path.insert(0, str(_analysis))
    import common  # noqa: F401,E402

__all__ = ["common"]
