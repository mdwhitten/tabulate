"""
Receipts Router

POST /api/receipts/upload     — upload image, extract + categorize (JSON result)
POST /api/receipts/upload-stream — same, streaming NDJSON progress events
GET  /api/receipts            — list all receipts (summary)
GET  /api/receipts/{id}       — get receipt with line items
POST /api/receipts/{id}/save  — finalize receipt, apply corrections
DELETE /api/receipts/{id}     — remove a receipt
"""
import asyncio
import json
import logging
import os
import uuid
import shutil
from datetime import datetime
from typing import Callable, Optional

import aiosqlite
from fastapi import APIRouter, File, UploadFile, Depends, HTTPException, Form, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from db.database import get_db
from models.schemas import ReceiptSummary, Receipt, ProcessingResult, LineItem
from services.ocr_service import extract_text_from_image, parse_receipt_text, verify_total
from services.receipt_ai import extract_receipt_with_ai
from services.categorize_service import categorize_items, get_categories, apply_manual_correction, persist_approved_mappings
from services.image_service import generate_thumbnail, detect_receipt_edges, downscale_for_storage

logger = logging.getLogger("tabulate.receipts")
router = APIRouter()

IMAGE_DIR = os.environ.get("IMAGE_DIR", "/data/images")
os.makedirs(IMAGE_DIR, exist_ok=True)


# ── Diagnostics ───────────────────────────────────────────────────────────────

@router.get("/diagnose")
async def diagnose():
    """Check that all dependencies (Tesseract, data dir, Anthropic key) are working."""
    import subprocess, os as _os
    results = {}

    # Tesseract
    try:
        r = subprocess.run(["tesseract", "--version"], capture_output=True, text=True, timeout=5)
        results["tesseract"] = {"ok": r.returncode == 0, "version": r.stdout.split("\n")[0]}
    except FileNotFoundError:
        results["tesseract"] = {"ok": False, "error": "tesseract binary not found in PATH"}
    except Exception as e:
        results["tesseract"] = {"ok": False, "error": str(e)}

    # pytesseract import
    try:
        import pytesseract
        results["pytesseract"] = {"ok": True}
    except ImportError as e:
        results["pytesseract"] = {"ok": False, "error": str(e)}

    # Pillow
    try:
        from PIL import Image
        results["pillow"] = {"ok": True}
    except ImportError as e:
        results["pillow"] = {"ok": False, "error": str(e)}

    # Data directory
    results["data_dir"] = {
        "ok": _os.path.isdir("/data"),
        "writable": _os.access("/data", _os.W_OK),
        "path": IMAGE_DIR,
    }

    # Anthropic key (never expose key material — only report presence)
    key = _os.environ.get("ANTHROPIC_API_KEY", "")
    results["anthropic_key"] = {
        "ok": bool(key and key.startswith("sk-")),
        "set": bool(key),
    }

    all_ok = all(v.get("ok") for v in results.values())
    return {"all_ok": all_ok, "checks": results}


# ── Upload & Process ──────────────────────────────────────────────────────────

_ALLOWED_CONTENT_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/tiff",
    "image/heic", "image/heif", "application/pdf",
}
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024   # matches nginx client_max_body_size

ProgressFn = Callable[..., None]

# Strong references to in-flight /upload-stream workers: the event loop only
# keeps weak references to tasks, so an unreferenced task can be collected.
_stream_tasks: set[asyncio.Task] = set()


def _no_progress(stage: str, **detail) -> None:
    pass


async def _read_upload(
    file: UploadFile, original: Optional[UploadFile]
) -> tuple[bytes, Optional[str], Optional[bytes]]:
    """Validate and read the upload (and optional pristine original) into memory."""
    if file.content_type and file.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=422, detail=f"Unsupported file type: {file.content_type}")
    contents = await file.read(_MAX_UPLOAD_BYTES + 1)
    if len(contents) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB)")
    orig_bytes = None
    if original is not None:
        data = await original.read(_MAX_UPLOAD_BYTES + 1)
        if 0 < len(data) <= _MAX_UPLOAD_BYTES:
            orig_bytes = data
    return contents, file.content_type, orig_bytes


def _prepare_image(
    contents: bytes, content_type: Optional[str], crop_corners: Optional[str]
) -> tuple[bytes, Optional[str]]:
    """CPU-bound image preparation (run in a worker thread).

    Renders PDFs (keeping any embedded text), normalises EXIF orientation,
    re-encodes to JPEG and applies the user's crop. Returns the full-resolution
    JPEG used for processing, plus the PDF's embedded text when present.
    """
    from PIL import Image as _PILImage, ImageOps as _ImageOps
    import io as _io

    is_pdf = content_type == "application/pdf" or contents[:5] == b"%PDF-"
    pdf_text: Optional[str] = None
    if is_pdf:
        try:
            from pdf2image import convert_from_bytes
            from pypdf import PdfReader

            reader = PdfReader(_io.BytesIO(contents))
            if len(reader.pages) == 0:
                raise HTTPException(status_code=422, detail="PDF has no pages")

            raw_text = "\n".join((page.extract_text() or "") for page in reader.pages).strip()
            if raw_text:
                pdf_text = raw_text
                logger.info("Extracted %d chars of embedded text from %d-page PDF",
                            len(raw_text), len(reader.pages))

            page_images = convert_from_bytes(contents, dpi=300, fmt="jpeg")
            if len(page_images) == 1:
                combined = page_images[0]
            else:
                total_width = max(img.width for img in page_images)
                total_height = sum(img.height for img in page_images)
                combined = _PILImage.new("RGB", (total_width, total_height), (255, 255, 255))
                y_offset = 0
                for img in page_images:
                    combined.paste(img, (0, y_offset))
                    y_offset += img.height

            _buf = _io.BytesIO()
            combined.save(_buf, format="JPEG", quality=92, optimize=True)
            contents = _buf.getvalue()
            logger.info("Rendered %d-page PDF to JPEG (%d bytes)", len(page_images), len(contents))
        except HTTPException:
            raise
        except ImportError:
            raise HTTPException(status_code=500, detail="PDF support not available (pdf2image/pypdf not installed)")
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Failed to process PDF: {e}")
    else:
        # Normalise EXIF orientation (phone photos are often rotated in metadata)
        # and re-encode as JPEG so downstream tools see correct pixel orientation.
        try:
            _img = _PILImage.open(_io.BytesIO(contents))
            _img = _ImageOps.exif_transpose(_img)
            if _img.mode not in ("RGB", "L"):
                _img = _img.convert("RGB")
            _buf = _io.BytesIO()
            _img.save(_buf, format="JPEG", quality=92, optimize=True)
            contents = _buf.getvalue()
        except Exception as e:
            logger.warning("EXIF normalise failed, using raw bytes: %s", e)

    # Apply user crop if provided (corners as fractions of EXIF-corrected image dimensions)
    if crop_corners:
        try:
            corners = json.loads(crop_corners)
            if len(corners) == 4:
                img = _PILImage.open(_io.BytesIO(contents))
                w, h = img.size
                xs = [c[0] * w for c in corners]
                ys = [c[1] * h for c in corners]
                x_min = max(0, int(min(xs)))
                x_max = min(w, int(max(xs)))
                y_min = max(0, int(min(ys)))
                y_max = min(h, int(max(ys)))
                if x_max > x_min and y_max > y_min:
                    img = img.crop((x_min, y_min, x_max, y_max))
                    buf = _io.BytesIO()
                    img.save(buf, format="JPEG", quality=92, optimize=True)
                    contents = buf.getvalue()
                    logger.info("Cropped to (%d,%d)–(%d,%d)", x_min, y_min, x_max, y_max)
        except Exception as e:
            logger.warning("Crop failed, using full image: %s", e)

    return contents, pdf_text


def _store_images(contents: bytes, orig_bytes: Optional[bytes]) -> tuple[str, Optional[str], Optional[str]]:
    """Write reduced-size copies of the receipt (and pristine original) to disk.

    Processing already happened on the full-resolution bytes; storage keeps a
    width-capped JPEG to avoid bloating the data directory. Runs in a worker thread.
    Returns (image_path, thumbnail_path, original_path).
    """
    from PIL import Image as _PILImage, ImageOps as _ImageOps
    import io as _io

    image_path = os.path.join(IMAGE_DIR, f"{uuid.uuid4()}.jpg")
    stored = downscale_for_storage(contents)
    with open(image_path, "wb") as f:
        f.write(stored)

    thumb_path = os.path.join(IMAGE_DIR, f"thumb_{uuid.uuid4()}.jpg")
    thumbnail_path = generate_thumbnail(stored, thumb_path)

    # If the client perspective-corrected the receipt, it also sends the pristine
    # pre-crop image so the crop can be redone from the original later. Store it
    # separately; when absent, image_path *is* the original (original_path stays null).
    original_path = None
    if orig_bytes:
        try:
            _oimg = _PILImage.open(_io.BytesIO(orig_bytes))
            _oimg = _ImageOps.exif_transpose(_oimg)
            if _oimg.mode not in ("RGB", "L"):
                _oimg = _oimg.convert("RGB")
            _obuf = _io.BytesIO()
            _oimg.save(_obuf, format="JPEG", quality=92, optimize=True)
            original_path = os.path.join(IMAGE_DIR, f"{uuid.uuid4()}.jpg")
            with open(original_path, "wb") as f:
                f.write(downscale_for_storage(_obuf.getvalue()))
        except Exception as e:
            logger.warning("Failed to store original image, continuing without it: %s", e)
            original_path = None

    return image_path, thumbnail_path, original_path


async def _process_upload(
    *,
    contents: bytes,
    content_type: Optional[str],
    orig_bytes: Optional[bytes],
    store_name_hint: Optional[str],
    crop_corners: Optional[str],
    db: aiosqlite.Connection,
    progress: ProgressFn = _no_progress,
) -> ProcessingResult:
    """Run the full upload pipeline. `progress(stage, **detail)` is called as
    each real stage starts: preparing → reading → checking → categorizing → saving."""
    progress("preparing")
    contents, pdf_text = await asyncio.to_thread(_prepare_image, contents, content_type, crop_corners)

    # Extraction — Claude reads the full-resolution image (and assigns
    # categories); Tesseract + regex parsing is the fallback.
    categories = await get_categories(db)
    if os.environ.get("ANTHROPIC_API_KEY"):
        progress("reading", method="ai")
    parsed = await extract_receipt_with_ai(
        contents, categories, text_hint=pdf_text,
        on_progress=progress,
    )
    if parsed is not None:
        # ProcessingResult.ocr_raw is a required string; images have no text layer.
        ocr_text = pdf_text or ""
    else:
        progress("reading", method="ocr")
        if pdf_text:
            ocr_text = pdf_text
            logger.info("Using embedded PDF text, skipping Tesseract OCR")
        else:
            try:
                ocr_text = await asyncio.to_thread(extract_text_from_image, contents)
            except Exception as e:
                err_type = type(e).__name__
                err_msg = str(e)
                if 'tesseract' in err_msg.lower() or 'Tesseract' in err_type:
                    raise HTTPException(status_code=500,
                        detail='Tesseract OCR not found in container. Run: docker compose build --no-cache')
                raise HTTPException(status_code=422, detail=f'OCR failed ({err_type}): {err_msg}')
        parsed = parse_receipt_text(ocr_text)

    store = store_name_hint or parsed.store_name or "Unknown Store"

    progress("checking")
    verified, verify_msg = verify_total(parsed)

    image_path, thumbnail_path, original_path = await asyncio.to_thread(
        _store_images, contents, orig_bytes
    )

    # Persist receipt (status = 'pending' until user saves)
    cursor = await db.execute(
        """INSERT INTO receipts
           (store_name, receipt_date, image_path, original_path, thumbnail_path, ocr_raw,
            subtotal, tax, discounts, total, total_verified, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')""",
        (store, parsed.receipt_date, image_path, original_path, thumbnail_path, ocr_text,
         parsed.subtotal, parsed.tax, parsed.discounts, parsed.total,
         1 if verified else 0),
    )
    receipt_id = cursor.lastrowid
    await db.commit()

    # Categorize: learned mappings first, then the category Claude assigned
    # while reading, then one batched Claude call for anything left.
    progress("categorizing")
    raw_items = [
        {"id": i, "raw_name": item["raw_name"], "clean_name": item["clean_name"],
         "price": item["price"], "quantity": item["quantity"],
         "category": item.get("category")}
        for i, item in enumerate(parsed.raw_items)
    ]
    categorized, categorization_failed = await categorize_items(raw_items, store, db)

    progress("saving")
    line_items = []
    for item in categorized:
        cur2 = await db.execute(
            """INSERT INTO line_items
               (receipt_id, raw_name, clean_name, price, quantity,
                category, category_source, ai_confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (receipt_id, item["raw_name"], item.get("clean_name"), item["price"], item.get("quantity", 1),
             item["category"], item["category_source"], item.get("ai_confidence")),
        )
        line_items.append(LineItem(
            id=cur2.lastrowid,
            receipt_id=receipt_id,
            raw_name=item["raw_name"],
            clean_name=item.get("clean_name"),
            price=item["price"],
            quantity=item.get("quantity", 1),
            category=item["category"],
            category_source=item["category_source"],
            ai_confidence=item.get("ai_confidence"),
            corrected=False,
        ))
    await db.commit()

    return ProcessingResult(
        receipt_id=receipt_id,
        store_name=store,
        receipt_date=parsed.receipt_date,
        ocr_raw=ocr_text,
        subtotal=parsed.subtotal,
        tax=parsed.tax,
        discounts=parsed.discounts,
        total=parsed.total,
        total_verified=verified,
        verification_message=verify_msg,
        thumbnail_path=thumbnail_path,
        categorization_failed=categorization_failed,
        items=line_items,
    )


@router.post("/upload", response_model=ProcessingResult)
async def upload_receipt(
    file: UploadFile = File(...),
    store_name_hint: Optional[str] = Form(None),
    crop_corners: Optional[str] = Form(None),   # JSON [[x,y],[x,y],[x,y],[x,y]] as 0–1 fractions
    original: Optional[UploadFile] = File(None),  # pristine pre-crop image, when the client already perspective-corrected `file`
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Accept an image upload, extract the receipt (Claude, with Tesseract as the
    fallback), verify the total and categorize items.
    Returns a ProcessingResult for the review screen; the receipt is stored as 'pending'.
    If crop_corners is provided (4 [x,y] fraction pairs), the image is cropped first.
    When the client has already perspective-corrected the receipt, it sends the
    corrected image as `file` and the raw image as `original` so the crop can be
    redone later from the pristine source.
    """
    contents, content_type, orig_bytes = await _read_upload(file, original)
    return await _process_upload(
        contents=contents, content_type=content_type, orig_bytes=orig_bytes,
        store_name_hint=store_name_hint, crop_corners=crop_corners, db=db,
    )


@router.post("/upload-stream")
async def upload_receipt_stream(
    request: Request,
    file: UploadFile = File(...),
    store_name_hint: Optional[str] = Form(None),
    crop_corners: Optional[str] = Form(None),
    original: Optional[UploadFile] = File(None),
):
    """
    Same as /upload, but streams newline-delimited JSON so the UI can show real
    progress:
        {"type": "progress", "stage": "reading", "items": 12}
        ...
        {"type": "result", "data": <ProcessingResult>}
    or, on failure, {"type": "error", "status": 422, "detail": "..."}.
    """
    contents, content_type, orig_bytes = await _read_upload(file, original)
    # The response body outlives the endpoint, so open the DB connection inside
    # the stream rather than through Depends (honouring test overrides).
    db_factory = request.app.dependency_overrides.get(get_db, get_db)
    queue: asyncio.Queue = asyncio.Queue()

    def progress(stage: str, **detail) -> None:
        queue.put_nowait({"type": "progress", "stage": stage, **detail})

    async def run() -> None:
        db_gen = db_factory()
        try:
            db = await db_gen.__anext__()
            result = await _process_upload(
                contents=contents, content_type=content_type, orig_bytes=orig_bytes,
                store_name_hint=store_name_hint, crop_corners=crop_corners, db=db,
                progress=progress,
            )
            queue.put_nowait({"type": "result", "data": result.model_dump(mode="json")})
        except HTTPException as e:
            queue.put_nowait({"type": "error", "status": e.status_code, "detail": e.detail})
        except Exception:
            logger.exception("Receipt processing failed")
            queue.put_nowait({"type": "error", "status": 500, "detail": "Receipt processing failed"})
        finally:
            try:
                await db_gen.aclose()
            finally:
                queue.put_nowait(None)

    async def events():
        task = asyncio.create_task(run())
        _stream_tasks.add(task)
        task.add_done_callback(_stream_tasks.discard)
        try:
            while (event := await queue.get()) is not None:
                yield json.dumps(event) + "\n"
        finally:
            # Client went away (or the response was torn down): stop the work.
            # run()'s own finally closes the DB connection.
            if not task.done():
                task.cancel()

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Duplicate Detection ───────────────────────────────────────────────────────

class DuplicateMatch(BaseModel):
    id: int
    store_name: str
    receipt_date: Optional[str]
    total: Optional[float]
    status: str

@router.get("/check-duplicates", response_model=list[DuplicateMatch])
async def check_duplicates(
    total: Optional[float] = None,
    receipt_date: Optional[str] = None,
    exclude_id: Optional[int] = None,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Check for existing receipts that match the given total and date.
    Returns matching receipts (excluding exclude_id) so the frontend can warn
    the user before saving a potential duplicate.
    """
    if total is None or receipt_date is None:
        return []

    query = """
        SELECT id, store_name, receipt_date, total, status
        FROM receipts
        WHERE receipt_date = ?
          AND total IS NOT NULL
          AND ABS(total - ?) < 0.01
    """
    params: list = [receipt_date, total]

    if exclude_id is not None:
        query += " AND id != ?"
        params.append(exclude_id)

    async with db.execute(query, params) as cur:
        rows = await cur.fetchall()

    return [
        DuplicateMatch(
            id=row["id"],
            store_name=row["store_name"] or "Unknown Store",
            receipt_date=row["receipt_date"],
            total=row["total"],
            status=row["status"] or "pending",
        )
        for row in rows
    ]


# ── Save (finalize after review) ──────────────────────────────────────────────

class NewLineItem(BaseModel):
    name: str
    price: float
    category: str = "Other"

class SaveReceiptBody(BaseModel):
    corrections: dict = {}            # {str(item_id): new_category}
    price_corrections: dict = {}      # {str(item_id): new_price_float}
    name_corrections: dict = {}       # {str(item_id): new_name}
    manual_total: Optional[float] = None  # user-entered total when OCR missed it
    receipt_date: Optional[str] = None    # user-confirmed or manually entered date (YYYY-MM-DD)
    store_name: Optional[str] = None      # user-edited store name
    new_items: list[NewLineItem] = []     # items added by user
    deleted_item_ids: list[int] = []      # item IDs to remove
    approve: bool = False                 # True → set status='verified'; False → keep current status


@router.post("/{receipt_id}/save")
async def save_receipt(
    receipt_id: int,
    body: SaveReceiptBody,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Apply corrections, optionally override the total.
    If approve=True, mark receipt as verified (locked). Otherwise keep current status (draft save).
    """
    # Normalize empty strings to None so COALESCE works correctly
    if body.receipt_date is not None and not body.receipt_date.strip():
        body.receipt_date = None
    if body.store_name is not None and not body.store_name.strip():
        body.store_name = None

    # Validate receipt_date is ISO format (YYYY-MM-DD) when provided
    if body.receipt_date is not None:
        try:
            datetime.strptime(body.receipt_date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid date format: '{body.receipt_date}'. Expected YYYY-MM-DD.",
            )

    # Validate manual_total is a reasonable positive number
    if body.manual_total is not None and body.manual_total < 0:
        raise HTTPException(status_code=422, detail="Manual total cannot be negative.")

    async with db.execute("SELECT id, receipt_date FROM receipts WHERE id = ?", (receipt_id,)) as cur:
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Receipt not found")

    # On approve, ensure a date exists (either from body or already in DB)
    if body.approve:
        effective_date = body.receipt_date or row["receipt_date"]
        if not effective_date:
            raise HTTPException(
                status_code=422,
                detail="Cannot approve a receipt without a date. Please set a receipt date.",
            )

    # Validate new_items: validate categories exist and are enabled
    if body.new_items:
        async with db.execute("SELECT name FROM categories WHERE is_disabled = 0") as cur:
            valid_cats = {r["name"] for r in await cur.fetchall()}
        for new_item in body.new_items:
            cat = new_item.category or "Other"
            if cat not in valid_cats:
                raise HTTPException(
                    status_code=422,
                    detail=f"Invalid category '{cat}' for item '{new_item.name}'.",
                )

    # Delete items the user removed
    for item_id in body.deleted_item_ids:
        await db.execute("DELETE FROM line_items WHERE id = ? AND receipt_id = ?", (item_id, receipt_id))

    # Insert new items added by user
    for new_item in body.new_items:
        price_val = round(float(new_item.price), 2)
        name = new_item.name.strip() or "Item"
        category = new_item.category or "Other"
        await db.execute(
            """INSERT INTO line_items (receipt_id, raw_name, clean_name, price, quantity, category, category_source, corrected)
               VALUES (?, ?, ?, ?, 1, ?, 'manual', 1)""",
            (receipt_id, name, name, price_val, category),
        )

    # Apply name corrections — only update clean_name (display); raw_name is the
    # immutable OCR text used as the mapping key and must never be overwritten.
    for item_id_str, new_name in body.name_corrections.items():
        name = new_name.strip()
        if name:
            await db.execute(
                "UPDATE line_items SET clean_name = ? WHERE id = ? AND receipt_id = ?",
                (name, int(item_id_str), receipt_id),
            )

    for item_id_str, new_category in body.corrections.items():
        await apply_manual_correction(db, int(item_id_str), new_category)

    # Persist all learned mappings only when the user approves (not on draft save).
    # This prevents orphaned mappings when a receipt is later deleted.
    if body.approve:
        await persist_approved_mappings(db, receipt_id)

    for item_id_str, new_price in body.price_corrections.items():
        try:
            price_val = round(float(new_price), 2)
            if price_val > 0:
                await db.execute(
                    "UPDATE line_items SET price = ? WHERE id = ? AND receipt_id = ?",
                    (price_val, int(item_id_str), receipt_id),
                )
        except (ValueError, TypeError):
            pass

    new_status = "verified" if body.approve else None

    # If the user manually entered the total, store it and update
    if body.manual_total is not None:
        await db.execute(
            """UPDATE receipts
               SET status = COALESCE(?, status),
                   total = ?,
                   total_verified = 1,
                   receipt_date = COALESCE(?, receipt_date),
                   store_name = COALESCE(?, store_name)
               WHERE id = ?""",
            (new_status, round(body.manual_total, 2), body.receipt_date, body.store_name, receipt_id),
        )
    else:
        await db.execute(
            """UPDATE receipts
               SET status = COALESCE(?, status),
                   receipt_date = COALESCE(?, receipt_date),
                   store_name = COALESCE(?, store_name)
               WHERE id = ?""",
            (new_status, body.receipt_date, body.store_name, receipt_id),
        )
    await db.commit()

    # Invalidate monthly summary cache for this receipt's month
    async with db.execute(
        "SELECT receipt_date, scanned_at FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()
    date_str = row["receipt_date"] or row["scanned_at"]
    try:
        dt = datetime.fromisoformat(date_str[:10])
        await db.execute(
            "DELETE FROM monthly_summary WHERE year = ? AND month = ?",
            (dt.year, dt.month)
        )
        await db.commit()
    except Exception:
        pass

    # Best-effort YNAB sync whenever the receipt is verified. This covers both
    # approval and later edits saved on an already-verified receipt, so edits stay
    # in sync without a manual re-sync. Opt-in and non-blocking — any error is
    # swallowed (recorded on the receipt's ynab_sync_status, retryable from the UI).
    async with db.execute("SELECT status FROM receipts WHERE id = ?", (receipt_id,)) as cur:
        status_row = await cur.fetchone()
    if status_row and status_row["status"] == "verified":
        try:
            from services import ynab_service
            await ynab_service.sync_receipt(db, receipt_id)
        except Exception as e:
            logger.warning("YNAB sync failed for receipt %s: %s", receipt_id, e)

    return {"status": "ok", "receipt_id": receipt_id}


# ── Recategorize (retry after failure) ────────────────────────────────────────

@router.post("/{receipt_id}/recategorize")
async def recategorize_receipt(
    receipt_id: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Re-run AI categorization on a receipt's line items.
    Called when the initial categorization failed and the user clicks Retry.
    Only items currently categorized as 'Other' with category_source='ai' are
    sent to Claude — learned and manual categories are left untouched.
    """
    async with db.execute("SELECT store_name FROM receipts WHERE id = ?", (receipt_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")
    store_name = row["store_name"]

    # Fetch line items that need recategorization (AI-assigned "Other" with low confidence)
    async with db.execute(
        """SELECT id, raw_name, clean_name, price, quantity
           FROM line_items
           WHERE receipt_id = ? AND category = 'Other' AND category_source = 'ai'
           ORDER BY id""",
        (receipt_id,),
    ) as cur:
        items_rows = await cur.fetchall()

    if not items_rows:
        return {"status": "ok", "categorization_failed": False, "updated": 0}

    raw_items = [
        {"id": r["id"], "raw_name": r["raw_name"], "clean_name": r["clean_name"],
         "price": r["price"], "quantity": r["quantity"]}
        for r in items_rows
    ]

    categorized, failed = await categorize_items(raw_items, store_name, db)

    if failed:
        return {"status": "failed", "categorization_failed": True, "updated": 0}

    # Update line items with new categories
    updated = 0
    for item in categorized:
        if item["category"] != "Other" or item.get("ai_confidence", 0) > 0:
            await db.execute(
                """UPDATE line_items
                   SET category = ?, category_source = ?, ai_confidence = ?
                   WHERE id = ?""",
                (item["category"], item["category_source"], item.get("ai_confidence"), item["id"]),
            )
            updated += 1
    await db.commit()

    return {"status": "ok", "categorization_failed": False, "updated": updated}


# ── List Receipts ─────────────────────────────────────────────────────────────

@router.get("", response_model=list[ReceiptSummary])
async def list_receipts(
    limit: int = 50,
    offset: int = 0,
    db: aiosqlite.Connection = Depends(get_db),
):
    try:
        async with db.execute(
            """
            SELECT r.id, r.store_name, r.receipt_date, r.scanned_at,
                   r.total, r.total_verified, r.status, r.ynab_sync_status,
                   COUNT(li.id) as item_count
            FROM receipts r
            LEFT JOIN line_items li ON li.receipt_id = r.id
            GROUP BY r.id
            ORDER BY COALESCE(r.receipt_date, r.scanned_at) DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ) as cur:
            rows = await cur.fetchall()
    except Exception:
        logger.exception("DB query failed in list_receipts")
        raise

    results = []
    for row in rows:
        try:
            results.append(ReceiptSummary(
                id=row["id"],
                store_name=row["store_name"] or "Unknown Store",
                receipt_date=row["receipt_date"],
                scanned_at=row["scanned_at"] or "",
                total=row["total"],
                item_count=row["item_count"],
                total_verified=bool(row["total_verified"]),
                status=row["status"] or "pending",
                ynab_sync_status=row["ynab_sync_status"] if "ynab_sync_status" in row.keys() else None,
            ))
        except Exception:
            logger.exception("Failed to serialize receipt id=%s, raw=%s",
                             row["id"], dict(row))
            raise

    logger.debug("list_receipts returning %d receipts", len(results))
    return results


# ── Get Single Receipt ────────────────────────────────────────────────────────

@router.get("/{receipt_id}", response_model=Receipt)
async def get_receipt(
    receipt_id: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    async with db.execute(
        "SELECT * FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")

    async with db.execute(
        "SELECT * FROM line_items WHERE receipt_id = ? ORDER BY id", (receipt_id,)
    ) as cur:
        items = await cur.fetchall()

    return Receipt(
        id=row["id"],
        store_name=row["store_name"],
        receipt_date=row["receipt_date"],
        scanned_at=row["scanned_at"],
        ocr_raw=row["ocr_raw"],
        image_path=row["image_path"],
        thumbnail_path=row["thumbnail_path"] if "thumbnail_path" in row.keys() else None,
        subtotal=row["subtotal"],
        tax=row["tax"],
        discounts=row["discounts"],
        total=row["total"],
        total_verified=bool(row["total_verified"]),
        status=row["status"],
        ynab_sync_status=row["ynab_sync_status"] if "ynab_sync_status" in row.keys() else None,
        ynab_transaction_id=row["ynab_transaction_id"] if "ynab_transaction_id" in row.keys() else None,
        items=[
            LineItem(
                id=i["id"], receipt_id=i["receipt_id"],
                raw_name=i["raw_name"], clean_name=i["clean_name"],
                price=i["price"], quantity=i["quantity"],
                category=i["category"], category_source=i["category_source"],
                ai_confidence=i["ai_confidence"], corrected=bool(i["corrected"])
            ) for i in items
        ],
    )


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{receipt_id}")
async def delete_receipt(
    receipt_id: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    async with db.execute(
        "SELECT image_path, original_path, thumbnail_path FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")

    # Remove image files (full + original + thumbnail)
    for path_key in ("image_path", "original_path", "thumbnail_path"):
        try:
            p = row[path_key]
            if p and os.path.exists(p):
                os.remove(p)
        except Exception:
            pass

    await db.execute("DELETE FROM line_items WHERE receipt_id = ?", (receipt_id,))
    await db.execute("DELETE FROM receipts WHERE id = ?", (receipt_id,))
    await db.commit()
    return {"status": "deleted"}


# ── Image Serving ─────────────────────────────────────────────────────────────

_ALLOWED_IMAGE_FIELDS = frozenset({"image_path", "original_path", "thumbnail_path"})

async def _get_image_path(receipt_id: int, db: aiosqlite.Connection, field: str) -> str:
    if field not in _ALLOWED_IMAGE_FIELDS:
        raise ValueError(f"Invalid image field: {field!r}")
    async with db.execute(
        f"SELECT {field} FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")
    path = row[field]
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image file not found")
    # Ensure the resolved path is within IMAGE_DIR to prevent path traversal
    real_path = os.path.realpath(path)
    real_image_dir = os.path.realpath(IMAGE_DIR)
    if not real_path.startswith(real_image_dir + os.sep):
        raise HTTPException(status_code=403, detail="Access denied")
    return path


@router.get("/{receipt_id}/image")
async def get_receipt_image(
    receipt_id: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Serve the original receipt image file."""
    path = await _get_image_path(receipt_id, db, "image_path")
    return FileResponse(path, media_type="image/jpeg", headers={
        "Cache-Control": "public, max-age=86400",
    })


@router.get("/{receipt_id}/original")
async def get_receipt_original(
    receipt_id: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Serve the pristine pre-crop image (falls back to image_path when there is no separate original)."""
    async with db.execute(
        "SELECT image_path, original_path FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")

    path = row["original_path"] or row["image_path"]
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image file not found")
    real_path = os.path.realpath(path)
    real_image_dir = os.path.realpath(IMAGE_DIR)
    if not real_path.startswith(real_image_dir + os.sep):
        raise HTTPException(status_code=403, detail="Access denied")

    return FileResponse(path, media_type="image/jpeg", headers={
        "Cache-Control": "public, max-age=86400",
    })


@router.get("/{receipt_id}/thumbnail")
async def get_receipt_thumbnail(
    receipt_id: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Serve the compressed receipt thumbnail (falls back to original if unavailable)."""
    async with db.execute(
        "SELECT image_path, thumbnail_path FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")

    # Prefer thumbnail; fall back to full image
    path = row["thumbnail_path"] or row["image_path"]
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image file not found")
    # Ensure the resolved path is within IMAGE_DIR to prevent path traversal
    real_path = os.path.realpath(path)
    real_image_dir = os.path.realpath(IMAGE_DIR)
    if not real_path.startswith(real_image_dir + os.sep):
        raise HTTPException(status_code=403, detail="Access denied")

    return FileResponse(path, media_type="image/jpeg", headers={
        "Cache-Control": "public, max-age=86400",
    })


# ── Edge Detection ────────────────────────────────────────────────────────────

@router.post("/detect-edges-raw")
async def detect_edges_raw(file: UploadFile = File(...)):
    """
    Run receipt edge detection on a directly uploaded image (no DB save).
    Used by the crop modal before upload to auto-detect receipt corners.
    Returns four corner points as fractions (0–1), ordered TL→TR→BR→BL.
    """
    contents = await file.read()
    corners = await asyncio.to_thread(detect_receipt_edges, contents)
    if corners is None:
        corners = [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]]
    return {"corners": corners}


@router.get("/{receipt_id}/detect-edges")
async def receipt_detect_edges(
    receipt_id: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Run receipt edge detection on the stored image.
    Returns four corner points as fractions (0–1) of image dimensions,
    ordered TL → TR → BR → BL.
    """
    path = await _get_image_path(receipt_id, db, "image_path")

    def _detect() -> Optional[list]:
        with open(path, "rb") as f:
            return detect_receipt_edges(f.read())

    corners = await asyncio.to_thread(_detect)
    if corners is None:
        # Return full-image corners as fallback
        corners = [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]]

    return {"corners": corners}


def _replace_image_files(
    contents: bytes, image_path: str, original_path: Optional[str], old_thumb: Optional[str]
) -> tuple[Optional[str], Optional[str]]:
    """Blocking part of replace-image (run in a worker thread).

    Normalises the new image, preserves the current image as the original on
    the first re-crop, overwrites image_path with a width-capped copy and
    regenerates the thumbnail. Returns (original_path, thumbnail_path).
    """
    from PIL import Image as _PILImage, ImageOps as _ImageOps
    import io as _io

    img = _PILImage.open(_io.BytesIO(contents))
    img = _ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    buf = _io.BytesIO()
    img.save(buf, format="JPEG", quality=92, optimize=True)
    new_bytes = downscale_for_storage(buf.getvalue())

    # Preserve the pristine original before the first destructive re-crop.
    if not original_path and os.path.exists(image_path):
        original_path = os.path.join(IMAGE_DIR, f"{uuid.uuid4()}.jpg")
        shutil.copyfile(image_path, original_path)

    # Overwrite the displayed image in place (URL stays stable; client cache-busts)
    with open(image_path, "wb") as f:
        f.write(new_bytes)

    thumb_path = old_thumb or os.path.join(IMAGE_DIR, f"thumb_{uuid.uuid4()}.jpg")
    new_thumb = generate_thumbnail(new_bytes, thumb_path)
    return original_path, new_thumb


@router.post("/{receipt_id}/replace-image")
async def replace_receipt_image(
    receipt_id: int,
    file: UploadFile = File(...),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Replace a receipt's displayed/OCR'd image with a new (client re-cropped &
    perspective-corrected) image, keeping the pristine original for future edits.

    The crop is redone client-side from the original, so this endpoint just
    stores the new bytes and regenerates the thumbnail. If the receipt has no
    separate original yet, the current image is preserved as the original before
    it's overwritten — so the first re-crop is still reversible.
    """
    contents = await file.read(_MAX_UPLOAD_BYTES + 1)
    if not contents:
        raise HTTPException(status_code=422, detail="Empty image")
    if len(contents) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB)")

    async with db.execute(
        "SELECT image_path, original_path, thumbnail_path FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")

    image_path = row["image_path"]
    if not image_path:
        raise HTTPException(status_code=404, detail="Receipt has no image")

    try:
        original_path, new_thumb = await asyncio.to_thread(
            _replace_image_files, contents, image_path, row["original_path"], row["thumbnail_path"]
        )
        await db.execute(
            "UPDATE receipts SET original_path = ?, thumbnail_path = ? WHERE id = ?",
            (original_path, new_thumb, receipt_id),
        )
        await db.commit()
        return {"status": "replaced", "thumbnail_path": new_thumb}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Image replace failed: {e}")
