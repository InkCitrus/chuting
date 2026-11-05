"""Read an existing SQLite archive and write a browser-importable full backup."""
import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def export(directory):
    db = sqlite3.connect((Path(directory).resolve() / "calendar.sqlite3").as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        # A single read transaction gives a consistent snapshot even during a sync.
        db.execute("BEGIN")
        account = db.execute("SELECT * FROM accounts WHERE uid=(SELECT value FROM settings WHERE key='active_uid')").fetchone()
        if account is None:
            account = db.execute("SELECT * FROM accounts ORDER BY rowid DESC LIMIT 1").fetchone()
        if account is None:
            raise ValueError("没有可导出的账号")
        uid, songs = account["uid"], []
        for row in db.execute("SELECT c.*,f.first_listen_ms,f.captured_ms,f.source FROM candidates c LEFT JOIN first_plays f ON f.uid=c.uid AND f.song_id=c.song_id WHERE c.uid=?", (uid,)):
            song = dict(row)
            song["id"] = song.pop("song_id")
            song["sources"] = [r[0] for r in db.execute("SELECT source FROM candidate_sources WHERE uid=? AND song_id=?", (uid, song["id"]))]
            song["observations"] = [dict(r) for r in db.execute("SELECT first_listen_ms,source,captured_ms,upstream_date FROM observations WHERE uid=? AND song_id=?", (uid, song["id"]))]
            songs.append(song)
        return {"format": "chuting-browser", "version": 1, "account": dict(account), "exported_at": datetime.now(timezone.utc).isoformat(), "songs": songs, "checkpoints": {}}
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", default="data")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = export(args.data_dir)
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    print("已导出 %s 首候选、%s 条初听记录" % (len(payload["songs"]), sum(bool(s.get("first_listen_ms")) for s in payload["songs"])))
