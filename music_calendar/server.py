import csv
import io
import json
import re
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo
from .client import ApiError, NeteaseClient
from .store import Store
from .sync import SyncManager

WEB = Path(__file__).resolve().parent.parent / "web"


class Application:
    def __init__(self, directory, client=None, delay=0.9):
        self.store = Store(directory)
        self.client = client or NeteaseClient(directory)
        self.sync = SyncManager(self.store, self.client, delay=delay)
        # Browsing the local archive also works with expired cookies or offline.
        self.account = self.store.active_account()
        self.account_lock = threading.Lock()

    def connect(self):
        with self.account_lock:
            if self.sync.thread and self.sync.thread.is_alive():
                raise ValueError("正在同步，请先暂停再重新连接账号")
            self.client.close()
            account = self.client.login()
            self.store.account(account["uid"], account["nickname"])
            self.account = account
            return account

    def status(self):
        account = self.account
        return {"account": account, "timezone": "Asia/Shanghai", "mode": "first_listen",
                "stats": self.store.stats(account["uid"]) if account else {},
                "calendar": self.store.calendar_meta(account["uid"]) if account else {"months": [], "days": 0},
                "run": self.store.last_run(account["uid"]) if account else None}

    def close(self):
        self.sync.cancel()
        if self.sync.thread:
            self.sync.thread.join(timeout=18)
        self.client.close()


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MusicCalendar/0.1"

        def log_message(self, *args):
            pass

        def allowed_host(self):
            port = self.server.server_port
            return self.headers.get("Host") in ("127.0.0.1:%s" % port, "localhost:%s" % port)

        def send(self, status, content, mime="application/json; charset=utf-8", filename=None):
            if isinstance(content, (dict, list)):
                content = json.dumps(content, ensure_ascii=False).encode("utf-8")
            elif isinstance(content, str):
                content = content.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.music.126.net; frame-ancestors 'none'; base-uri 'none'")
            if filename:
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % filename)
            self.end_headers()
            self.wfile.write(content)

        def account(self):
            if not app.account:
                raise ApiError("请先连接网易云音乐账号", 401)
            return app.account

        def do_GET(self):
            if not self.allowed_host():
                return self.send(403, {"error": "只能在本机访问"})
            url = urlsplit(self.path)
            query = parse_qs(url.query)
            try:
                if url.path == "/api/runtime":
                    return self.send(200, {"storage": "sqlite"})
                if url.path == "/api/status":
                    return self.send(200, app.status())
                if url.path in ("/api/events", "/api/export"):
                    account = self.account()
                    month = query.get("month", [None])[0]
                    if month and not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
                        raise ValueError("月份格式应为 YYYY-MM，例如 2026-11")
                    term = query.get("q", [""])[0][:200]
                    records = app.store.events(account["uid"], month=month, query=term, limit=1000000)
                    if url.path == "/api/events":
                        return self.send(200, {"events": records, "timezone": "Asia/Shanghai", "kind": "first_listen"})
                    if query.get("format", ["json"])[0] == "csv":
                        output = io.StringIO(newline="")
                        columns = ["song_id", "name", "artists", "date", "time", "first_listen_ms", "timestamp_local", "timezone", "kind", "play_count", "status", "source"]
                        writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
                        writer.writeheader()
                        for record in records:
                            # Spreadsheet formula protection; JSON keeps exact original text.
                            safe = {k: ("'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r")) else v) for k, v in record.items()}
                            writer.writerow(safe)
                        return self.send(200, "\ufeff" + output.getvalue(), "text/csv; charset=utf-8", "first-listens.csv")
                    return self.send(200, {"account": account, "kind": "first_listen", "timezone": "Asia/Shanghai", "coverage": app.store.stats(account["uid"]), "events": records}, filename="first-listens.json")
                files = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"), "/styles.css": ("styles.css", "text/css; charset=utf-8")}
                for name in ("backend.js", "archive-core.js", "browser-store.js", "browser-sync.js", "insights.js"):
                    files["/" + name] = (name, "text/javascript; charset=utf-8")
                files["/favicon.svg"] = ("favicon.svg", "image/svg+xml")
                files["/manifest.webmanifest"] = ("manifest.webmanifest", "application/manifest+json")
                for size in ("192", "512"):
                    files["/icons/icon-%s.png" % size] = ("icons/icon-%s.png" % size, "image/png")
                if url.path in files:
                    file, mime = files[url.path]
                    return self.send(200, (WEB / file).read_bytes(), mime)
                return self.send(404, {"error": "找不到这个页面"})
            except ApiError as err:
                return self.send(401, {"error": str(err)})
            except ValueError as err:
                return self.send(400, {"error": str(err)})
            except (OSError, OverflowError):
                return self.send(500, {"error": "读取本地数据失败，请检查磁盘空间和文件权限"})

        def do_POST(self):
            if not self.allowed_host():
                return self.send(403, {"error": "只能在本机访问"})
            origin = self.headers.get("Origin")
            allowed = {"http://127.0.0.1:%s" % self.server.server_port, "http://localhost:%s" % self.server.server_port}
            if origin and origin not in allowed:
                return self.send(403, {"error": "不接受来自其他网站的请求"})
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                return self.send(415, {"error": "请求需使用 JSON 格式"})
            try:
                length = int(self.headers.get("Content-Length", 0))
                if not 0 <= length <= 8192:
                    raise ValueError("请求内容过大")
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError("请求内容格式不正确")
                route = urlsplit(self.path).path
                if route == "/api/connect":
                    return self.send(200, {"account": app.connect()})
                if route == "/api/sync":
                    account = self.account()
                    limit = body.get("limit", 200)
                    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 <= limit <= 10000:
                        raise ValueError("同步数量需在 0 到 10000 之间")
                    playlists, retry_empty = body.get("playlists", True), body.get("retry_empty", False)
                    if not isinstance(playlists, bool) or not isinstance(retry_empty, bool):
                        raise ValueError("同步选项格式不正确")
                    with app.account_lock:
                        run_id = app.sync.start(account, limit=limit, playlists=playlists, retry_empty=retry_empty)
                    return self.send(202, {"run_id": run_id})
                if route == "/api/sync/pause":
                    self.account()
                    app.sync.cancel()
                    return self.send(202, {"status": "pausing"})
                return self.send(404, {"error": "不支持这个操作"})
            except ApiError as err:
                return self.send(401 if err.code in (301, 401) else 502, {"error": str(err)})
            except (ValueError, TypeError) as err:
                return self.send(400, {"error": str(err)})
            except OSError:
                return self.send(500, {"error": "保存失败，请检查磁盘空间和文件权限"})

    return Handler


def serve(directory, port=8767):
    app = Application(directory)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    server.daemon_threads = True
    print("初听已启动：http://127.0.0.1:%s （按 Ctrl+C 停止）" % server.server_port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.close()
        server.server_close()
