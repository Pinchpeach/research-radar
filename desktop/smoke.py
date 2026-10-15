"""Smoke-test a built app: start it in server-only mode and check the UI and API answer.

    python desktop/smoke.py dist/ResearchRadar/ResearchRadar[.exe]
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get(url: str) -> tuple[int, bytes]:
    with urllib.request.urlopen(url, timeout=5) as res:
        return res.status, res.read()


def main(executable: str) -> int:
    port = free_port()
    home = tempfile.mkdtemp(prefix="radar-smoke-")
    env = {**os.environ, "RADAR_HOME": home}
    proc = subprocess.Popen([executable, "--no-open", "--port", str(port)], env=env)
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.time() + 90  # first start of a frozen app can be slow
        while time.time() < deadline:
            if proc.poll() is not None:
                print(f"app exited early with code {proc.returncode}")
                return 1
            try:
                status, body = get(base + "/health")
                if status == 200:
                    break
            except OSError:
                time.sleep(0.5)
        else:
            print("app did not answer within 90 s")
            return 1

        print("health:", json.loads(body))
        checks = {
            "/": b"Research Radar",
            "/static/app.js": b"loadSettings",
            "/settings": b"openalex_api_key",
            "/bookmarks": b"[]",
        }
        for path, needle in checks.items():
            status, body = get(base + path)
            assert status == 200 and needle in body, f"{path}: {status} {body[:120]!r}"
            print(f"ok {path}")
        flow = json.dumps({"papers": [{"id": "W1", "title": "Graph neural networks", "year": 2020}],
                           "include_foundations": False}).encode()
        req = urllib.request.Request(base + "/flow", data=flow, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as res:
            assert res.status == 200 and json.loads(res.read())["nodes"], "flow failed"
        print("ok /flow (scikit-learn works in the bundle)")
        assert os.path.exists(os.path.join(home, "radar.db")), "data folder not used"
        print("ok data folder:", home)
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
