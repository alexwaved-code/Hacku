"""Search and page results kept in data/cache.db, so a repeated search answers at once."""

import json
import sqlite3
import threading
import time

import config

_lock = threading.Lock()


def get(kind, key, max_age):
    with _lock, _connect() as conn:
        row = conn.execute("SELECT value, at FROM cache WHERE kind = ? AND key = ?", (kind, key)).fetchone()
    if not row or time.time() - row[1] > max_age:
        return None
    return json.loads(row[0])


def put(kind, key, value):
    with _lock, _connect() as conn:
        conn.execute(
            "INSERT INTO cache (kind, key, value, at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, at = excluded.at",
            (kind, key, json.dumps(value, ensure_ascii=False), time.time()),
        )


def _connect():
    conn = sqlite3.connect(config.data_dir() / "cache.db")
    conn.execute("CREATE TABLE IF NOT EXISTS cache (kind TEXT, key TEXT, value TEXT, at REAL, PRIMARY KEY (kind, key))")
    return conn
