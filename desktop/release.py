"""Release helpers used by the GitHub Actions workflow.

    python desktop/release.py version          # print the app version
    python desktop/release.py check-tag v0.4.0 # fail unless the tag matches the app version
    python desktop/release.py notes v0.4.0     # print the release notes header
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
    version = tag.lstrip("v")
    apk = (
        f"| Android | `ResearchRadar-{version}-android.apk` | 휴대폰에서 내려받아 엽니다. 처음에는 브라우저(또는 파일 앱)에 "
        "**출처를 알 수 없는 앱 설치**를 허용해야 합니다. 업데이트도 새 APK를 같은 방법으로 설치하면 됩니다. |\n"
        if android else ""
    )
    pre = "\n> 시험판(pre-release)입니다. 정식 버전이 아니므로 문제가 있을 수 있습니다.\n" if "-" in tag else ""
    return f"""## 설치
{pre}
| 운영체제 | 파일 | 실행 방법 |
|---|---|---|
| Windows | `ResearchRadar-{version}-windows.zip` | 압축을 풀고 `ResearchRadar\\ResearchRadar.exe`를 실행합니다. "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누르세요. |
| macOS | `ResearchRadar-{version}-macos.zip` | 압축을 풀고 `Research Radar.app`을 응용 프로그램 폴더로 옮긴 뒤, 처음에는 **우클릭 → 열기**로 실행하세요. |
| Linux | `ResearchRadar-{version}-linux.tar.gz` | 압축을 풀고 `ResearchRadar/ResearchRadar`를 실행합니다. |
{apk}
앱은 코드 서명이 되어 있지 않아 처음 실행할 때 운영체제 경고가 나옵니다. 내려받은 파일은 `SHA256SUMS.txt`로 확인할 수 있습니다.

처음 실행하면 **⚙ 환경설정**에서 무료 [OpenAlex API 키](https://openalex.org/settings/api)를 입력하세요. 이전 버전에서 쓰던 설정과 북마크는 그대로 이어집니다.
"""


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
