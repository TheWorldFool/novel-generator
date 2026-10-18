"""Android owns this loopback server; nothing listens on Wi-Fi interfaces."""
from pathlib import Path
import threading
import app

_server = None
_thread = None
_lock = threading.Lock()


def start(files_dir, static_dir, session_token):
    global _server, _thread
    if len(session_token) < 32:
        raise ValueError("A fresh strong session token is required")
    with _lock:
        if _server is None:
            _server = app.AppServer(
                ("127.0.0.1", 0), app.Store(Path(files_dir) / "data" / "novels.sqlite3"),
                session_token=session_token, static_root=static_dir,
            )
            _thread = threading.Thread(target=_server.serve_forever, daemon=True, name="novel-local")
            _thread.start()
        return f"http://127.0.0.1:{_server.server_port}"
