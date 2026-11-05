import threading
from .client import ApiError


def song_metadata(song):
    artists = song.get("ar") or song.get("artists") or []
    return {"id": str(song["id"]), "name": song.get("name") or "",
            "artists": " / ".join(a.get("name", "") for a in artists),
            "album": (song.get("al") or song.get("album") or {}).get("name") or ""}


class SyncManager:
    def __init__(self, store, client, delay=0.9):
        self.store, self.client, self.delay = store, client, delay
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = None
        self.uid = None
        self.store.recover_runs()

    def start(self, account, limit=200, playlists=True, retry_empty=False, recent=True):
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError("已经有一个同步任务在进行")
            self.stop.clear()
            self.uid = account["uid"]
            run_id = self.store.new_run(self.uid)
            self.thread = threading.Thread(target=self.run, args=(account, run_id, limit, playlists, retry_empty, recent), daemon=True)
            self.thread.start()
            return run_id

    def cancel(self):
        self.stop.set()

    def request(self, method, **query):
        for attempt in range(3):
            if self.stop.wait(self.delay if attempt == 0 else 2 ** attempt):
                raise InterruptedError()
            try:
                return self.client.call(method, **query)
            except ApiError as err:
                # Retry transient transport/server errors only; auth/rate limits stop.
                if attempt == 2 or err.code not in (0, 408, 500, 502, 503, 504):
                    raise

    def discover(self, uid, run_id, playlists, recent=True):
        warnings = []
        sources = [
            ("最近播放", "record_recent_song", {"limit": 1000}, lambda b: [song_metadata(x["data"]) for x in b.get("data", {}).get("list", [])]),
            ("累计排行", "user_record", {"uid": uid, "type": 0}, lambda b: [song_metadata(x["song"]) for x in b.get("allData", [])]),
            ("本周排行", "user_record", {"uid": uid, "type": 1}, lambda b: [song_metadata(x["song"]) for x in b.get("weekData", [])]),
            ("喜欢的歌曲", "likelist", {"uid": uid}, lambda b: [{"id": str(i)} for i in b.get("ids", [])]),
        ]
        if not recent:  # liked songs only (the web app's default)
            sources = sources[3:]
        for label, method, query, extract in sources:
            self.store.update_run(run_id, phase="查找歌曲 · " + label)
            try:
                self.store.candidates(uid, extract(self.request(method, **query)), label)
            except ApiError as err:
                if err.code in (301, 401, 403, 429, 460):
                    raise
                warnings.append(label + "没能读取")
        if playlists:
            offset = 0
            visited = set()
            while True:
                self.store.update_run(run_id, phase="查找歌曲 · 我的歌单")
                try:
                    body = self.request("user_playlist", uid=uid, offset=offset, limit=100)
                    lists = body.get("playlist") or []
                    for playlist in lists:
                        pid = str(playlist["id"])
                        if pid in visited or str((playlist.get("creator") or {}).get("userId")) != str(uid):
                            continue
                        visited.add(pid)
                        self.store.update_run(run_id, phase="查找歌曲 · " + (playlist.get("name") or "歌单")[:40])
                        try:
                            detail = self.request("playlist_detail", id=pid).get("playlist") or {}
                            self.store.candidates(uid, [song_metadata(s) for s in detail.get("tracks", [])], "我的歌单")
                            self.store.candidates(uid, [{"id": str(s["id"])} for s in detail.get("trackIds", [])], "我的歌单")
                        except ApiError as err:
                            if err.code in (301, 401, 403, 429, 460):
                                raise
                            warnings.append("部分歌单没能读取")
                    if not body.get("more") or not lists:
                        break
                    offset += len(lists)
                    if offset >= 10000:
                        warnings.append("歌单数量超过单次上限，其余歌单这次没有读取")
                        break
                except ApiError as err:
                    if err.code in (301, 401, 403, 429, 460):
                        raise
                    warnings.append("歌单列表没能读取")
                    break
        return warnings

    def run(self, account, run_id, limit, playlists, retry_empty, recent=True):
        uid = account["uid"]
        counts = {"queried": 0, "found": 0, "empty": 0, "failed": 0}
        try:
            current = self.client.login()
            if current["uid"] != uid:
                raise ApiError("登录的账号已切换，请重新连接后再同步")
            warnings = self.discover(uid, run_id, playlists, recent)
            queue = self.store.pending(uid, retry_empty=retry_empty, limit=limit or 1000000)
            consecutive_errors = 0
            for index, song in enumerate(queue):
                if self.stop.is_set():
                    raise InterruptedError()
                # Resolve names for ID-only candidates without one extra request per song.
                if index % 100 == 0:
                    missing = [s["song_id"] for s in queue[index:index + 100] if not s["name"]]
                    if missing:
                        try:
                            metadata = self.request("song_detail", ids=",".join(missing))
                            self.store.candidates(uid, [song_metadata(s) for s in metadata.get("songs", [])], "歌曲详情")
                        except ApiError as err:
                            if err.code in (301, 401, 403, 429, 460):
                                raise
                self.store.update_run(run_id, phase="查询初听时间 · %s / %s" % (index + 1, len(queue)))
                try:
                    body = self.request("music_first_listen_info", id=song["song_id"])
                    result = self.store.save_result(uid, song["song_id"], body)
                    counts["empty" if result == "empty" else "found"] += 1
                    consecutive_errors = 0
                except (ApiError, ValueError) as err:
                    self.store.failure(uid, song["song_id"], str(err))
                    counts["failed"] += 1
                    consecutive_errors += 1
                    if isinstance(err, ApiError) and err.code in (301, 401, 403, 429, 460):
                        raise ApiError("登录已失效或请求受限，同步已停止，请稍后再试", err.code)
                    if consecutive_errors >= 3:
                        raise ApiError("连续 3 首查询失败，同步已停止，进度已保存")
                counts["queried"] += 1
                self.store.update_run(run_id, **counts)
            stats = self.store.stats(uid)
            phase = "这一批已同步完成" if stats["pending"] else "已发现的歌曲都查询完了"
            if stats["failed"]:
                phase += " · %s 首查询失败，下次同步会自动重试" % stats["failed"]
            self.store.update_run(run_id, status="completed", phase=phase, error="；".join(sorted(set(warnings))) or None, **counts)
        except InterruptedError:
            self.store.update_run(run_id, status="paused", phase="已暂停，随时可以接着同步", **counts)
        except (ApiError, OSError, ValueError) as err:
            self.store.update_run(run_id, status="failed", phase="同步已停止，进度已保存", error=str(err)[:200], **counts)
        except Exception:
            self.store.update_run(run_id, status="failed", phase="同步已停止，进度已保存", error="接口返回了无法识别的数据，请确认依赖版本后重试", **counts)
