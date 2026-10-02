"""Settings from web/.env. Every module reads configuration from here."""

import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8765
ORIGIN = f"http://{HOST}:{PORT}"


def load_env(path):
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env(ROOT / ".env")


def _base_url(value):
    value = (value or "").strip().rstrip("/")
    return value if not value or value.endswith("/v1") else value + "/v1"


CHAT = {
    "base_url": _base_url(os.environ.get("OPENAI_BASE_URL") or "https://xh.v1api.cc/v1"),
    "api_key": os.environ.get("OPENAI_API_KEY", ""),
    "model": os.environ.get("OPENAI_MODEL") or "deepseek-v4.1-flash",
    "timeout": 25,
}

VERIFY_SEPARATE = all(os.environ.get(name) for name in ("VERIFY_BASE_URL", "VERIFY_API_KEY", "VERIFY_MODEL"))
VERIFY = (
    {
        "base_url": _base_url(os.environ["VERIFY_BASE_URL"]),
        "api_key": os.environ["VERIFY_API_KEY"],
        "model": os.environ["VERIFY_MODEL"],
        "timeout": 30,
    }
    if VERIFY_SEPARATE
    else {**CHAT, "timeout": 30}
)


def serper_key():
    return os.environ.get("SERPER_API_KEY", "").strip()


def stripe_key():
    return os.environ.get("STRIPE_SECRET_KEY", "").strip()


def live_payments():
    """Real money is allowed only when HACKU_LIVE=1 and the key is a live key."""
    return os.environ.get("HACKU_LIVE", "").strip() == "1"


def browser_profile():
    path = data_dir() / "browser"
    path.mkdir(parents=True, exist_ok=True)
    return path


def data_dir():
    path = Path(os.environ.get("HACKU_DATA_DIR") or ROOT / "data")
    path.mkdir(parents=True, exist_ok=True)
    return path


def secret():
    """Server signing secret: HACKU_SECRET, or a random one kept in the data folder."""
    explicit = os.environ.get("HACKU_SECRET", "").strip()
    if explicit:
        return explicit.encode("utf-8")
    path = data_dir() / "secret.key"
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_hex(32))
    return path.read_text().strip().encode("utf-8")
