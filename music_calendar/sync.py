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

    def start(self, account, limit=200, playlists=True, retry_empty=False):
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError("已有采集任务正在进行")
            self.stop.clear()
            self.uid = account["uid"]
            run_id = self.store.new_run(self.uid)
            self.thread = threading.Thread(target=self.run, args=(account, run_id, limit, playlists, retry_empty), daemon=True)
            self.thread.start()
            return run_id

    def cancel(self):
        self.stop.set()

    def request(self, method, **query):
        if self.stop.wait(self.delay):
            raise InterruptedError()
        return self.client.call(method, **query)

    def discover(self, uid, run_id, playlists):
        warnings = []
        sources = [
            ("最近播放", "record_recent_song", {"limit": 1000}, lambda b: [song_metadata(x["data"]) for x in b.get("data", {}).get("list", [])]),
            ("累计排行", "user_record", {"uid": uid, "type": 0}, lambda b: [song_metadata(x["song"]) for x in b.get("allData", [])]),
            ("喜欢的歌曲", "likelist", {"uid": uid}, lambda b: [{"id": str(i)} for i in b.get("ids", [])]),
        ]
        for label, method, query, extract in sources:
            self.store.update_run(run_id, phase="发现歌曲 · " + label)
            try:
                self.store.candidates(uid, extract(self.request(method, **query)), label)
            except ApiError as err:
                if err.code in (301, 401, 403, 429, 460):
                    raise
                warnings.append(label + "读取失败")
        if playlists:
            offset = 0
            visited = set()
            while True:
                self.store.update_run(run_id, phase="发现歌曲 · 我的歌单")
                try:
                    body = self.request("user_playlist", uid=uid, offset=offset, limit=100)
                    lists = body.get("playlist") or []
                    for playlist in lists:
                        pid = str(playlist["id"])
                        if pid in visited or str((playlist.get("creator") or {}).get("userId")) != str(uid):
                            continue
                        visited.add(pid)
                        self.store.update_run(run_id, phase="发现歌曲 · " + (playlist.get("name") or "歌单")[:40])
                        try:
                            detail = self.request("playlist_detail", id=pid).get("playlist") or {}
                            self.store.candidates(uid, [song_metadata(s) for s in detail.get("tracks", [])], "我的歌单")
                            self.store.candidates(uid, [{"id": str(s["id"])} for s in detail.get("trackIds", [])], "我的歌单")
                        except ApiError as err:
                            if err.code in (301, 401, 403, 429, 460):
                                raise
                            warnings.append("部分歌单读取失败")
                    if not body.get("more") or not lists:
                        break
                    offset += len(lists)
                    if offset >= 10000:
                        warnings.append("歌单列表超过单次发现范围，需单独导入")
                        break
                except ApiError as err:
                    if err.code in (301, 401, 403, 429, 460):
                        raise
                    warnings.append("歌单列表读取失败")
                    break
        return warnings

    def run(self, account, run_id, limit, playlists, retry_empty):
        uid = account["uid"]
        counts = {"queried": 0, "found": 0, "empty": 0, "failed": 0}
        try:
            current = self.client.login()
            if current["uid"] != uid:
                raise ApiError("账号已变更，请重新连接后采集")
            warnings = self.discover(uid, run_id, playlists)
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
                self.store.update_run(run_id, phase="查询首次播放 · %s / %s" % (index + 1, len(queue)))
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
                        raise ApiError("登录或请求受到限制，已停止采集；请稍后重试", err.code)
                    if consecutive_errors >= 3:
                        raise ApiError("连续三次查询失败，已停止采集；已保存进度")
                counts["queried"] += 1
                self.store.update_run(run_id, **counts)
            stats = self.store.stats(uid)
            phase = "本批采集完成" if stats["pending"] else "当前候选歌曲已查询完成"
            if stats["failed"]:
                phase += " · %s 首失败可重试" % stats["failed"]
            self.store.update_run(run_id, status="completed", phase=phase, error="；".join(sorted(set(warnings))) or None, **counts)
        except InterruptedError:
            self.store.update_run(run_id, status="paused", phase="已暂停，可以继续采集", **counts)
        except (ApiError, OSError, ValueError) as err:
            self.store.update_run(run_id, status="failed", phase="采集已停止，进度已保存", error=str(err)[:200], **counts)
        except Exception:
            self.store.update_run(run_id, status="failed", phase="采集已停止，进度已保存", error="遇到未预期的响应格式，请检查接口版本后重试", **counts)
