import hashlib
import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


def now_ms():
    return int(time.time() * 1000)


def parse_first_info(body):
    if body.get("code") != 200:
        raise ValueError("接口没有返回成功状态")
    data = body.get("data") or {}
    first = data.get("musicFirstListenDto") or {}
    raw = first.get("listenTime")
    if raw in (None, 0, "0", ""):
        return None
    if isinstance(raw, bool):
        raise ValueError("初听时间格式异常")
    try:
        stamp = int(raw)
    except (ValueError, TypeError):
        raise ValueError("初听时间格式异常")
    # This endpoint uses milliseconds. Do not silently promote second timestamps.
    if stamp < 946684800000 or stamp > now_ms() + 86400000:
        raise ValueError("初听时间的单位或范围异常")
    song = data.get("songInfoDto") or {}
    return {
        "first_listen_ms": stamp,
        "name": song.get("songName") or "",
        "artists": song.get("singer") or "",
        "play_count": (data.get("musicTotalPlayDto") or {}).get("playCount"),
        "upstream_date": first.get("date"),
        "source": "/music/first/listen/info",
    }


class Store:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / "calendar.sqlite3"
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS accounts (
                    uid TEXT PRIMARY KEY, nickname TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS candidates (
                    uid TEXT NOT NULL, song_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
                    artists TEXT NOT NULL DEFAULT '', album TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                    last_attempt_ms INTEGER, error TEXT, play_count INTEGER,
                    PRIMARY KEY(uid, song_id));
                CREATE TABLE IF NOT EXISTS candidate_sources (
                    uid TEXT NOT NULL, song_id TEXT NOT NULL, source TEXT NOT NULL,
                    PRIMARY KEY(uid, song_id, source));
                CREATE TABLE IF NOT EXISTS first_plays (
                    uid TEXT NOT NULL, song_id TEXT NOT NULL, first_listen_ms INTEGER NOT NULL,
                    source TEXT NOT NULL, captured_ms INTEGER NOT NULL,
                    PRIMARY KEY(uid, song_id));
                CREATE INDEX IF NOT EXISTS first_plays_by_time ON first_plays(uid, first_listen_ms);
                CREATE TABLE IF NOT EXISTS observations (
                    uid TEXT NOT NULL, song_id TEXT NOT NULL, first_listen_ms INTEGER NOT NULL,
                    source TEXT NOT NULL, captured_ms INTEGER NOT NULL, raw_file TEXT NOT NULL,
                    upstream_date TEXT, UNIQUE(uid, song_id, first_listen_ms));
                CREATE TABLE IF NOT EXISTS runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL,
                    status TEXT NOT NULL, phase TEXT NOT NULL, queried INTEGER NOT NULL DEFAULT 0,
                    found INTEGER NOT NULL DEFAULT 0, empty INTEGER NOT NULL DEFAULT 0,
                    failed INTEGER NOT NULL DEFAULT 0, error TEXT,
                    started_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
            """)
        self.path.chmod(0o600)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(str(self.path), timeout=20)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def account(self, uid, nickname):
        with self.connection() as db:
            db.execute("INSERT INTO accounts VALUES (?,?) ON CONFLICT(uid) DO UPDATE SET nickname=excluded.nickname", (str(uid), nickname))
            db.execute("INSERT INTO settings VALUES ('active_uid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(uid),))

    def active_account(self):
        with self.connection() as db:
            row = db.execute("SELECT * FROM accounts WHERE uid=(SELECT value FROM settings WHERE key='active_uid')").fetchone()
            if row is None:
                row = db.execute("SELECT * FROM accounts ORDER BY rowid DESC LIMIT 1").fetchone()
        return dict(row) if row else None

    def candidates(self, uid, songs, source):
        with self.connection() as db:
            for song in songs:
                sid = str(song.get("id", ""))
                if not sid.isdigit() or int(sid) <= 0:
                    continue
                db.execute("""INSERT INTO candidates(uid,song_id,name,artists,album) VALUES (?,?,?,?,?)
                    ON CONFLICT(uid,song_id) DO UPDATE SET
                    name=CASE WHEN excluded.name!='' THEN excluded.name ELSE candidates.name END,
                    artists=CASE WHEN excluded.artists!='' THEN excluded.artists ELSE candidates.artists END,
                    album=CASE WHEN excluded.album!='' THEN excluded.album ELSE candidates.album END""",
                    (str(uid), sid, song.get("name") or "", song.get("artists") or "", song.get("album") or ""))
                db.execute("INSERT OR IGNORE INTO candidate_sources VALUES (?,?,?)", (str(uid), sid, source))

    def pending(self, uid, retry_empty=False, limit=100):
        states = "'pending','failed'" + (",'empty'" if retry_empty else "")
        with self.connection() as db:
            return [dict(r) for r in db.execute(
                "SELECT * FROM candidates WHERE uid=? AND (status IN (" + states + ") OR (status='empty' AND last_attempt_ms<=?)) ORDER BY attempts, CASE WHEN name!='' THEN 0 ELSE 1 END, CAST(song_id AS INTEGER) LIMIT ?", (str(uid), now_ms() - 30 * 86400000, limit))]

    def save_result(self, uid, sid, body):
        uid, sid = str(uid), str(sid)
        if not uid.isdigit() or not sid.isdigit():
            raise ValueError("账号或歌曲 ID 格式异常")
        returned_id = ((body.get("data") or {}).get("songInfoDto") or {}).get("songId")
        if returned_id is not None and str(returned_id) != sid:
            raise ValueError("接口返回的歌曲 ID 与查询的不一致")
        fact = parse_first_info(body)
        serialized = json.dumps(body, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha256(serialized.encode()).hexdigest()
        raw = self.directory / "raw" / uid / (sid + "-" + digest[:20] + ".json")
        raw.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        raw.write_text(serialized, encoding="utf-8")
        raw.chmod(0o600)
        stamp = now_ms()
        with self.connection() as db:
            old = db.execute("SELECT first_listen_ms FROM first_plays WHERE uid=? AND song_id=?", (uid, sid)).fetchone()
            status = "available" if fact or old else "empty"
            if fact:
                if old and old[0] != fact["first_listen_ms"]:
                    status = "conflict"
                db.execute("INSERT OR IGNORE INTO first_plays VALUES (?,?,?,?,?)", (uid, sid, fact["first_listen_ms"], fact["source"], stamp))
                db.execute("INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?,?)", (uid, sid, fact["first_listen_ms"], fact["source"], stamp, str(raw.relative_to(self.directory)), fact["upstream_date"]))
                db.execute("UPDATE candidates SET name=CASE WHEN ?!='' THEN ? ELSE name END, artists=CASE WHEN ?!='' THEN ? ELSE artists END, play_count=COALESCE(?,play_count) WHERE uid=? AND song_id=?",
                           (fact["name"], fact["name"], fact["artists"], fact["artists"], fact["play_count"], uid, sid))
            if db.execute("SELECT count(*) FROM observations WHERE uid=? AND song_id=?", (uid, sid)).fetchone()[0] > 1:
                status = "conflict"
            db.execute("UPDATE candidates SET status=?,attempts=attempts+1,last_attempt_ms=?,error=NULL WHERE uid=? AND song_id=?", (status, stamp, uid, sid))
        return status

    def failure(self, uid, sid, message):
        with self.connection() as db:
            db.execute("UPDATE candidates SET status='failed',attempts=attempts+1,last_attempt_ms=?,error=? WHERE uid=? AND song_id=?", (now_ms(), message[:200], str(uid), str(sid)))

    def stats(self, uid):
        with self.connection() as db:
            states = {r[0]: r[1] for r in db.execute("SELECT status,count(*) FROM candidates WHERE uid=? GROUP BY status", (str(uid),))}
            count = db.execute("SELECT count(*) FROM first_plays WHERE uid=?", (str(uid),)).fetchone()[0]
            conflicts = db.execute("SELECT count(*) FROM (SELECT song_id FROM observations WHERE uid=? GROUP BY song_id HAVING count(*)>1)", (str(uid),)).fetchone()[0]
            sources = [dict(r) for r in db.execute("SELECT source,count(*) AS count FROM candidate_sources WHERE uid=? GROUP BY source ORDER BY count(*) DESC", (str(uid),))]
        return {"discovered": sum(states.values()), "queried": sum(v for k, v in states.items() if k != "pending"), "available": count,
                "pending": states.get("pending", 0), "empty": states.get("empty", 0), "failed": states.get("failed", 0), "conflicts": conflicts, "sources": sources}

    def events(self, uid, month=None, query="", tz="Asia/Shanghai", limit=10000):
        zone = ZoneInfo(tz)
        sql = """SELECT f.*,c.name,c.artists,c.album,c.play_count,c.status FROM first_plays f
                 JOIN candidates c USING(uid,song_id) WHERE f.uid=?"""
        args = [str(uid)]
        if month:
            start = datetime.strptime(month, "%Y-%m").replace(tzinfo=zone)
            end = datetime(start.year + (start.month == 12), start.month % 12 + 1, 1, tzinfo=zone)
            sql += " AND f.first_listen_ms>=? AND f.first_listen_ms<?"
            args += [int(start.timestamp() * 1000), int(end.timestamp() * 1000)]
        if query:
            sql += " AND (c.name LIKE ? ESCAPE '\\' OR c.artists LIKE ? ESCAPE '\\')"
            term = "%" + query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            args += [term, term]
        sql += " ORDER BY f.first_listen_ms, f.song_id LIMIT ?"
        args.append(limit)
        with self.connection() as db:
            rows = [dict(r) for r in db.execute(sql, args)]
            for row in rows:
                local = datetime.fromtimestamp(row["first_listen_ms"] / 1000, timezone.utc).astimezone(zone)
                row.update(date=local.strftime("%Y-%m-%d"), time=local.strftime("%H:%M"), timestamp_local=local.isoformat(), kind="first_listen", timezone=tz)
                row["name"] = row["name"] or "歌曲 " + row["song_id"]
                row["observations"] = [dict(r) for r in db.execute("SELECT first_listen_ms,source,captured_ms,upstream_date FROM observations WHERE uid=? AND song_id=? ORDER BY captured_ms", (str(uid), row["song_id"]))]
                if len(row["observations"]) > 1:
                    row["status"] = "conflict"
        return rows

    def calendar_meta(self, uid):
        with self.connection() as db:
            times = [r[0] for r in db.execute("SELECT first_listen_ms FROM first_plays WHERE uid=?", (str(uid),))]
        dates = [datetime.fromtimestamp(t / 1000, ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d") for t in times]
        return {"months": sorted({d[:7] for d in dates}), "days": len(set(dates)), "earliest": min(dates) if dates else None, "latest": max(dates) if dates else None}

    def new_run(self, uid):
        with self.connection() as db:
            cur = db.execute("INSERT INTO runs(uid,status,phase,started_ms,updated_ms) VALUES (?,'running','确认账号',?,?)", (str(uid), now_ms(), now_ms()))
            return cur.lastrowid

    def update_run(self, run_id, **values):
        allowed = {"status", "phase", "queried", "found", "empty", "failed", "error"}
        values = {k: v for k, v in values.items() if k in allowed}
        values["updated_ms"] = now_ms()
        with self.connection() as db:
            db.execute("UPDATE runs SET " + ",".join(k + "=?" for k in values) + " WHERE id=?", list(values.values()) + [run_id])

    def last_run(self, uid):
        with self.connection() as db:
            row = db.execute("SELECT * FROM runs WHERE uid=? ORDER BY id DESC LIMIT 1", (str(uid),)).fetchone()
        return dict(row) if row else None

    def recover_runs(self):
        with self.connection() as db:
            db.execute("UPDATE runs SET status='interrupted',phase='上次同步意外中断，可以接着同步',updated_ms=? WHERE status='running'", (now_ms(),))
