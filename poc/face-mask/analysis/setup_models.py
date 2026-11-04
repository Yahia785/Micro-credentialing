"""One-time setup for test 2: downloads the YuNet face detector (ONNX) into analysis/models/.

Source: the official OpenCV organisation on Hugging Face (the same file as in opencv_zoo; the
GitHub raw URL only returns a Git LFS pointer text file, not the model).
"""
import hashlib
import sys
import urllib.request
from pathlib import Path

URL = "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx"
SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
DEST = Path(__file__).resolve().parent / "models" / "face_detection_yunet_2023mar.onnx"


def valid(path: Path) -> bool:
    return path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == SHA256


def main() -> int:
    if valid(DEST):
        print(f"Already present and verified: {DEST}")
        return 0
    DEST.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {URL}")
    try:
        urllib.request.urlretrieve(URL, DEST)
    except Exception as e:  # noqa: BLE001
        print(f"Download failed: {e}", file=sys.stderr)
        return 1
    if not valid(DEST):
        print("Downloaded file failed the checksum test (wrong file or truncated). Deleted.", file=sys.stderr)
        DEST.unlink(missing_ok=True)
        return 1
    print(f"Saved and verified ({DEST.stat().st_size / 1e3:.0f} KB): {DEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
