"""Local demo server: serves the WASEL pages and proxies /face/* to the face-ID service.

Both pages (dashboard + responder) share one origin, so the responder can reach the
dashboard over BroadcastChannel and the face service without CORS changes.

    python3 serve.py            # http://127.0.0.1:8765/er-command-center.html
    FACE_URL=http://127.0.0.1:8000 python3 serve.py
"""
import http.server
import os
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
FACE_URL = os.environ.get("FACE_URL", "http://127.0.0.1:8000").rstrip("/")
PORT = int(os.environ.get("PORT", "8765"))
MAX_BODY = 15 * 1024 * 1024  # photos only; reject anything larger


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Demo pages hold synthetic patient data: never cache, never embed elsewhere.
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/face/"):
            return self._proxy("GET")
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/face/"):
            return self._proxy("POST")
        self.send_error(405)

    def _proxy(self, method):
        target = self.path[len("/face"):]
        if target.split("?")[0] not in ("/health", "/identify", "/enroll", "/people"):
            return self.send_error(404, "Unknown face-service endpoint")
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self.send_error(413, "Photo too large")
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(FACE_URL + target, data=body, method=method)
        if self.headers.get("Content-Type"):
            req.add_header("Content-Type", self.headers["Content-Type"])
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                status, data, ctype = resp.status, resp.read(), resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as err:
            status, data, ctype = err.code, err.read(), err.headers.get("Content-Type", "application/json")
        except (urllib.error.URLError, TimeoutError):
            status, data, ctype = 502, b'{"detail":"Face service unreachable"}', "application/json"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        # Keep request paths only; never log bodies (they contain face images).
        super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"WASEL demo on http://127.0.0.1:{PORT}/er-command-center.html · face service {FACE_URL}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
