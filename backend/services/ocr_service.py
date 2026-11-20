"""
OCR Service — Tesseract text extraction plus heuristic regex parsing.

This is the fallback path, used when no ANTHROPIC_API_KEY is configured or the
Claude extraction in services.receipt_ai fails. It also provides the shared
ParsedReceipt type and verify_total().
"""
import logging
import re
import io
from pathlib import Path
from typing import Optional

logger = logging.getLogger("tabulate.ocr")

try:
    import pytesseract
    from PIL import Image, ImageEnhance, ImageFilter
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False
    logger.warning("pytesseract/Pillow not available — OCR disabled")

# Register HEIC/HEIF support via pillow-heif if available
try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF_AVAILABLE = True
except ImportError:
    HEIF_AVAILABLE = False
    logger.info("pillow-heif not installed — HEIC files will not be supported")


def preprocess_image(image: "Image.Image") -> "Image.Image":
    """
    Improve OCR accuracy by preprocessing the receipt image:
    - Convert to grayscale
    - Upscale if small
    - Detect and invert dark-background / white-text regions (e.g. Costco totals)
    - Enhance contrast and sharpen
    """
    import numpy as np

    img = image.convert("L")

    # Upscale small images
    w, h = img.size
    if w < 800:
        scale = 800 / w
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

    # ── Invert dark-background stripes ────────────────────────────────────────
    # Scan the image in horizontal bands. If a band's average pixel value is
    # below 80 (i.e. mostly dark / inverted), invert that band so white-on-black
    # text becomes black-on-white, which Tesseract reads much better.
    try:
        arr = np.array(img)
        band_height = max(1, arr.shape[0] // 40)   # ~40 bands across receipt height
        for y in range(0, arr.shape[0], band_height):
            band = arr[y:y + band_height, :]
            if band.mean() < 80:                    # dark band → invert it
                arr[y:y + band_height, :] = 255 - band
        img = Image.fromarray(arr)
    except Exception:
        pass  # numpy unavailable or array op failed — continue without inversion

    # Enhance contrast and sharpen
    img = ImageEnhance.Contrast(img).enhance(2.0)
    img = img.filter(ImageFilter.SHARPEN)

    return img


def extract_text_from_image(image_bytes: bytes) -> str:
    """
    Run Tesseract OCR on image bytes, return raw text.
    Supports JPEG, PNG, WEBP, and HEIC/HEIF (with pillow-heif installed).
    """
    if not OCR_AVAILABLE:
        raise RuntimeError("OCR dependencies not installed (pytesseract, Pillow)")

    try:
        image = Image.open(io.BytesIO(image_bytes))
    except Exception as e:
        msg = str(e)
        if "heif" in msg.lower() or "heic" in msg.lower() or "cannot identify" in msg.lower():
            if not HEIF_AVAILABLE:
                raise RuntimeError(
                    "HEIC/HEIF files require pillow-heif. "
                    "Rebuild the container: docker compose build --no-cache"
                )
        raise RuntimeError(f"Cannot open image: {msg}")

    # Convert HEIF/palette/CMYK modes → RGB for Tesseract compatibility
    if image.mode not in ("RGB", "L", "RGBA"):
        image = image.convert("RGB")

    processed = preprocess_image(image)

    config = "--psm 6 -c tessedit_char_whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,$%/-:*()#'"
    text = pytesseract.image_to_string(processed, config=config)
    return text.strip()


# ── Receipt Text Parser ───────────────────────────────────────────────────────

# Patterns for common receipt line formats:
#   "ITEM NAME      $4.99"
#   "ITEM NAME      4.99"
#   "2 x ITEM       9.98"
ITEM_LINE_RE = re.compile(
    r'^(?P<qty>\d+\s*[xX]\s*)?(?P<name>[A-Z][A-Z0-9 /&\'\-\.]{2,}?)\s{2,}\$?(?P<price>\d+\.\d{2})\s*$'
)

# Costco / warehouse club format (line uppercased before matching):
#   "E 1136340 3LB ORG GALA   4.49"   (taxable marker E, 7-digit SKU, name, price)
#   "1585373 KS NAPKIN  11.99 A"       (no E marker, trailing A = taxable flag)
#   "3 7816886 FINISHTABS  19.99 A"    (quantity prefix)
COSTCO_LINE_RE = re.compile(
    r'^(?P<qty>\d+\s+)?[E1]?\s*\d{5,8}\s+(?P<name>[A-Z0-9][A-Z0-9/% ]{2,24}?)\s+[$]?(?P<price>\d+[.,]\d{2})(?:\s+.*)?$'
)

# H-E-B / numbered line format (line uppercased before matching):
#   "2 HES CHUCK PATIJES, 1 SLB V 19.33"   (linenum + name + tax-flag + price)
#   "18 HEB ORG TX RTS SLC BBY BL FH 3.98"  (2-digit linenum)
#   "12 GREEN LEAF LET LEAVES FH 3,07"       (comma decimal)
# Line number 1-99 at start, name, optional single/two-letter flag, price (dot or comma)
HEB_LINE_RE = re.compile(
    r'^(?P<qty>\d+)\s+(?P<name>[A-Z][A-Z0-9,\.\' /&\-]{3,40}?)\s+(?:[A-Z]{1,3}\s+)?(?P<price>\d+[.,]\d{2})(?:\s.*)?$'
)

# Lines that indicate totals / metadata (should not be parsed as items)
SKIP_KEYWORDS = {
    'subtotal', 'sub total', 'sub-total', 'tax', 'total', 'change', 'cash',
    'credit', 'debit', 'visa', 'mastercard', 'amex', 'approved', 'balance',
    'savings', 'discount', 'points', 'reward', 'thank', 'receipt', 'store',
    'manager', 'phone', 'tel:', 'www.', '.com', 'member', 'card#', 'transaction',
    'ref#', 'auth', 'batch', 'item', 'qty', 'price', 'amount'
}

# Total/subtotal extraction
# TOTAL_RE: match "Total <anything up to 25 chars> $123.45" on a single line.
# Using [^\d\n]{0,25} handles "Total Sale", "Total Salekek", "TOTAL AMOUNT:", etc.
# Also accept AMOUNT: as a synonym for TOTAL (Costco uses this).
# Also accepts letter-spaced "T O T A L" (Aldi prints it that way) and "AMOUNT DUE".
TOTAL_RE    = re.compile(
    r'(?i)(?:\b(?:total|t\s+o\s+t\s+a\s+l)\b[^\d\n]{0,25}?|amount(?:\s+due)?:?)\s*[$]?\s*(\d+\.\d{2})'
)
SUBTOTAL_RE = re.compile(r'(?i)sub\s*-?\s*total[^\d\n]{0,15}?[$]?\s*(\d+\.\d{2})')
TAX_RE      = re.compile(r'(?i)\btax\b[^\d\n]{0,10}?[$]?\s*(\d+\.\d{2})')
DISCOUNT_RE = re.compile(r'(?i)(savings|discount|coupon)[^a-z\d]*-?[$]?\s*(\d+\.\d{2})')
DATE_RE     = re.compile(r'(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})')
DATE_ISO_RE = re.compile(r'(\d{4}-\d{2}-\d{2})')   # already ISO format
STORE_RE    = re.compile(r'^([A-Z][A-Z\s&\']{3,30}?)(?:\s+#\d+)?$')

# Known grocery / warehouse store keywords → canonical display name.
# Matched case-insensitively against the *full* OCR text so garbled headers
# like "OPAL VAULT... COSTCO pee WV HOL ESALE" still resolve correctly.
KNOWN_STORES: list[tuple[str, str]] = [
    # keyword          canonical name
    ("costco",         "Costco"),
    ("wholesale",      "Costco"),
    ("sam's club",     "Sam's Club"),
    ("sams club",      "Sam's Club"),
    ("walmart",        "Walmart"),
    ("wal-mart",       "Walmart"),
    ("target",         "Target"),
    ("kroger",         "Kroger"),
    ("heb",            "H-E-B"),
    ("h-e-b",          "H-E-B"),
    ("whole foods",    "Whole Foods"),
    ("wholefoods",     "Whole Foods"),
    ("trader joe",     "Trader Joe's"),
    ("trader joes",    "Trader Joe's"),
    ("aldi",           "Aldi"),
    ("publix",         "Publix"),
    ("safeway",        "Safeway"),
    ("albertsons",     "Albertsons"),
    ("meijer",         "Meijer"),
    ("wegmans",        "Wegmans"),
    ("sprouts",        "Sprouts"),
    ("fresh market",   "The Fresh Market"),
    ("market basket",  "Market Basket"),
    ("stop & shop",    "Stop & Shop"),
    ("stop and shop",  "Stop & Shop"),
    ("giant",          "Giant"),
    ("food lion",      "Food Lion"),
    ("winn-dixie",     "Winn-Dixie"),
    ("winndixie",      "Winn-Dixie"),
    ("dollar general", "Dollar General"),
    ("dollar tree",    "Dollar Tree"),
    ("cvs",            "CVS"),
    ("walgreens",      "Walgreens"),
    ("costco",         "Costco"),
]


def _detect_store_from_text(text: str) -> Optional[str]:
    """Scan the full OCR text for known store keywords.  Returns canonical name or None."""
    lower = text.lower()
    for keyword, name in KNOWN_STORES:
        if keyword in lower:
            return name
    return None


class ParsedReceipt:
    def __init__(self):
        self.store_name: Optional[str] = None
        self.receipt_date: Optional[str] = None
        self.subtotal: Optional[float] = None
        self.tax: Optional[float] = None
        self.discounts: float = 0.0
        self.total: Optional[float] = None
        self.raw_items: list[dict] = []   # [{name, price, quantity}]
        self.raw_text: str = ""
        # Set by the Claude path: reconciliation problems left after the re-check.
        self.unresolved_problems: list[str] = []


def parse_receipt_text(text: str) -> ParsedReceipt:
    """
    Parse OCR text into structured receipt data.
    Heuristics-based — designed for common US grocery store formats.
    """
    result = ParsedReceipt()
    result.raw_text = text
    lines = text.split('\n')

    # 1. Keyword scan of the full text — most reliable for known chains
    result.store_name = _detect_store_from_text(text)

    # 2. Fallback: header heuristic (first 5 non-empty lines, all-caps word group)
    if not result.store_name:
        for line in lines[:5]:
            line = line.strip()
            if len(line) > 3 and STORE_RE.match(line.upper()):
                candidate = line.strip()
                if not re.search(r'\d{3,}', candidate):
                    result.store_name = candidate.title()
                    break

    # Extract date — try header first (first 10 lines), then full text.
    # Validate: reject dates with obviously wrong day/month/year from OCR noise.
    def _valid_date(s: str) -> bool:
        """Return True if s looks like a real calendar date (not garbled OCR)."""
        try:
            parts = re.split(r'[/\-]', s)
            if len(parts) != 3:
                return False
            nums = [int(p) for p in parts]
            # Could be M/D/YY, M/D/YYYY, D/M/YY, D/M/YYYY
            # Accept if values are plausible
            if len(parts[2]) == 4:
                year = nums[2]
            elif len(parts[2]) == 2:
                year = 2000 + nums[2]
            else:
                return False
            if year < 2010 or year > 2035:
                return False
            if max(nums[0], nums[1]) > 31 or min(nums[0], nums[1]) < 1:
                return False
            return True
        except Exception:
            return False

    for line in lines[:10]:
        m = DATE_RE.search(line)
        if m and _valid_date(m.group(1)):
            result.receipt_date = m.group(1)
            break
    if not result.receipt_date:
        for line in lines:
            m = DATE_RE.search(line)
            if m and _valid_date(m.group(1)):
                result.receipt_date = m.group(1)
                break

    # Extract financial totals
    for line in lines:
        if not result.subtotal:
            m = SUBTOTAL_RE.search(line)
            if m:
                result.subtotal = float(m.group(1))

        if not result.tax:
            m = TAX_RE.search(line)
            if m:
                result.tax = float(m.group(1))

        m = DISCOUNT_RE.search(line)
        if m:
            result.discounts += float(m.group(2))

    # Total: take the LAST occurrence (grand total, not subtotal)
    all_totals = TOTAL_RE.findall(text)
    if all_totals:
        result.total = float(all_totals[-1])

    # Extract line items
    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Skip metadata/total lines
        lower = line.lower()
        if any(kw in lower for kw in SKIP_KEYWORDS):
            continue

        upper = line.upper()
        # For warehouse-style lines, strip leading OCR noise (punctuation/lowercase artifacts)
        upper_stripped = re.sub(r'^[^A-Z0-9E]+', '', upper)
        m_std    = ITEM_LINE_RE.match(upper)
        m_costco = COSTCO_LINE_RE.match(upper_stripped)
        m_heb    = HEB_LINE_RE.match(upper_stripped)
        m        = m_std or m_costco or m_heb
        is_heb_line = (m is m_heb and m is not None)
        if m:
            name = m.group('name').strip().title()
            price_str = m.group('price').replace(',', '.')
            price = float(price_str)
            qty_raw = m.group('qty')
            qty = 1.0
            if qty_raw and not is_heb_line:
                # For HEB format the leading number is the receipt line number, not qty
                qty_match = re.search(r'(\d+)', qty_raw)
                if qty_match:
                    raw_qty = float(qty_match.group(1))
                    if raw_qty <= 20:
                        qty = raw_qty

            # Filter out obviously wrong items (e.g. store address digits, partial lines)
            # Require: ≥4 chars, >40% alpha, AND at least one "word" with ≥3 alpha chars
            alpha_count = sum(1 for c in name if c.isalpha())
            alpha_ratio = alpha_count / max(len(name), 1)
            has_real_word = any(sum(c.isalpha() for c in w) >= 3 for w in name.split())
            if price > 0 and price < 500 and len(name) >= 4 and alpha_ratio > 0.4 and has_real_word:
                result.raw_items.append({
                    "raw_name": m.group('name').strip(),
                    "clean_name": name,
                    "price": price,
                    "quantity": qty,
                })

    return result


def verify_total(parsed: ParsedReceipt) -> tuple[bool, str]:
    """
    Verify by summing the actual extracted line items + tax against the receipt total.
    The receipt's printed subtotal field is NOT used for verification — it could be
    correctly read from the image even when items are missing or mispriced, producing
    a false positive. We always verify from the ground up: sum(items) + tax == total.
    Returns (is_valid, message).
    """
    if parsed.total is None:
        return False, "Could not find a total on the receipt."

    items_sum = round(sum(i['price'] * i['quantity'] for i in parsed.raw_items), 2)
    if not items_sum:
        return False, "No line items found to verify against."

    # Store the items sum as subtotal so the UI shows what was actually extracted
    parsed.subtotal = items_sum

    tax = parsed.tax or 0.0
    computed = round(items_sum + tax - parsed.discounts, 2)
    expected = round(parsed.total, 2)
    diff = abs(computed - expected)

    if diff <= 0.02:   # allow 2¢ rounding
        return True, (
            f"Items ${items_sum:.2f} + Tax ${tax:.2f}"
            f"{f' − Savings ${parsed.discounts:.2f}' if parsed.discounts else ''}"
            f" = ${computed:.2f} ✓"
        )
    else:
        return False, (
            f"Mismatch: items ${items_sum:.2f} + tax ${tax:.2f} = ${computed:.2f}"
            f" ≠ receipt total ${expected:.2f} (diff ${diff:.2f})."
            f" Check for missing items or manual discounts."
        )
