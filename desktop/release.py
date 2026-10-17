"""Release helpers used by the GitHub Actions workflow.

    python desktop/release.py version          # print the app version
    python desktop/release.py check-tag v0.4.0 # fail unless the tag matches the app version
    python desktop/release.py notes v0.4.0     # print the release notes (terminal download commands)
    python desktop/release.py notes v0.6.0 --android   # ... with the Android APK
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAG = re.compile(r"v(\d+\.\d+\.\d+)(-[0-9A-Za-z.]+)?")


def app_version() -> str:
    namespace: dict = {}
    exec((ROOT / "backend" / "version.py").read_text(encoding="utf-8"), namespace)
    return namespace["__version__"]


def check_tag(tag: str) -> str | None:
    """None when the tag releases the current version, else the reason it doesn't."""
    match = TAG.fullmatch(tag)
    if not match:
        return f"Tag {tag!r} is not a version tag like v1.2.3 or v1.2.3-rc1."
    if match.group(1) != app_version():
        return (
            f"Tag {tag} does not match the app version {app_version()} in backend/version.py. "
            "Update the version (and merge) before tagging."
        )
    return None


def notes(tag: str, android: bool = False) -> str:
    """Release notes: only how to download each package from a terminal."""
    version = tag.lstrip("v")
    base = f"https://github.com/{releases_repo()}/releases/download/{tag}"
    lines = [
        "## 다운로드",
        "",
        "```bash",
        "# Windows (PowerShell)",
        f"curl.exe -LO {base}/ResearchRadar-{version}-windows.zip",
        "",
        "# macOS",
        f"curl -LO {base}/ResearchRadar-{version}-macos.zip",
        "",
        "# Linux",
        f"curl -LO {base}/ResearchRadar-{version}-linux.tar.gz",
    ]
    if android:
        lines += ["", "# Android (USB로 연결한 휴대폰에 설치)",
                  f"curl -LO {base}/ResearchRadar-{version}-android.apk",
                  f"adb install -r ResearchRadar-{version}-android.apk"]
    lines += ["", "# 확인 (선택)", f"curl -LO {base}/SHA256SUMS.txt", "sha256sum -c SHA256SUMS.txt --ignore-missing", "```"]
    return "\n".join(lines) + "\n"


def releases_repo() -> str:
    namespace: dict = {}
    exec((ROOT / "backend" / "version.py").read_text(encoding="utf-8"), namespace)
    return namespace["RELEASES_REPO"]


def main(argv: list[str]) -> int:
    # the notes are Korean; a Windows console's code page can't print them
    sys.stdout.reconfigure(encoding="utf-8")
    command = argv[1] if len(argv) > 1 else ""
    if command == "version":
        print(app_version())
        return 0
    if command == "check-tag" and len(argv) == 3:
        problem = check_tag(argv[2])
        if problem:
            print(f"::error::{problem}")
            return 1
        print(f"Tag {argv[2]} matches app version {app_version()}.")
        return 0
    if command == "notes" and len(argv) in (3, 4) and argv[3:] in ([], ["--android"]):
        print(notes(argv[2], android=argv[3:] == ["--android"]))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
