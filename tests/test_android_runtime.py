import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import app


class AndroidServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.token = "fresh-android-session-" + "a" * 40
        web = self.directory / "web"
        web.mkdir()
        (web / "index.html").write_text("android bundled UI", encoding="utf-8")
        self.server = app.AppServer(("127.0.0.1", 0), app.Store(self.directory / "novel.sqlite3"),
                                    session_token=self.token, static_root=web)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, path, body=None, cookie=None, extra=None):
        headers = {"Content-Type": "application/json"}
        if cookie is not None:
            headers["Cookie"] = cookie
        headers.update(extra or {})
        req = Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        with urlopen(req) as response:
            return response.read()

    def test_another_local_app_cannot_read_or_modify_without_session(self):
        for path, body in [("/", None), ("/api/projects", None), ("/api/projects", {"title": "intruder"})]:
            for cookie in [None, "novel_session=wrong", "novel_session=old-session"]:
                with self.subTest(path=path, cookie=cookie), self.assertRaises(HTTPError) as caught:
                    self.request(path, body, cookie)
                self.assertEqual(caught.exception.code, 403)
        self.assertEqual(len(self.server.store.list()), 1)

    def test_authorized_mobile_flow_exports_and_persists(self):
        cookie = "novel_session=" + self.token
        self.assertEqual(self.request("/", cookie=cookie), b"android bundled UI")
        p = json.loads(self.request("/api/projects", {"title": "手机里的小说"}, cookie))["project"]
        chapter = p["chapters"][0]
        args = {"id": chapter["id"], "text": "手机断网时仍可手写。", "summary": "一段离线草稿"}
        updated = json.loads(self.request(f"/api/projects/{p['id']}/mutate",
                            {"revision": p["revision"], "action": "save_chapter", "data": args}, cookie))["project"]
        self.assertIn("手机断网", self.request(f"/api/projects/{p['id']}/export", cookie=cookie).decode())
        backup = json.loads(self.request(f"/api/projects/{p['id']}/backup", cookie=cookie))
        self.assertEqual(backup["project"]["chapters"][0]["text"], args["text"])
        reopened = app.Store(self.directory / "novel.sqlite3").get(p["id"])
        self.assertEqual(reopened["revision"], updated["revision"])
        self.assertNotIn(self.token.encode(), (self.directory / "novel.sqlite3").read_bytes())

    def test_cookie_does_not_bypass_origin_checks(self):
        with self.assertRaises(HTTPError) as caught:
            self.request("/api/projects", cookie="novel_session=" + self.token, extra={"Origin": "https://evil.example"})
        self.assertEqual(caught.exception.code, 403)

    def test_android_entrypoint_is_singleton_and_loopback_only(self):
        source = app.ROOT / "android/app/src/main/python/android_runtime.py"
        spec = importlib.util.spec_from_file_location("android_runtime_test", source)
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        try:
            url = runtime.start(str(self.directory / "runtime"), str(self.directory / "web"), self.token)
            self.assertEqual(url, runtime.start(str(self.directory / "runtime"), str(self.directory / "web"), self.token))
            self.assertEqual(runtime._server.server_address[0], "127.0.0.1")
            with urlopen(Request(url + "/", headers={"Cookie": "novel_session=" + self.token})) as response:
                self.assertEqual(response.read(), b"android bundled UI")
        finally:
            if runtime._server:
                runtime._server.shutdown()
                runtime._server.server_close()
                runtime._thread.join()


if __name__ == "__main__":
    unittest.main()
