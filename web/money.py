"""Currency codes, display, and Stripe minor units. static/money.js is the browser copy."""

SIGNS = {
    "HKD": "HK$",
    "TWD": "NT$",
    "USD": "US$",
    "SGD": "S$",
    "AUD": "A$",
    "CNY": "人民幣 ¥",
    "JPY": "日圓 ¥",
    "KRW": "₩",
    "EUR": "€",
    "GBP": "£",
}
ZERO_DECIMAL = {"JPY", "KRW"}


def text(amount, currency="HKD"):
    if amount is None or isinstance(amount, bool):
        return ""
    amount = float(amount)
    digits = f"{amount:,.0f}" if amount.is_integer() else f"{amount:,.2f}"
    code = (currency or "HKD").upper()
    return f"{SIGNS[code]}{digits}" if code in SIGNS else f"{code} {digits}"


def minor(amount, currency):
    return int(round(amount)) if currency in ZERO_DECIMAL else int(round(amount * 100))


def major(amount, currency):
    return amount if currency in ZERO_DECIMAL else amount / 100
