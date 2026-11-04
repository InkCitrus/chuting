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
                    raise ApiError("接口请求超时，可以稍后重试")
                result = json.loads(self.process.stdout.readline())
            except (OSError, ValueError):
                self.close()
                raise ApiError("接口连接中断，可以稍后重试")
            errors = {"DEPENDENCY_MISSING": "请先运行 npm install --ignore-scripts 安装接口依赖",
                      "LOGIN_MISSING": "未找到网易云登录态，请登录 macOS 客户端，或设置 NETEASE_COOKIE 环境变量",
                      "UPSTREAM_ERROR": "网易接口暂时不可用，请稍后重试"}
            if "error" in result:
                raise ApiError(errors.get(result["error"], "接口请求失败"), result.get("code", 0))
            body = result["body"]
            if body.get("code") != 200:
                raise ApiError("网易接口返回异常状态 " + str(body.get("code")), body.get("code", 0))
            return body

    def login(self):
        account = self.call("login_status").get("account")
        if not account:
            raise ApiError("登录态已失效，请重新登录网易云音乐", 301)
        return account
