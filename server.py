from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import json
import os
import tempfile

ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "tracker-data.json"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8765"))
MAX_BODY = 10 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            return self.send_json(200, {"ok": True, "service": "sunfly-progress", "publicUrl": "https://progress.sunfly.hk"})
        if self.path == "/api/data":
            try:
                return self.send_json(200, json.loads(DATA_PATH.read_text(encoding="utf-8")))
            except Exception as exc:
                return self.send_json(500, {"error": f"无法读取数据文件：{exc}"})
        return super().do_GET()

    def do_PUT(self):
        if self.path != "/api/data":
            return self.send_json(404, {"error": "接口不存在"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_BODY:
                return self.send_json(413, {"error": "数据超过 10MB 限制"})
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("projects"), list):
                return self.send_json(400, {"error": "数据结构无效"})
            fd, temp_name = tempfile.mkstemp(prefix="tracker-", suffix=".json", dir=str(DATA_PATH.parent))
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(data, handle, ensure_ascii=False, indent=2)
            os.replace(temp_name, DATA_PATH)
            return self.send_json(200, {"ok": True})
        except Exception as exc:
            return self.send_json(400, {"error": f"保存失败：{exc}"})

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    print(f"检测报告进度控制中心已启动：http://{HOST}:{PORT}")
    print("关闭本窗口即可停止服务。正式域名：https://progress.sunfly.hk")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
