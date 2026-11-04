import argparse
import fcntl
import json
import os
from pathlib import Path
from .client import NeteaseClient
from .store import Store
from .sync import SyncManager


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="初听：在本机整理网易云音乐的初听日历")
    parser.add_argument("--data-dir", default=os.environ.get("MUSIC_CALENDAR_DATA", "data"), help="数据目录（默认 data/，也可用 MUSIC_CALENDAR_DATA 指定）")
    sub = parser.add_subparsers(dest="command", required=True)
    web = sub.add_parser("serve", help="启动网页日历")
    web.add_argument("--port", type=int, default=8767, help="网页端口（默认 8767）")
    sync = sub.add_parser("sync", help="同步歌曲的初听时间")
    sync.add_argument("--limit", type=int, default=200, help="这次查询多少首，0 表示全部未查询的歌曲（默认 200）")
    sync.add_argument("--no-playlists", action="store_true", help="不查找我创建的歌单")
    sync.add_argument("--retry-empty", action="store_true", help="重新查询之前没有记录的歌曲")
    args = parser.parse_args()
    directory = Path(args.data_dir).resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # One owner per data directory: a CLI collector and web collector must not
    # query the same account concurrently or recover each other's active runs.
    lock = (directory / ".application.lock").open("a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("这个数据目录正被另一个初听进程使用，请先关闭它")
    if args.command == "serve":
        from .server import serve
        serve(directory, args.port)
        return
    if args.limit < 0 or args.limit > 10000:
        parser.error("--limit 需在 0 到 10000 之间")
    store = Store(args.data_dir)
    client = NeteaseClient(args.data_dir)
    manager = SyncManager(store, client)
    try:
        account = client.login()
        store.account(account["uid"], account["nickname"])
        run_id = manager.start(account, limit=args.limit, playlists=not args.no_playlists, retry_empty=args.retry_empty)
        try:
            while manager.thread.is_alive():
                manager.thread.join(timeout=5)
        except KeyboardInterrupt:
            manager.cancel()
            manager.thread.join(timeout=18)
        run = store.last_run(account["uid"])
        print(json.dumps({"run": run, "stats": store.stats(account["uid"])}, ensure_ascii=False))
        if run["status"] == "failed":
            raise SystemExit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
