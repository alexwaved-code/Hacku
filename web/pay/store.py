"""SQLite file in the data folder: mandates, orders, settings, and the hash chain."""

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager

import config

GENESIS = "0" * 64
SCHEMA = """
CREATE TABLE IF NOT EXISTS mandates (
    id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    signature TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    currency TEXT NOT NULL,
    total REAL NOT NULL,
    items TEXT NOT NULL,
    paid INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    created_at TEXT NOT NULL,
    via TEXT NOT NULL DEFAULT 'cart'
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    step TEXT NOT NULL,
    payload TEXT NOT NULL,
    hash TEXT NOT NULL,
    at TEXT NOT NULL
);
"""

_lock = threading.Lock()


@contextmanager
def db():
    """One connection per call, one writer at a time. Commits on success."""
    with _lock:
        conn = sqlite3.connect(config.data_dir() / "hacku.db")
        conn.row_factory = sqlite3.Row
        try:
            conn.executescript(SCHEMA)
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(orders)")}
            if "via" not in columns:
                conn.execute("ALTER TABLE orders ADD COLUMN via TEXT NOT NULL DEFAULT 'cart'")
            yield conn
            conn.commit()
        finally:
            conn.close()


def get(conn, key):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def put(conn, key, value):
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def append(conn, step, payload, at):
    """Add one entry to the hash chain and return its hash."""
    encoded = _encode(payload)
    row = conn.execute("SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1").fetchone()
    link = _link(row["hash"] if row else GENESIS, encoded)
    conn.execute(
        "INSERT INTO ledger (step, payload, hash, at) VALUES (?, ?, ?, ?)",
        (step, encoded, link, at.isoformat(timespec="seconds")),
    )
    return link


def chain_ok(conn):
    previous = GENESIS
    for row in conn.execute("SELECT payload, hash FROM ledger ORDER BY seq"):
        if _link(previous, row["payload"]) != row["hash"]:
            return False
        previous = row["hash"]
    return True


def _encode(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _link(previous, encoded):
    payload_hash = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return hashlib.sha256(f"{previous}:{payload_hash}".encode("utf-8")).hexdigest()
