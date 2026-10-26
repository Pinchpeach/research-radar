"""Research Radar desktop app.

Starts the backend on a private local port and shows the UI in a native window. Settings and
bookmarks are kept in the user's app-data folder (shown in Settings).

    python -m desktop.main              # native window
    python -m desktop.main --browser    # open in the default browser instead
    python -m desktop.main --no-open    # just serve (used by the build smoke test)
"""

import argparse
import base64
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path
from urllib.parse import urlsplit

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

    def save_bytes(self, name: str, base64_content: str):
        """Like save_file, for binary files (a PDF with handwriting), sent as base64."""
        import base64

        import webview

        dialog = getattr(getattr(webview, "FileDialog", None), "SAVE", None) or webview.SAVE_DIALOG
        chosen = self.window.create_file_dialog(dialog, save_filename=name)
        if not chosen:
            return None
        path = Path(chosen[0] if isinstance(chosen, (list, tuple)) else chosen)
        path.write_bytes(base64.b64decode(base64_content))
        return str(path)

    def library_sign_in(self) -> bool:
        """Sign in to the library once, from Settings: a window on the library's sign-in page
        (or a publisher's page through the proxy), kept until it reaches a publisher's page
        through the proxy; the proxy's cookies are kept for the papers opened later."""
        import webview

        from backend import library

        prefix = library.proxy()
        start = library.sign_in_url(prefix)
        if not start:
            return False
        first, onward = library.login_page(prefix), library.through(prefix, library.SIGN_IN_TARGET)
        done, lock, result = threading.Event(), threading.Lock(), {"ok": False}
        state = {"to_proxy": bool(first)}
        window = webview.create_window(f"{APP_NAME} — library", start, width=1100, height=820)

        def loaded():
            if done.is_set() or not lock.acquire(blocking=False):
                return
            try:
                here = window.get_current_url() or ""
                if state["to_proxy"]:
                    now, page = urlsplit(here), urlsplit(first)
                    if now.hostname == page.hostname and not now.path.startswith(page.path):  # signed in on the library's site
                        state["to_proxy"] = False
                        window.load_url(onward)
                    return
                if library.on_publisher(here, prefix):
                    cookies = []
                    for jar in window.get_cookies() or []:
                        for name, morsel in jar.items():
                            cookies.append({"name": name, "value": morsel.value, "domain": morsel["domain"], "path": morsel["path"]})
                    if library.save_cookies(prefix, cookies):
                        result["ok"] = True
                        done.set()
                        window.destroy()
            except Exception:  # still signing in
                pass
            finally:
                lock.release()

        window.events.loaded += loaded
        window.events.closed += done.set
        done.wait(15 * 60)
        return result["ok"]

    def library_login(self, doi: str) -> bool:
        """Get a paper through the library in a window of its own, signing in there if need be.

        After each page loads, the proxy's cookies are kept and the PDF tried, first by the app's
        own request (backend/library.py); when a publisher turns that away (bot checks), the page's
        PDF link (shared/find-pdf.js) is fetched in the page itself, as the browser it is. When the
        PDF comes, the window closes and the page asks the server for it again. True when it
        worked; False if the person closed the window first (they can also download by hand in it).
        """
        import webview

        from backend import library

        prefix = library.proxy()
        if not library.valid_proxy(prefix or "") or not library.DOI.match(doi or ""):
            return False
        done, lock, result = threading.Event(), threading.Lock(), {"ok": False}
        link, first = library.login_url(prefix, doi), library.login_page(prefix)
        # some proxies (Yonsei's) show a blank page until the person has signed in on the library's
        # site: start there, unless signed in already, and go on to the paper once they've left it
        state = {"to_paper": bool(first) and not library.signed_in(prefix), "steps": 0}
        window = webview.create_window(f"{APP_NAME} — library", link if not state["to_paper"] else first, width=1100, height=820)

        def loaded():
            if done.is_set() or not lock.acquire(blocking=False):
                return
            try:
                if state["to_paper"]:
                    here, page = urlsplit(window.get_current_url() or ""), urlsplit(first)
                    if here.hostname == page.hostname and not here.path.startswith(page.path):  # signed in: back on the library's site
                        state["to_paper"] = False
                        window.load_url(link)
                    return
                cookies = []
                for jar in window.get_cookies() or []:
                    for name, morsel in jar.items():
                        cookies.append({"name": name, "value": morsel.value, "domain": morsel["domain"], "path": morsel["path"]})
                if not library.save_cookies(prefix, cookies):
                    return
                try:
                    library.fetch(doi)
                except library.NeedsLogin:
                    return  # still signing in
                except Exception:  # turned away, or no link the app can follow: try in the page
                    got = in_page_pdf(window)
                    if got and got.get("pdf"):
                        library.remember(prefix, doi, base64.b64decode(got["pdf"]))
                    elif got and got.get("next") and state["steps"] < 3:
                        state["steps"] += 1  # a page around the PDF (or another site's address): open it
                        window.load_url(library.through(prefix, got["next"]))
                        return
                    else:
                        return  # left to the person, in the window
                result["ok"] = True
                done.set()
                window.destroy()
            except Exception:  # not signed in yet, or no PDF from here: the person carries on in the window
                pass
            finally:
                lock.release()

        window.events.loaded += loaded
        window.events.closed += done.set
        done.wait(15 * 60)
        return result["ok"]


# The PDF on the page shown, fetched by the page with its own cookies: {"pdf": base64} or, when
# what the link gives isn't a PDF (or can't be read from here), {"next": link}; null without one.
IN_PAGE_PDF = """(async function () {
  var link = %s;
  if (!link) return null;
  try {
    var response = await fetch(link, { credentials: "include" });
    var bytes = new Uint8Array(await response.arrayBuffer());
    var head = String.fromCharCode.apply(null, bytes.subarray(0, 1024));
    if (!response.ok || !/^\\s*%%PDF/.test(head)) return { next: link };
    var text = "";
    for (var i = 0; i < bytes.length; i += 32768) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return { pdf: btoa(text) };
  } catch (e) {
    return { next: link };
  }
})()"""


def in_page_pdf(window, timeout: float = 120) -> dict | None:
    from backend.paths import shared_text

    finder = "\n".join(line for line in shared_text("find-pdf.js").splitlines() if not line.startswith("//")).strip()
    got, box = threading.Event(), {}

    def back(value):
        box["value"] = value
        got.set()

    window.evaluate_js(IN_PAGE_PDF % finder, back)
    got.wait(timeout)
    value = box.get("value")
    return value if isinstance(value, dict) else None


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
