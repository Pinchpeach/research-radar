# PyInstaller build for the Research Radar desktop app.
#   pyinstaller desktop/research_radar.spec --noconfirm
# Output: dist/ResearchRadar/ (Windows, Linux) or dist/Research Radar.app (macOS).
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).parent  # noqa: F821 - provided by PyInstaller
VERSION = {}
exec((ROOT / "backend" / "version.py").read_text(encoding="utf-8"), VERSION)

hiddenimports = (
    collect_submodules("uvicorn")  # protocol/loop implementations are picked at runtime
    + collect_submodules("backend")
)

a = Analysis(
    [str(ROOT / "desktop" / "main.py")],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "frontend" / "web"), "frontend/web")],
    hiddenimports=hiddenimports,
    excludes=["streamlit", "plotly", "matplotlib", "pandas", "IPython", "pytest", "tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ResearchRadar",
    console=False,  # a desktop app: no terminal window
    disable_windowed_traceback=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="ResearchRadar", upx=False)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Research Radar.app",
        bundle_identifier="org.researchradar.desktop",
        info_plist={"NSHighResolutionCapable": True, "CFBundleShortVersionString": VERSION["__version__"]},
    )
