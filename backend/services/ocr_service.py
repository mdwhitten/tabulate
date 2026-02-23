"""
OCR Service — extracts text from receipt images using Tesseract, then parses
the result with heuristic regexes.  When ANTHROPIC_API_KEY is available a
second, higher-quality pass is made via Claude Vision which reads the image
directly and returns structured JSON — bypassing fragile regex parsing
entirely for store name, date, line items and totals.
"""
import logging
import re
import io
import os
import json
import base64
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
TOTAL_RE    = re.compile(r'(?i)(?:\btotal\b[^\d\n]{0,25}?|amount:)\s*[$]?\s*(\d+\.\d{2})')
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


def _prepare_image_for_vision(image_bytes: bytes) -> tuple[bytes, str]:
    """
    Resize + compress an image so it fits within Claude Vision limits:
    - Max dimension: 1568px on the long side (Claude's optimal size for receipts)
    - Max file size: ~4 MB base64 decoded
    Returns (compressed_bytes, media_type).
    """
    # Detect original media type from magic bytes
    if image_bytes[:4] == b'\x89PNG':
        orig_type = "image/png"
    elif image_bytes[:3] == b'\xff\xd8\xff':
        orig_type = "image/jpeg"
    elif image_bytes[:4] in (b'MM\x00\x2a', b'II\x2a\x00'):
        orig_type = "image/tiff"
    elif image_bytes[:4] == b'%PDF':
        return image_bytes, "application/pdf"   # caller will skip vision
    else:
        orig_type = "image/jpeg"   # HEIC / WEBP etc.

    # If Pillow isn't available, return raw bytes + detected type
    if not OCR_AVAILABLE:
        return image_bytes, "image/jpeg"

    try:
        img = Image.open(io.BytesIO(image_bytes))
        # Normalise EXIF orientation and mode
        from PIL import ImageOps as _IOps
        img = _IOps.exif_transpose(img)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        # Resize: keep aspect ratio, long side ≤ 1568px (Claude Vision optimal)
        max_dim = 1568
        w, h = img.size
        long_side = max(w, h)
        if long_side > max_dim:
            scale = max_dim / long_side
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            logger.debug("Resized image %d×%d → %d×%d", w, h, img.size[0], img.size[1])

        # Save as JPEG — use quality=92 to preserve text legibility for Vision
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92, optimize=True)
        compressed = buf.getvalue()
        logger.debug("Image size: %d KB → %d KB", len(image_bytes)//1024, len(compressed)//1024)
        return compressed, "image/jpeg"
    except Exception as e:
        logger.warning("Image prep failed (%s), sending original", e)
        return image_bytes, orig_type


async def parse_receipt_with_vision(
    image_bytes: bytes,
    ocr_fallback: ParsedReceipt,
) -> ParsedReceipt:
    """
    Use Claude Vision to extract structured receipt data directly from the image.
    Returns a ParsedReceipt populated by Claude.  Falls back to `ocr_fallback`
    (already parsed by Tesseract) if the API key is missing or the call fails.

    Claude sees the image natively so it handles any store layout, font, or
    language — far more robust than regex parsing of Tesseract output.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return ocr_fallback

    # Resize + compress to stay within Claude Vision limits
    vision_bytes, media_type = _prepare_image_for_vision(image_bytes)
    if media_type == "application/pdf":
        return ocr_fallback   # can't send PDFs to vision

    # Encode image as base64 for the Claude Messages API
    b64 = base64.standard_b64encode(vision_bytes).decode()
    logger.info("Sending %d KB b64 (%s) to Claude Vision", len(b64)//1024, media_type)

    # Include Tesseract OCR text as a hint — gives Claude a text anchor for
    # name↔price alignment, which prevents the "price shifted one row" bug that
    # occurs when Vision tries to align two columns independently from the image.
    ocr_hint = ""
    if ocr_fallback.raw_text and ocr_fallback.raw_text.strip():
        ocr_hint = f"""
The following text was extracted from this receipt by OCR (may be incomplete or contain errors — use the image as the primary source, but use this to help align item names with their correct prices):

<ocr_text>
{ocr_fallback.raw_text.strip()}
</ocr_text>
"""

    prompt = f"""You are a receipt data extractor. Carefully transcribe this grocery receipt image line by line, then output structured JSON.

STEP 1 — Read the receipt line by line, exactly as printed. Do this in your head before outputting JSON.

STEP 2 — Apply these rules to parse items:

This receipt uses H-E-B format. Items are numbered 1, 2, 3… These numbers are LINE NUMBERS, not quantities.

For EVERY item record three values:
  • quantity   — how many units purchased (1 if not stated)
  • price      — the UNIT price (cost for ONE item)
  • line_total — the TOTAL charged for this line (rightmost dollar amount on the item or its detail line)

SELF-CHECK: price × quantity must equal line_total (within $0.02). If they don't match, re-read the line.

TWO-LINE items: name on one line (no price), then an indented detail line below:
  PATTERN A — Multi-pack ("N Ea. @ 1/ UNIT_PRICE  LINE_TOTAL"):
    "2  OTB CAFE TORT CHIPS"
    "   2 Ea. @ 1/  3.88 F   7.76"
  → name="OTB CAFE TORT CHIPS", quantity=2, price=3.88, line_total=7.76
    (3.88 × 2 = 7.76 ✓)

  PATTERN B — Promo multi-pack ("N Ea. @ N/PROMO_PRICE  LINE_TOTAL"):
    "5  STAUFFERS ORTG ANIMAL"
    "   1 Ea. @ 2/  3.00 F   1.50"
  → name="STAUFFERS ORTG ANIMAL", quantity=1, price=1.50, line_total=1.50
    (buying 1 of a 2/$3.00 deal: unit price = 3.00÷2 = 1.50; 1.50 × 1 = 1.50 ✓)

  PATTERN C — Weighted (sold by weight, "WEIGHT Lbs @ 1/RATE  LINE_TOTAL"):
    "15 JUMBO WHITE ONION"
    "   0.69 Lbs @ 1/ 1.28 FW  0.88"
  → name="JUMBO WHITE ONION", quantity=1, price=0.88, line_total=0.88
    (rightmost number is the actual charge; 0.88 × 1 = 0.88 ✓)

SINGLE-LINE items have price at the right end of the name line:
  "3  HEB TX ROOTS CAMPARI TOMA FW   3.47"
  → name="HEB TX ROOTS CAMPARI TOMA FW", quantity=1, price=3.47, line_total=3.47

KEY RULE: An indented detail line (one that starts with spaces, or begins with a number like "0.69" or "2 Ea.") belongs to the NUMBERED item ABOVE it. It is NOT a separate item, and its numbers do NOT belong to the next numbered item below it.

ANTI-SHIFT CHECK: After reading all items, verify that consecutive item prices make sense. If item N has no indented detail line yet its price looks like a quantity×rate expression (e.g. "1.71" when the visible number at the right of item N's name line is actually "7.24"), you have shifted a detail-line number up by one row. Re-read that item from the image.
{ocr_hint}
STEP 3 — Output ONLY this JSON (no prose, no markdown):

{{
  "store_name": "string or null",
  "receipt_date": "string or null — YYYY-MM-DD",
  "subtotal": number or null,
  "tax": number or null,
  "discounts": number,
  "total": number or null,
  "items": [
    {{
      "name": "VERBATIM text from the receipt — copy it character-for-character, all caps, with the EXACT same abbreviations, spacing, and truncation as printed. Do NOT expand abbreviations (e.g. keep 'KS STEAKSTRIP', never write 'KIRKLAND SIGNATURE STEAK STRIP'; keep 'HEB ORG TX RTS', never write 'H-E-B ORGANIC TEXAS ROOTS'). This field is used as a database key, so even small differences create duplicates.",
      "display_name": "human-readable name, expand obvious abbreviations, title case (e.g. 'KS STEAKSTRIP' → 'Kirkland Signature Steak Strips', 'HEB ORG TX RTS' → 'H-E-B Organic Texas Roots'). This is the ONLY field where you should expand/interpret abbreviations.",
      "quantity": number,
      "price": number,
      "line_total": number
    }}
  ]
}}"""

    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=api_key)
        message = await client.messages.create(
            model="claude-sonnet-4-5",   # sonnet for better column alignment on receipts
            max_tokens=4096,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }],
        )
        raw = message.content[0].text.strip()
        # Strip markdown fences if present
        raw = re.sub(r'^```[a-z]*\n?', '', raw)
        raw = re.sub(r'\n?```$', '', raw)
        data = json.loads(raw)
    except Exception as e:
        logger.warning("Claude Vision parse failed: %s — using Tesseract fallback", e)
        return ocr_fallback

    result = ParsedReceipt()
    result.raw_text = ocr_fallback.raw_text  # keep OCR text for display

    result.store_name  = data.get("store_name") or ocr_fallback.store_name
    result.receipt_date = data.get("receipt_date") or ocr_fallback.receipt_date
    result.subtotal    = data.get("subtotal")
    result.tax         = data.get("tax")
    result.discounts   = float(data.get("discounts") or 0)
    result.total       = data.get("total") or ocr_fallback.total

    for item in data.get("items") or []:
        name         = str(item.get("name") or "").strip()
        display_name = str(item.get("display_name") or "").strip()
        price = item.get("price")
        qty   = float(item.get("quantity") or 1)
        line_total = item.get("line_total")

        if not name or price is None or not (0 < float(price) < 1000):
            continue

        price = float(price)
        qty   = max(qty, 1)

        # Reconcile unit price against line_total if provided.
        # If price × qty doesn't match line_total, line_total is authoritative —
        # Claude probably read the line total as the unit price (common mistake on
        # multi-pack and promo-price items).
        if line_total is not None:
            lt = float(line_total)
            if lt > 0:
                computed_total = round(price * qty, 2)
                if abs(computed_total - round(lt, 2)) > 0.02:
                    # Try interpreting line_total / qty as the true unit price
                    corrected = round(lt / qty, 4)
                    logger.debug(
                        "Price mismatch for '%s': %s × %s = %s ≠ line_total %s. "
                        "Correcting unit price to %s",
                        name, price, qty, computed_total, lt, corrected,
                    )
                    price = corrected

        result.raw_items.append({
            "raw_name":   name.upper(),
            "clean_name": display_name or name,   # human-readable if Claude provided it
            "price":      price,
            "quantity":   qty,
        })

    # If Vision returned nothing useful, fall back entirely
    if not result.raw_items and ocr_fallback.raw_items:
        logger.warning("Vision returned no items — using Tesseract items")
        result.raw_items = ocr_fallback.raw_items

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
