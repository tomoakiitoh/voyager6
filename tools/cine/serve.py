#!/usr/bin/env python3
"""シネマティック撮影用のローカルサーバ。dist を配信しつつ、ブラウザからの
POST /__frame?i=N (連番) / ?name=foo.png (任意名) を frames/ に保存する。
   python3 tools/cine/serve.py   # http://127.0.0.1:8754
ブラウザで /solar/?cine=1 を開き capture.js を流すと frames/ に PNG が溜まる。"""
import http.server, socketserver, os, base64, urllib.parse, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
DIST = str(ROOT / "dist")
FRAMES = ROOT / "tools" / "cine" / "frames"
FRAMES.mkdir(parents=True, exist_ok=True)
os.chdir(str(ROOT))
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=DIST, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/__frame":
            self.send_response(404); self.end_headers(); return
        q = urllib.parse.parse_qs(u.query)
        name = q.get("name", [None])[0] or f"f{int(q.get('i', ['0'])[0]):04d}.png"
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("latin-1")
        b64 = body.split(",", 1)[1] if "," in body else body
        (FRAMES / name).write_bytes(base64.b64decode(b64))
        self.send_response(200); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); self.wfile.write(b"ok")
socketserver.TCPServer(("127.0.0.1", 8754), H).serve_forever()
