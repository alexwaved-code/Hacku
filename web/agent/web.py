import gzip
import html
import ipaddress
import json
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

import config

from . import cache

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0 Safari/537.36"
)
SERPER_URL = "https://google.serper.dev"
TIMEOUT = 15
MAX_BYTES = 2_500_000
TEXT_LIMIT = 2500
SEARCH_MAX_AGE = 6 * 3600
PAGE_MAX_AGE = 2 * 3600
HKT = timezone(timedelta(hours=8))
REGIONS = {
    "hk": ("hk", "zh-tw", "HKD"),
    "tw": ("tw", "zh-tw", "TWD"),
    "cn": ("cn", "zh-cn", "CNY"),
    "jp": ("jp", "ja", "JPY"),
    "kr": ("kr", "ko", "KRW"),
    "sg": ("sg", "en", "SGD"),
    "us": ("us", "en", "USD"),
    "uk": ("gb", "en", "GBP"),
    "au": ("au", "en", "AUD"),
}
PAGE_PRICE = re.compile(r"(HK\$|NT\$|US\$|S\$|A\$|RMB|CN¥|JP¥|¥|￥|€|£|₩|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)")


class FetchError(Exception):
    pass


def region_code(region):
    return region if region in REGIONS else "hk"


def region_currency(region):
    return REGIONS[region_code(region)][2]


def search(query, limit=8, region="hk"):
    data = _serper("search", query, num=10, region=region)
    results = []
    for item in data.get("organic") or []:
        link = item.get("link")
        if not isinstance(link, str) or not link.startswith(("http://", "https://")):
            continue
        results.append(
            {
                "title": _clean(item.get("title")),
                "url": _strip_tracking(link),
                "site": _site(link),
                "snippet": _clean(item.get("snippet"))[:240],
            }
        )
        if len(results) >= limit:
            break
    return results


def shopping(query, limit=10, region="hk"):
    data = _serper("shopping", query, num=20, region=region)
    observed = datetime.now(HKT).isoformat(timespec="minutes")
    items = []
    for item in data.get("shopping") or []:
        price, currency = _price(item.get("price"), region)
        link = item.get("link")
        if price is None or not isinstance(link, str) or not link.startswith("https://"):
            continue
        items.append(
            {
                "name": _clean(item.get("title"))[:160],
                "store": _clean(item.get("source"))[:60],
                "price": price,
                "currency": currency,
                "rating": _to_number(item.get("rating")),
                "reviews": _to_number(item.get("ratingCount")),
                "image": _absolute(item.get("imageUrl"), link),
                "url": link,
                "observed_at": observed,
            }
        )
        if len(items) >= limit:
            break
    return items


def images(query, limit=10, region="hk"):
    data = _serper("images", query, num=10, region=region)
    results = []
    for item in data.get("images") or []:
        link, image = item.get("link"), item.get("imageUrl")
        if not isinstance(link, str) or not link.startswith("https://"):
            continue
        results.append(
            {
                "title": _clean(item.get("title"))[:160],
                "url": _strip_tracking(link),
                "site": _site(link),
                "image": image if isinstance(image, str) and image.startswith("https://") else None,
            }
        )
        if len(results) >= limit:
            break
    return results


def page_price(text, region="hk"):
    """First price printed near the top of a product page, for stores without structured data."""
    match = PAGE_PRICE.search(str(text or "")[:900])
    if not match:
        return None, None
    return _price(match.group(0), region)


def _serper(kind, query, num, region="hk"):
    query = str(query or "").strip()
    if not query:
        raise FetchError("Empty search query.")
    keys = config.serper_keys()
    if not keys:
        raise FetchError("Web search is not set up. Add SERPER_API_KEY to web/.env.")
    gl, hl, _ = REGIONS[region_code(region)]
    cache_key = json.dumps([kind, query, gl, hl, num], ensure_ascii=False)
    hit = cache.get("serper", cache_key, SEARCH_MAX_AGE)
    if hit is not None:
        return hit
    body = json.dumps({"q": query, "gl": gl, "hl": hl, "num": num}).encode("utf-8")
    now = time.monotonic()
    ready = [key for key in keys if _key_rest.get(key, 0) <= now]
    resting = sorted((key for key in keys if key not in ready), key=lambda key: _key_rest[key])
    problem = None
    for key in ready + resting:
        try:
            data = _serper_call(kind, body, key)
        except _KeyProblem as error:
            _key_rest[key] = time.monotonic() + error.rest
            print(f"Serper key …{key[-4:]} {error}; trying the next key.", flush=True)
            problem = error
            continue
        _key_rest.pop(key, None)
        cache.put("serper", cache_key, data)
        return data
    raise FetchError(problem.message) from problem


class _KeyProblem(Exception):
    def __init__(self, reason, message, rest):
        super().__init__(reason)
        self.message = message
        self.rest = rest


# key -> monotonic time before which the key is skipped
_key_rest = {}


def _serper_call(kind, body, key):
    request = urllib.request.Request(
        f"{SERPER_URL}/{kind}",
        data=body,
        method="POST",
        headers={"X-API-KEY": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = error.read(400).decode("utf-8", "replace").lower()
        except OSError:
            pass
        if error.code in (401, 403):
            raise _KeyProblem("was refused", "The search key was refused. Check SERPER_API_KEY.", 3600) from error
        if error.code == 429:
            raise _KeyProblem("is rate limited", "Search is rate limited. Try again in a minute.", 60) from error
        if "credit" in detail or "quota" in detail:
            raise _KeyProblem("is out of credits", "The search keys are out of credits.", 3600) from error
        raise FetchError(f"Search answered {error.code}.") from error
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
        raise FetchError("Search did not respond.") from error


def _price(value, region="hk"):
    text = str(value or "")
    number = _to_number(text)
    if number is None:
        return None, None
    upper = text.upper()
    local = region_currency(region)
    marks = (
        ("HKD", ("HK$", "HKD")),
        ("TWD", ("NT$", "TWD")),
        ("USD", ("US$", "USD")),
        ("SGD", ("S$", "SGD")),
        ("AUD", ("A$", "AUD")),
        ("JPY", ("JP¥", "JPY", "円")),
        ("CNY", ("CN¥", "RMB", "CNY", "￥")),
        ("KRW", ("₩", "KRW", "원")),
        ("EUR", ("€", "EUR")),
        ("GBP", ("£", "GBP")),
    )
    for code, signs in marks:
        if any(sign in upper for sign in signs):
            return number, code
    if "¥" in text:
        return number, "JPY" if local == "JPY" else "CNY"
    if "元" in text and local not in ("TWD", "CNY"):
        return number, "CNY"
    return number, local


def _strip_tracking(link):
    parts = urllib.parse.urlsplit(link)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query) if k != "srsltid" and not k.startswith("utm_")]
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def read_page(url):
    url = str(url or "").strip()
    hit = cache.get("page", url, PAGE_MAX_AGE)
    if hit is not None:
        return hit
    page = _read_page(url)
    cache.put("page", url, page)
    return page


def _read_page(url):
    page, final_url = _get(url)
    meta = _Meta()
    meta.feed(page)

    product = _product_from_ld(meta.ld_blocks)
    tags = meta.tags
    name = product.get("name") or tags.get("og:title") or meta.title
    image = product.get("image") or tags.get("og:image") or tags.get("twitter:image")
    price = product.get("price")
    currency = product.get("currency")
    if price is None:
        price = _to_number(tags.get("product:price:amount") or tags.get("og:price:amount"))
        currency = tags.get("product:price:currency") or tags.get("og:price:currency") or currency

    site_name = _clean(tags.get("og:site_name"))
    is_product = bool(product) and product.get("offer_kind") != "AggregateOffer" and price is not None
    return {
        "url": final_url,
        "is_product": is_product,
        "site": site_name if 0 < len(site_name) <= 20 else _site(final_url),
        "name": _clean(name)[:160],
        "brand": product.get("brand"),
        "image": _absolute(image, final_url),
        "price": price,
        "list_price": product.get("list_price"),
        "currency": (currency or ("HKD" if price is not None else None)),
        "availability": product.get("availability"),
        "rating": product.get("rating"),
        "reviews": product.get("reviews"),
        "description": _clean(product.get("description") or tags.get("og:description") or tags.get("description"))[:400],
        "text": _clean(" ".join(meta.text))[:TEXT_LIMIT],
        "observed_at": datetime.now(HKT).isoformat(timespec="minutes"),
    }


def _get(url):
    _check_url(url)
    opener = urllib.request.build_opener(_SafeRedirect)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-HK,zh-Hant;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip, deflate",
        },
    )
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
            kind = response.headers.get("Content-Type", "")
            if kind and "html" not in kind and "xml" not in kind:
                raise FetchError(f"Not a web page ({kind.split(';')[0]}).")
            raw = response.read(MAX_BYTES + 1)[:MAX_BYTES]
            encoding = response.headers.get("Content-Encoding", "")
            final_url = response.geturl()
            charset = response.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as error:
        raise FetchError(f"The site answered {error.code}.") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        reason = getattr(error, "reason", error)
        raise FetchError(f"Could not open the page: {reason}") from error

    if encoding == "gzip":
        raw = gzip.decompress(raw)
    elif encoding == "deflate":
        raw = zlib.decompress(raw, -zlib.MAX_WBITS)
    try:
        return raw.decode(charset, errors="replace"), final_url
    except LookupError:
        return raw.decode("utf-8", errors="replace"), final_url


def _check_url(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("Only http and https links can be opened.")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except socket.gaierror as error:
        raise FetchError("That site name does not resolve.") from error
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if not address.is_global:
            raise FetchError("Private and local addresses cannot be opened.")


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class _Meta(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template", "iframe", "head"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags = {}
        self.title = ""
        self.ld_blocks = []
        self.text = []
        self._stack = []
        self._ld = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            key = (attrs.get("property") or attrs.get("name") or attrs.get("itemprop") or "").lower()
            if key and attrs.get("content") and key not in self.tags:
                self.tags[key] = attrs["content"]
        elif tag == "script" and "ld+json" in (attrs.get("type") or ""):
            self._ld = []
        elif tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self._stack.append(tag)

    def handle_endtag(self, tag):
        if tag == "script" and self._ld is not None:
            self.ld_blocks.append("".join(self._ld))
            self._ld = None
        if tag == "title":
            self._in_title = False
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()

    def handle_data(self, data):
        if self._ld is not None:
            self._ld.append(data)
        elif self._in_title:
            self.title += data
        elif not self._stack and data.strip():
            self.text.append(data.strip())


def _product_from_ld(blocks):
    for block in blocks:
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        for node in _walk(data):
            kind = node.get("@type")
            kinds = kind if isinstance(kind, list) else [kind]
            if "Product" in kinds or "ProductGroup" in kinds:
                return _product_fields(node)
    return {}


def _walk(data):
    if isinstance(data, list):
        for item in data:
            yield from _walk(item)
    elif isinstance(data, dict):
        yield data
        for key in ("@graph", "mainEntity", "itemListElement", "item"):
            if key in data:
                yield from _walk(data[key])


def _product_fields(node):
    offers = node.get("offers") or {}
    if isinstance(offers, list):
        offers = offers[0] if offers else {}
    if not isinstance(offers, dict):
        offers = {}
    price = _to_number(offers.get("price") if offers.get("price") is not None else offers.get("lowPrice"))
    spec = offers.get("priceSpecification")
    if price is None and isinstance(spec, dict):
        price = _to_number(spec.get("price"))
    list_price = None
    if isinstance(spec, list):
        values = [_to_number(s.get("price")) for s in spec if isinstance(s, dict)]
        values = [v for v in values if v is not None]
        if price is None and values:
            price = min(values)
        if len(values) > 1:
            list_price = max(values)
    rating = node.get("aggregateRating") if isinstance(node.get("aggregateRating"), dict) else {}
    brand = node.get("brand")
    if isinstance(brand, dict):
        brand = brand.get("name")
    image = node.get("image")
    if isinstance(image, list):
        image = image[0] if image else None
    if isinstance(image, dict):
        image = image.get("url") or image.get("contentUrl")
    availability = str(offers.get("availability") or "").rsplit("/", 1)[-1] or None
    return {
        "offer_kind": offers.get("@type"),
        "name": node.get("name"),
        "brand": brand if isinstance(brand, str) else None,
        "image": image if isinstance(image, str) else None,
        "price": price,
        "list_price": list_price if list_price and price and list_price > price else None,
        "currency": offers.get("priceCurrency"),
        "availability": availability,
        "rating": _to_number(rating.get("ratingValue")),
        "reviews": _to_number(rating.get("reviewCount") or rating.get("ratingCount")),
        "description": node.get("description") if isinstance(node.get("description"), str) else None,
    }


def _absolute(link, base):
    if not isinstance(link, str) or not link.strip():
        return None
    link = urllib.parse.urljoin(base, html.unescape(link.strip()))
    return link if link.startswith("https://") else None


def _site(url):
    host = urllib.parse.urlsplit(url).hostname or ""
    return host[4:] if host.startswith("www.") else host


def _to_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r"\d[\d,]*(?:\.\d+)?", str(value))
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:
        return None


def _clean(value):
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()
