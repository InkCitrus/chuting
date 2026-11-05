import json
import os
import select
import subprocess
import threading
from pathlib import Path


class ApiError(Exception):
    def __init__(self, message, code=0):
        super().__init__(message)
        self.code = code


class NeteaseClient:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.lock = threading.Lock()
        self.process = None
        self.sequence = 0

    def _start(self):
        env = os.environ.copy()
        temp = self.directory / "session-tmp"
        temp.mkdir(parents=True, exist_ok=True, mode=0o700)
        env.update(TMPDIR=str(temp), NODE_NO_WARNINGS="1")
        try:
            self.process = subprocess.Popen(["node", str(Path(__file__).with_name("provider.cjs"))],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding="utf-8", bufsize=1, env=env)
        except FileNotFoundError:
            raise ApiError("未找到 Node.js，请安装 Node.js 22 或更新版本")

    def close(self):
        if self.process:
            process, self.process = self.process, None
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout):
                if stream:
                    stream.close()

    def call(self, method, **query):
        with self.lock:
            if self.process is None or self.process.poll() is not None:
                self.close()
                self._start()
            self.sequence += 1
            try:
                self.process.stdin.write(json.dumps({"id": self.sequence, "method": method, "query": query}) + "\n")
                self.process.stdin.flush()
                if not select.select([self.process.stdout], [], [], 25)[0]:
                    self.close()
                    raise ApiError("网易云接口响应超时，请稍后重试")
                result = json.loads(self.process.stdout.readline())
            except (OSError, ValueError):
                self.close()
                raise ApiError("与网易云接口的连接中断了，请稍后重试")
            errors = {"DEPENDENCY_MISSING": "缺少接口依赖，请先在项目目录运行 npm ci --ignore-scripts",
                      "LOGIN_MISSING": "没有找到网易云音乐的登录状态。请先在 macOS 客户端登录，或设置 NETEASE_COOKIE 环境变量",
                      "UPSTREAM_ERROR": "网易云接口暂时不可用，请稍后重试"}
            if "error" in result:
                raise ApiError(errors.get(result["error"], "请求网易云接口失败"), result.get("code", 0))
            body = result["body"]
            if body.get("code") != 200:
                raise ApiError("网易云接口返回了异常状态码 " + str(body.get("code")), body.get("code", 0))
            return body

    def login(self):
        account = self.call("login_status").get("account")
        if not account:
            raise ApiError("登录已过期，请在网易云音乐客户端重新登录", 301)
        return account
