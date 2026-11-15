"""로컬 개발용 서버: 정적 파일 + 요청 시 시세 갱신(/api/refresh).
사용법: python server.py [포트]   → http://localhost:8000
"""
import http.server
import os
import socketserver
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.startswith("/api/refresh"):
            p = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "update_data.py")],
                               capture_output=True, text=True, encoding="utf8", env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            body = (p.stdout + p.stderr).encode("utf8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as srv:
        print("http://localhost:%d" % PORT)
        srv.serve_forever()
