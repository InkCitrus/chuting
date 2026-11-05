import json
import tempfile
import threading
import time
import unittest
from datetime import datetime
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from music_calendar.client import ApiError
from music_calendar.store import Store, parse_first_info
from music_calendar.sync import SyncManager
from music_calendar.server import Application, make_handler


def response(stamp=1704124800000, name="Example"):
    return {"code": 200, "data": {"songInfoDto": {"songName": name, "singer": "Artist"},
        "musicFirstListenDto": {"listenTime": stamp, "date": "upstream date"},
        "musicTotalPlayDto": {"playCount": 12}}}


class StoreTests(unittest.TestCase):
    def test_old_empty_results_are_retried_automatically(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            store.candidates("1", [{"id": "10"}], "test")
            store.save_result("1", "10", {"code": 200, "data": {}})
            self.assertEqual(store.pending("1"), [])
            with store.connection() as db:
                db.execute("UPDATE candidates SET last_attempt_ms=0 WHERE uid='1'")
            self.assertEqual([s["song_id"] for s in store.pending("1")], ["10"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.store.candidates("1", [{"id": "10", "name": "Original"}], "recent")

    def tearDown(self):
        self.temp.cleanup()

    def test_timezone_boundary_preserves_exact_timestamp(self):
        # Dec 31 UTC is Jan 1 in Shanghai. Seconds and milliseconds survive.
        stamp = 1704038400123
        self.store.save_result("1", "10", response(stamp))
        event = self.store.events("1", "2024-01")[0]
        self.assertEqual((event["date"], event["time"]), ("2024-01-01", "00:00"))
        self.assertEqual(event["first_listen_ms"], stamp)
        self.assertEqual(self.store.events("1", "2023-12"), [])

    def test_repeat_import_is_idempotent_and_keeps_metadata(self):
        self.store.save_result("1", "10", response())
        self.store.candidates("1", [{"id": "10"}], "liked")
        self.store.save_result("1", "10", response())
        rows = self.store.events("1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rows[0]["observations"]), 1)
        self.assertEqual(rows[0]["name"], "Example")
        self.assertEqual(self.store.stats("1")["discovered"], 1)

    def test_conflicting_timestamp_preserves_both_facts(self):
        self.store.save_result("1", "10", response())
        self.assertEqual(self.store.save_result("1", "10", response(1704211200000)), "conflict")
        row = self.store.events("1")[0]
        self.assertEqual(row["first_listen_ms"], 1704124800000)
        self.assertEqual(len(row["observations"]), 2)
        self.assertEqual(self.store.stats("1")["conflicts"], 1)
        self.store.save_result("1", "10", response())
        self.assertEqual(self.store.events("1")[0]["status"], "conflict")

    def test_mismatched_song_is_rejected(self):
        body = response()
        body["data"]["songInfoDto"]["songId"] = 11
        with self.assertRaises(ValueError):
            self.store.save_result("1", "10", body)
        self.assertEqual(self.store.events("1"), [])

    def test_account_isolation(self):
        self.store.save_result("1", "10", response())
        self.store.candidates("2", [{"id": "10"}], "liked")
        self.assertEqual(self.store.events("2"), [])
        self.assertEqual(self.store.stats("2")["available"], 0)

    def test_empty_is_distinct_from_failed_and_can_be_retried(self):
        self.store.save_result("1", "10", {"code": 200, "data": {}})
        self.assertEqual(self.store.pending("1"), [])
        self.assertEqual(len(self.store.pending("1", retry_empty=True)), 1)
        self.store.failure("1", "10", "timeout")
        self.assertEqual(self.store.stats("1")["failed"], 1)
        self.assertEqual(len(self.store.pending("1")), 1)

    def test_local_archive_reopens_without_network_login(self):
        self.store.account("1", "Archive")
        self.store.save_result("1", "10", response())
        app = Application(self.temp.name, client=FakeClient())
        self.assertEqual(app.account["uid"], "1")
        self.assertEqual(app.status()["stats"]["available"], 1)
        app.close()

    def test_empty_refresh_cannot_erase_existing_fact(self):
        self.store.save_result("1", "10", response())
        self.store.save_result("1", "10", {"code": 200, "data": {}})
        self.assertEqual(len(self.store.events("1")), 1)
        self.assertEqual(self.store.stats("1")["available"], 1)

    def test_seconds_and_future_dates_are_not_imported_as_milliseconds(self):
        for stamp in [1704124800, True, "unknown", 9999999999999]:
            with self.assertRaises(ValueError):
                parse_first_info(response(stamp))
        self.assertIsNone(parse_first_info({"code": 200, "data": {}}))

    def test_search_treats_wildcards_as_literal_text(self):
        self.store.save_result("1", "10", response(name="100% music"))
        self.assertEqual(len(self.store.events("1", query="%")), 1)
        self.assertEqual(len(self.store.events("1", query="_")), 0)


class FakeClient:
    def __init__(self, failure=None):
        self.calls = []
        self.failure = failure

    def close(self):
        pass

    def login(self):
        return {"uid": "1", "nickname": "Test"}

    def call(self, method, **query):
        self.calls.append((method, query))
        if method == "record_recent_song":
            return {"code": 200, "data": {"list": [{"data": {"id": 10, "name": "Song"}}, {"data": {"id": 11, "name": "Other"}}]}}
        if method == "user_record":
            return {"code": 200, "allData": []}
        if method == "likelist":
            return {"code": 200, "ids": [10]}
        if method == "song_detail":
            return {"code": 200, "songs": [{"id": int(i), "name": "Song " + i} for i in query["ids"].split(",")]}
        if method == "music_first_listen_info":
            if self.failure:
                raise self.failure
            return response() if query["id"] == "10" else {"code": 200, "data": {}}
        raise AssertionError(method)


class SyncTests(unittest.TestCase):
    def test_resume_skips_completed_and_empty_candidates(self):
        with tempfile.TemporaryDirectory() as d:
            store, client = Store(d), FakeClient()
            manager = SyncManager(store, client, delay=0)
            manager.start(client.login(), limit=1, playlists=False)
            manager.thread.join(3)
            self.assertFalse(manager.thread.is_alive())
            manager.start(client.login(), limit=0, playlists=False)
            manager.thread.join(3)
            calls = [q["id"] for name, q in client.calls if name == "music_first_listen_info"]
            self.assertEqual(calls, ["10", "11"])
            self.assertEqual(store.stats("1")["available"], 1)
            self.assertEqual(store.stats("1")["empty"], 1)

    def test_liked_only_skips_recent_plays_and_rankings(self):
        with tempfile.TemporaryDirectory() as d:
            store, client = Store(d), FakeClient()
            manager = SyncManager(store, client, delay=0)
            manager.start(client.login(), limit=0, playlists=False, recent=False)
            manager.thread.join(3)
            methods = [name for name, _ in client.calls]
            self.assertNotIn("record_recent_song", methods)
            self.assertNotIn("user_record", methods)
            self.assertEqual([q["id"] for name, q in client.calls if name == "music_first_listen_info"], ["10"])

    def test_rate_limit_stops_instead_of_looping(self):
        with tempfile.TemporaryDirectory() as d:
            store, client = Store(d), FakeClient(ApiError("rate limit", 429))
            manager = SyncManager(store, client, delay=0)
            manager.start(client.login(), limit=0, playlists=False)
            manager.thread.join(3)
            self.assertEqual(store.last_run("1")["status"], "failed")
            self.assertEqual(sum(n == "music_first_listen_info" for n, _ in client.calls), 1)
            self.assertEqual(store.stats("1")["pending"], 1)

    def test_interruption_is_recorded(self):
        with tempfile.TemporaryDirectory() as d:
            store, client = Store(d), FakeClient()
            manager = SyncManager(store, client, delay=.1)
            manager.start(client.login(), limit=0, playlists=False)
            manager.cancel()
            manager.thread.join(3)
            self.assertEqual(store.last_run("1")["status"], "paused")


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.app = Application(cls.temp.name, client=FakeClient(), delay=0)
        cls.app.account = {"uid": "1", "nickname": "Test"}
        cls.app.store.candidates("1", [{"id": "10"}], "test")
        cls.app.store.save_result("1", "10", response(name="=SUM(1,2)"))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(cls.app))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%s" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.app.close()
        cls.temp.cleanup()

    def test_month_filter_and_csv_formula_protection(self):
        with urlopen(self.base + "/api/events?month=2024-01") as r:
            self.assertEqual(len(json.load(r)["events"]), 1)
        with urlopen(self.base + "/api/export?format=csv") as r:
            self.assertIn("'=SUM", r.read().decode("utf-8-sig"))

    def test_cross_origin_and_invalid_host_are_rejected(self):
        for request in [Request(self.base + "/api/sync", data=b"{}", headers={"Content-Type": "application/json", "Origin": "https://example.org"}),
                        Request(self.base + "/api/status", headers={"Host": "evil.example"})]:
            with self.assertRaises(HTTPError) as ctx:
                urlopen(request)
            self.assertEqual(ctx.exception.code, 403)

    def test_invalid_month_is_bad_request(self):
        with self.assertRaises(HTTPError) as ctx:
            urlopen(self.base + "/api/events?month=2024-13")
        self.assertEqual(ctx.exception.code, 400)

    def test_ui_is_served_with_local_only_content_policy(self):
        with urlopen(self.base) as r:
            self.assertIn("frame-ancestors 'none'", r.headers["Content-Security-Policy"])
            self.assertIn("初听", r.read().decode())


if __name__ == "__main__":
    unittest.main()
