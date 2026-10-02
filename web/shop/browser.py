"""Fill a store's cart in a real Chrome window and stop before payment.

The window keeps its own profile in data/browser, so a store login survives between orders.
The shopper, or whoever places the order, pays on the store's own page; this module never clicks pay.
Shopify stores take a cart link and a guest checkout, so the delivery address is filled in too.
HKTVmall needs a logged-in account; its saved address book is used at checkout.
"""

import json
import re
import subprocess
import time
import urllib.parse
import urllib.request

import config

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEBUG_PORT = 9333
LOGIN_WAIT = 180
HKTV_HOST = re.compile(r"(^|\.)hktvmall\.com$")
HK_ZONES = {"hong kong": "Hong Kong Island", "hong kong island": "Hong Kong Island", "kowloon": "Kowloon", "new territories": "New Territories"}


class ShopError(Exception):
    pass


def fill(order):
    """Returns (step, note). step is cart_ready, opened, needs_login, or failed."""
    from playwright.sync_api import sync_playwright

    groups = {}
    for item in order["items"]:
        host = urllib.parse.urlparse(item.get("url") or "").hostname or ""
        groups.setdefault(host, []).append(item)
    if not groups or "" in groups:
        return "failed", "訂單裡有商品沒有商店連結。"

    _ensure_chrome()
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{DEBUG_PORT}")
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        results = []
        for host, items in groups.items():
            page = context.new_page()
            if HKTV_HOST.search(host):
                results.append(_hktvmall(page, items))
            else:
                shopify = _shopify_variants(page, items)
                results.append(_shopify(page, shopify, order.get("shipping") or {}) if shopify else _open(page, items))
            page.bring_to_front()
    order_of = ["failed", "needs_login", "opened", "cart_ready"]
    step = min((step for step, _ in results), key=order_of.index)
    return step, " ".join(note for _, note in results)[:300]


def _ensure_chrome():
    if _debug_ready():
        _ensure_window()
        return
    profile = config.browser_profile()
    subprocess.Popen(
        [CHROME, f"--remote-debugging-port={DEBUG_PORT}", f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "about:blank"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        if _debug_ready():
            return
        time.sleep(0.25)
    raise ShopError("Chrome 沒有啟動。")


def _debug_ready():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version", timeout=1):
            return True
    except OSError:
        return False


def _ensure_window():
    """On macOS Chrome keeps running after its last window closes, and then CDP clients cannot attach."""
    base = f"http://127.0.0.1:{DEBUG_PORT}/json"
    with urllib.request.urlopen(f"{base}/list", timeout=2) as response:
        if any(target.get("type") == "page" for target in json.loads(response.read())):
            return
    urllib.request.urlopen(urllib.request.Request(f"{base}/new?about:blank", method="PUT"), timeout=5).close()


def _hktvmall(page, items):
    page.goto(items[0]["url"], wait_until="domcontentloaded", timeout=45000)
    if not _hktv_logged_in(page):
        page.goto("https://www.hktvmall.com/hktv/zh/login", wait_until="domcontentloaded", timeout=45000)
        deadline = time.time() + LOGIN_WAIT
        while time.time() < deadline and "login" in page.url:
            page.wait_for_timeout(1500)
        if "login" in page.url:
            return "needs_login", "HKTVmall 要先登入：請在打開的 Chrome 視窗登入一次，再按一次代填。"
    added = 0
    for item in items:
        page.goto(item["url"], wait_until="domcontentloaded", timeout=45000)
        button = page.locator("button.addToCartButton").first
        try:
            button.wait_for(state="visible", timeout=15000)
        except Exception:
            continue
        qty = page.locator("input.qty, input[name='qty'], input[type='number']").first
        if item.get("qty", 1) > 1 and qty.count():
            qty.fill(str(item["qty"]))
        button.click()
        page.wait_for_timeout(2500)
        added += 1
    page.goto("https://www.hktvmall.com/hktv/zh/cart", wait_until="domcontentloaded", timeout=45000)
    if added < len(items):
        return "opened", f"HKTVmall 只加入了 {added}/{len(items)} 件，請在購物車確認。"
    return "cart_ready", "HKTVmall 購物車已備好，請選送貨地址並付款。"


def _hktv_logged_in(page):
    page.wait_for_timeout(1500)
    login = page.locator("a[href*='/login']").filter(has_text=re.compile(r"^(Login|登入)$"))
    return login.count() == 0 or not login.first.is_visible()


def _shopify_variants(page, items):
    """Shopify serves /products/<handle>.js. Read it from the store's own page, as a visitor would."""
    variants = []
    for item in items:
        parts = urllib.parse.urlparse(item["url"])
        match = re.search(r"/products/([^/?#]+)", parts.path)
        if not match:
            return None
        page.goto(item["url"], wait_until="domcontentloaded", timeout=45000)
        path = f"/products/{match.group(1)}.js"
        if not isinstance(_page_json(page, path), dict):
            return None
        _shopify_ship_to_hk(page)
        product = _page_json(page, path)
        if not isinstance(product, dict):
            return None
        variant = next((v for v in product.get("variants") or [] if v.get("available")), None)
        if not variant:
            return None
        variants.append({"origin": f"{parts.scheme}://{parts.netloc}", "id": variant["id"], "qty": item.get("qty", 1),
                         "price": variant.get("price", 0) / 100, "paid": item.get("price"), "name": item.get("name", "")})
    return variants


def _page_json(page, path):
    return page.evaluate(
        """async (path) => {
            try {
                const response = await fetch(path, { headers: { Accept: "application/json" } });
                return response.ok ? JSON.parse(await response.text()) : null;
            } catch { return null; }
        }""",
        path,
    )


def _shopify_ship_to_hk(page):
    """Shopify picks the market from the visitor's IP; the order ships to Hong Kong in HKD."""
    page.evaluate(
        """async () => {
            const body = new URLSearchParams({ form_type: "localization", _method: "put", country_code: "HK", return_to: "/" });
            try { await fetch("/localization", { method: "POST", body, redirect: "manual" }); } catch {}
        }"""
    )


def _shopify(page, variants, shipping):
    cart = ",".join(f"{v['id']}:{v['qty']}" for v in variants)
    page.goto(f"{variants[0]['origin']}/cart/{cart}", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(3000)
    country = page.locator("select[name='countryCode']").first
    if country.count():
        try:
            country.select_option("HK", timeout=3000)
            page.wait_for_timeout(1500)
        except Exception:
            pass
    first, _, last = (shipping.get("name") or "").strip().partition(" ")
    fields = {
        "email": shipping.get("email"),
        "firstName": first,
        "lastName": last or first,
        "address1": shipping.get("line1"),
        "address2": shipping.get("line2"),
        "city": shipping.get("city") or shipping.get("state"),
        "phone": shipping.get("phone"),
    }
    filled = 0
    for name, value in fields.items():
        box = page.locator(f"input[name='{name}']").first
        if value and box.count():
            try:
                box.fill(value, timeout=3000)
                filled += 1
            except Exception:
                pass
    zone = HK_ZONES.get((shipping.get("state") or "").strip().lower())
    if zone and page.locator("select[name='zone']").count():
        try:
            page.locator("select[name='zone']").first.select_option(label=zone, timeout=3000)
        except Exception:
            pass
    higher = [v for v in variants if isinstance(v["paid"], (int, float)) and v["price"] > v["paid"] + 0.01]
    warn = f" 注意：{higher[0]['name'][:20]} 現價 {higher[0]['price']:.2f}，比付款時高。" if higher else ""
    if filled == 0:
        return "opened", f"{variants[0]['origin']} 的結帳頁已開啟，地址請自己填。{warn}"
    return "cart_ready", f"{variants[0]['origin']} 已放好商品、填好地址，停在付款頁。{warn}"


def _open(page, items):
    page.goto(items[0]["url"], wait_until="domcontentloaded", timeout=45000)
    return "opened", "這間店不能自動代填，已開啟商品頁。"
