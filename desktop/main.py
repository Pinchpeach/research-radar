"""Research Radar desktop app.

Starts the backend on a private local port and shows the UI in a native window. Settings and
bookmarks are kept in the user's app-data folder (shown in Settings).

    python -m desktop.main              # native window
    python -m desktop.main --browser    # open in the default browser instead
    python -m desktop.main --no-open    # just serve (used by the build smoke test)
"""

import argparse
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

APP_NAME = "Research Radar"
APP_ID = "ResearchRadar"


def data_home() -> Path:
    from platformdirs import user_data_dir

    return Path(os.getenv("RADAR_HOME") or user_data_dir(APP_ID, appauthor=False))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def ensure_streams(log_file: Path) -> None:
    """A windowed build has no console: send output to a log file instead of nowhere."""
    if sys.stdout is None or sys.stderr is None:
        stream = open(log_file, "a", buffering=1, encoding="utf-8")  # noqa: SIM115 - lives for the app
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream


def start_server(port: int):
    import uvicorn

    from backend.main import app  # after RADAR_HOME is set, so data lands in the app folder

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", log_config=None))
    thread = threading.Thread(target=server.run, name="radar-server", daemon=True)
    thread.start()
    # Wait for *this* server to come up: an HTTP check could be answered by another process
    # already listening on the port.
    deadline = time.time() + 30
    while time.time() < deadline and not server.started:
        if not thread.is_alive():
            raise RuntimeError(f"The local server could not start (is port {port} already in use?).")
        time.sleep(0.1)
    if not server.started:
        raise RuntimeError("The local server did not start in time.")
    return server, f"http://127.0.0.1:{port}/"


class DesktopApi:
    """Functions the page can call through window.pywebview.api."""

    def __init__(self):
        self.window = None

    def save_file(self, name: str, content: str):
        import webview

        dialog = getattr(getattr(webview, "FileDialog", None), "SAVE", None) or webview.SAVE_DIALOG
        chosen = self.window.create_file_dialog(dialog, save_filename=name)
        if not chosen:
            return None
        path = Path(chosen[0] if isinstance(chosen, (list, tuple)) else chosen)
        path.write_text(content, encoding="utf-8")
        return str(path)


def wait_forever() -> None:
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog=APP_ID, description=APP_NAME)
    parser.add_argument("--browser", action="store_true", help="open in the default browser instead of a window")
    parser.add_argument("--no-open", action="store_true", help="only run the local server")
    parser.add_argument("--port", type=int, default=0, help="local port (default: any free port)")
    args = parser.parse_args(argv)

    home = data_home()
    home.mkdir(parents=True, exist_ok=True)
    os.environ["RADAR_HOME"] = str(home)
    ensure_streams(home / "app.log")

    server, url = start_server(args.port or free_port())
    print(f"{APP_NAME} running at {url} (data: {home})", flush=True)

    if args.no_open:
        wait_forever()
    elif args.browser:
        webbrowser.open(url)
        wait_forever()
    else:
        try:
            import webview

            api = DesktopApi()
            api.window = webview.create_window(
                APP_NAME, url, js_api=api, width=1360, height=900, min_size=(960, 640), text_select=True
            )
            webview.start()  # returns when the window closes
        except Exception as exc:  # no GUI backend available: still usable in the browser
            print(f"Native window unavailable ({exc}); opening the browser instead.", file=sys.stderr)
            webbrowser.open(url)
            wait_forever()
    server.should_exit = True
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
