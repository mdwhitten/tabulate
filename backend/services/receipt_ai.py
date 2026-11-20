"""
AI-first receipt extraction.

One Claude call reads the receipt image(s) at high resolution and returns
store, date, totals and line items — each item already assigned to one of the
user's categories — as schema-constrained JSON. Totals are then reconciled in
code (items + tax − discounts == total, item count == printed count); on a
mismatch Claude gets one follow-up turn naming the discrepancy.

Tall receipts are split into several vertical segments, cut in the blank gaps
between printed lines, so every segment stays legible within Claude's image
size limits instead of being shrunk to a few pixels per line.

Model and effort are configurable:
    CLAUDE_MODEL   (default claude-haiku-5-5)
    CLAUDE_EFFORT  (default low; one of low/medium/high/xhigh/max)
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import time
from typing import Callable, Optional

import anthropic

from services.ocr_service import ParsedReceipt

logger = logging.getLogger("tabulate.receipt_ai")

DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_EFFORT = "low"

# Segment geometry. 900 × 1250 px ≈ 1.1 MP keeps each segment inside the image
# size every current model accepts without server-side downscaling, while a
# receipt line stays ~30–40 px tall.
TILE_WIDTH = 900
TILE_MAX_HEIGHT = 1250
# Never cut a segment shorter than this fraction of TILE_MAX_HEIGHT when
# searching upward for a blank gap between lines.
_MIN_CUT_FRACTION = 0.7
# Neighbouring segments share this many pixels (about two printed lines at
# TILE_WIDTH). Curled or slanted receipts rarely have a pixel row that is blank
# across the whole width, so a cut can clip a price; the overlap guarantees each
# line appears whole in at least one segment.
TILE_OVERLAP = 80

MAX_OUTPUT_TOKENS = 32000
MAX_CORRECTION_ROUNDS = 1
TOTAL_TOLERANCE = 0.02


def get_model() -> str:
    return os.environ.get("CLAUDE_MODEL", "").strip() or DEFAULT_MODEL


def get_effort() -> str:
    return os.environ.get("CLAUDE_EFFORT", "").strip() or DEFAULT_EFFORT


def _api_key() -> str:
    return os.environ.get("ANTHROPIC_API_KEY", "")


# ── Image segmentation ────────────────────────────────────────────────────────

def _find_cut_rows(gray, max_height: int) -> list[int]:
    """Return y-coordinates at which to cut a tall grayscale image.

    Each cut is placed at the emptiest row band (least dark "ink") in the lower
    part of the allowed window, so cuts land between printed lines.
    """
    import numpy as np

    arr = np.asarray(gray, dtype=np.float32)
    h = arr.shape[0]
    if h <= max_height:
        return []

    # Ink per row: how far each row's darkest pixels sit below the page tone.
    # Using the row's 10th-percentile vs. the global median is robust to a
    # dark table showing at the sides and to uneven lighting.
    page_tone = float(np.median(arr))
    row_dark = np.clip(page_tone - np.percentile(arr, 10, axis=1), 0, None)
    # Smooth so the cut lands in the middle of a gap, not on a glyph's edge.
    kernel = np.ones(7, dtype=np.float32) / 7
    ink = np.convolve(row_dark, kernel, mode="same")

    cuts: list[int] = []
    top = 0
    while h - top > max_height:
        lo = top + int(max_height * _MIN_CUT_FRACTION)
        hi = top + max_height
        window = ink[lo:hi]
        # Prefer the lowest cut among equally empty rows (bigger segments).
        best = lo + int(len(window) - 1 - np.argmin(window[::-1]))
        cuts.append(best)
        top = best
    return cuts


def segment_receipt_image(image_bytes: bytes) -> list[bytes]:
    """Scale a receipt image to TILE_WIDTH and split it into JPEG segments.

    Images are never upscaled. Short receipts come back as a single segment.
    """
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    w, h = img.size
    # Landscape / wide images: cap the long edge instead of the width.
    if w > h:
        scale = min(1.0, max(TILE_WIDTH, TILE_MAX_HEIGHT) / w)
    else:
        scale = min(1.0, TILE_WIDTH / w)
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

    height = img.size[1]
    cuts = _find_cut_rows(img.convert("L"), TILE_MAX_HEIGHT - TILE_OVERLAP)
    bounds = [0, *cuts, height]
    half = TILE_OVERLAP // 2

    segments: list[bytes] = []
    for top, bottom in zip(bounds, bounds[1:]):
        top = max(0, top - half) if top else 0
        bottom = min(height, bottom + half)
        tile = img.crop((0, top, img.size[0], bottom))
        buf = io.BytesIO()
        tile.save(buf, format="JPEG", quality=90, optimize=True)
        segments.append(buf.getvalue())
    return segments


# ── Prompt + schema ───────────────────────────────────────────────────────────

def _nullable(schema: dict) -> dict:
    return {"anyOf": [schema, {"type": "null"}]}


def build_schema(categories: list[str]) -> dict:
    item = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "display_name": {"type": "string"},
            "quantity": {"type": "number"},
            "price": {"type": "number"},
            "line_total": {"type": "number"},
            "category": {"type": "string", "enum": list(categories)},
        },
        "required": ["name", "display_name", "quantity", "price", "line_total", "category"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "store_name": _nullable({"type": "string"}),
            "receipt_date": _nullable({"type": "string"}),
            "subtotal": _nullable({"type": "number"}),
            "tax": _nullable({"type": "number"}),
            "discounts": {"type": "number"},
            "total": _nullable({"type": "number"}),
            "printed_item_count": _nullable({"type": "integer"}),
            "items": {"type": "array", "items": item},
        },
        "required": [
            "store_name", "receipt_date", "subtotal", "tax", "discounts",
            "total", "printed_item_count", "items",
        ],
        "additionalProperties": False,
    }


def build_prompt(n_segments: int, categories: list[str], text_hint: Optional[str]) -> str:
    if n_segments > 1:
        layout = (
            f"The receipt is provided as {n_segments} image segments in top-to-bottom order. "
            "Neighbouring segments overlap by about two printed lines, so a line at the "
            "bottom of one segment is repeated at the top of the next: read them as one "
            "continuous receipt and count each printed line once."
        )
    else:
        layout = "The receipt is provided as one image."

    hint = ""
    if text_hint and text_hint.strip():
        hint = (
            "\n\nThe receipt's embedded PDF text layer is below. Its characters are exact, "
            "so prefer it for spelling and digits; use the image for layout.\n"
            f"<pdf_text>\n{text_hint.strip()}\n</pdf_text>"
        )

    return f"""Extract the data from this photographed retail receipt (usually groceries). {layout}

Items — one entry per purchased product line, in printed order. If the same product is printed on several lines, output each line.
- name: the product text exactly as printed, in capitals, without leading product codes / SKU / PLU numbers and without trailing tax flags (e.g. "FA", "NB", "F", "T"). Keep abbreviations as printed; this is a lookup key.
- display_name: a readable, title-case name with obvious abbreviations expanded.
- line_total: the amount charged for the line (the rightmost price).
- quantity: the unit count when one is printed (e.g. "2 @ 3.00"), otherwise 1. Items sold by weight have quantity 1.
- price: the unit price, so price × quantity = line_total.
- Lines printed under an item that give its weight, unit rate or multi-buy detail (e.g. "1.54 lb x 1.89/lb", "2 Ea. @ 1/3.88") belong to the item above; they are not separate items.
- Discounts, coupons and savings are not items: add their amounts (as positive numbers) to `discounts`.
- category: the best fit from: {", ".join(categories)}. Use "Other" only when nothing fits.

Totals:
- subtotal: the printed subtotal before tax, or null.
- tax: total sales tax charged (the sum of the tax amounts, e.g. a "Taxable @8.25%  1.14" line means 1.14); 0 when the receipt shows no tax.
- total: the final amount charged ("TOTAL", "AMOUNT DUE", "BALANCE DUE"), not amounts tendered or change given.
- printed_item_count: the number of items printed on the receipt (e.g. "76 ITEMS"), or null.
- receipt_date: YYYY-MM-DD, or null. store_name: the store or chain name, or null.

Before answering, check that the line totals add up to the subtotal (total − tax + discounts) and that the item count matches the printed count. If they don't, look again for missed lines, duplicated lines and misread digits.{hint}"""


# ── Reconciliation ────────────────────────────────────────────────────────────

def find_discrepancies(data: dict) -> list[str]:
    """Return human-readable problems with an extraction (empty if consistent)."""
    items = data.get("items") or []
    problems: list[str] = []
    if not items:
        return ["No line items were returned."]

    items_sum = round(sum(float(i.get("line_total") or 0) for i in items), 2)
    total = data.get("total")
    tax = float(data.get("tax") or 0)
    discounts = float(data.get("discounts") or 0)
    if total is None:
        problems.append("No total was returned.")
    else:
        expected = round(float(total) - tax + discounts, 2)
        if abs(items_sum - expected) > TOTAL_TOLERANCE:
            problems.append(
                f"The line totals sum to {items_sum:.2f}, but total {float(total):.2f} − tax "
                f"{tax:.2f} + discounts {discounts:.2f} = {expected:.2f} "
                f"(difference {items_sum - expected:+.2f})."
            )

    printed = data.get("printed_item_count")
    if printed:
        qty_sum = round(sum(float(i.get("quantity") or 1) for i in items))
        if printed not in (len(items), qty_sum):
            problems.append(
                f"The receipt prints {printed} items, but {len(items)} lines were returned."
            )
    return problems


def _to_parsed(data: dict, text_hint: Optional[str]) -> ParsedReceipt:
    result = ParsedReceipt()
    result.raw_text = text_hint or ""
    result.store_name = data.get("store_name") or None
    result.receipt_date = data.get("receipt_date") or None
    result.subtotal = data.get("subtotal")
    result.tax = data.get("tax")
    result.discounts = float(data.get("discounts") or 0)
    result.total = data.get("total")

    for item in data.get("items") or []:
        name = str(item.get("name") or "").strip()
        line_total = item.get("line_total")
        if not name or line_total is None:
            continue
        line_total = float(line_total)
        if not (0 < line_total < 10000):
            continue
        qty = max(float(item.get("quantity") or 1), 1.0)
        price = item.get("price")
        price = float(price) if price is not None else line_total / qty
        # line_total is what was charged; trust it over a mis-multiplied unit price.
        if abs(round(price * qty, 2) - round(line_total, 2)) > TOTAL_TOLERANCE:
            price = round(line_total / qty, 4)
        result.raw_items.append({
            "raw_name": name.upper(),
            "clean_name": str(item.get("display_name") or "").strip() or name.title(),
            "price": price,
            "quantity": qty,
            "category": item.get("category"),
        })
    return result


# ── Claude call ───────────────────────────────────────────────────────────────

class ReceiptExtractionError(Exception):
    pass


ProgressFn = Callable[..., None]


def _notify(on_progress: Optional[ProgressFn], stage: str, **detail) -> None:
    """Call a progress callback; a failing callback must never break extraction."""
    if on_progress is None:
        return
    try:
        on_progress(stage, **detail)
    except Exception:
        logger.debug("Progress callback failed", exc_info=True)


# Each completed item object in the streamed JSON carries exactly one
# "category" key (it is the last required field of an item and appears nowhere
# else in the schema), so counting it tracks items read so far.
_ITEM_MARKER = '"category"'


async def _request(
    client: anthropic.AsyncAnthropic,
    messages: list,
    schema: dict,
    on_progress: Optional[ProgressFn] = None,
):
    async with client.messages.stream(
        model=get_model(),
        max_tokens=MAX_OUTPUT_TOKENS,
        output_config={"effort": get_effort(), "format": {"type": "json_schema", "schema": schema}},
        messages=messages,
    ) as stream:
        if on_progress is not None:
            # Only text deltas (the JSON answer) arrive here; thinking is skipped.
            tail = ""
            items = 0
            async for text in stream.text_stream:
                tail += text
                found = tail.count(_ITEM_MARKER)
                if found:
                    items += found
                    tail = tail[tail.rindex(_ITEM_MARKER) + len(_ITEM_MARKER):]
                    _notify(on_progress, "reading", method="ai", items=items)
                # Keep a short tail so a marker split across deltas is still found.
                tail = tail[-(len(_ITEM_MARKER) - 1):]
        message = await stream.get_final_message()

    if message.stop_reason == "refusal":
        raise ReceiptExtractionError("Claude declined the request")
    if message.stop_reason == "max_tokens":
        raise ReceiptExtractionError("Response hit max_tokens before finishing")
    text = next((b.text for b in message.content if b.type == "text"), None)
    if text is None:
        raise ReceiptExtractionError("Response had no text block")
    return message, json.loads(text)


async def _converse(
    client: anthropic.AsyncAnthropic,
    messages: list,
    schema: dict,
    on_progress: Optional[ProgressFn],
) -> Optional[tuple[dict, list[str]]]:
    """First extraction plus up to MAX_CORRECTION_ROUNDS corrective turns.
    Returns (data, unresolved problems), or None when the first call fails."""
    try:
        message, data = await _request(client, messages, schema, on_progress)
    except Exception as e:
        _log_failure(e)
        return None
    problems = find_discrepancies(data)

    rounds = 0
    while problems and rounds < MAX_CORRECTION_ROUNDS:
        rounds += 1
        logger.info("Receipt extraction discrepancies, asking for a re-check: %s", problems)
        _notify(on_progress, "rechecking", problems=len(problems))
        messages.append({"role": "assistant", "content": message.content})
        messages.append({
            "role": "user",
            "content": (
                "Checking your extraction against the receipt found these problems:\n- "
                + "\n- ".join(problems)
                + "\nLook at the receipt again, line by line, for missed, duplicated or "
                "misread lines and amounts, then return the complete corrected extraction. "
                "If the receipt itself is inconsistent, keep what is printed."
            ),
        })
        try:
            retry_message, retry_data = await _request(client, messages, schema, on_progress)
        except Exception as e:
            # The first extraction is still usable; keep it rather than
            # falling back to Tesseract because the re-check failed.
            _log_failure(e, during="re-check")
            break
        retry_problems = find_discrepancies(retry_data)
        if len(retry_problems) <= len(problems):
            message, data, problems = retry_message, retry_data, retry_problems

    return data, problems


async def extract_receipt_with_ai(
    image_bytes: bytes,
    categories: list[str],
    text_hint: Optional[str] = None,
    *,
    on_progress: Optional[ProgressFn] = None,
) -> Optional[ParsedReceipt]:
    """Extract a receipt with Claude. Returns None when no API key is set or
    the call fails, so the caller can fall back to Tesseract.

    `on_progress(stage, **detail)` is called with ("reading", method="ai",
    items=N) as items stream in, and ("rechecking", problems=N) before the
    corrective follow-up. Callback errors are logged and ignored.
    """
    api_key = _api_key()
    if not api_key:
        return None

    started = time.monotonic()
    try:
        segments = await asyncio.to_thread(segment_receipt_image, image_bytes)
    except Exception as e:
        logger.warning("Could not prepare receipt image for Claude: %s", e)
        return None

    content: list[dict] = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": base64.standard_b64encode(seg).decode(),
            },
        }
        for seg in segments
    ]
    content.append({"type": "text", "text": build_prompt(len(segments), categories, text_hint)})
    messages: list = [{"role": "user", "content": content}]
    schema = build_schema(categories)

    client = anthropic.AsyncAnthropic(api_key=api_key)
    try:
        result = await _converse(client, messages, schema, on_progress)
    finally:
        await client.close()
    if result is None:
        return None
    data, problems = result

    parsed = _to_parsed(data, text_hint)
    parsed.unresolved_problems = problems
    logger.info(
        "Claude (%s, effort %s) read %d items from %d segment(s) in %.1fs%s",
        get_model(), get_effort(), len(parsed.raw_items), len(segments),
        time.monotonic() - started,
        f"; unresolved: {problems}" if problems else "",
    )
    if not parsed.raw_items:
        return None
    return parsed


def _log_failure(e: Exception, during: str = "extraction") -> None:
    if isinstance(e, anthropic.APIStatusError):
        logger.warning("Claude receipt %s failed (HTTP %s): %s", during, e.status_code, e.message)
    elif isinstance(e, anthropic.APIConnectionError):
        logger.warning("Claude receipt %s could not connect: %s", during, e)
    elif isinstance(e, (ReceiptExtractionError, json.JSONDecodeError)):
        logger.warning("Claude receipt %s unusable: %s", during, e)
    else:
        logger.exception("Claude receipt %s failed unexpectedly", during)
