"""
Receipts Router

POST /api/receipts/upload     — upload image, run OCR + categorization
GET  /api/receipts            — list all receipts (summary)
GET  /api/receipts/{id}       — get receipt with line items
POST /api/receipts/{id}/save  — finalize receipt, apply corrections
DELETE /api/receipts/{id}     — remove a receipt
"""
import logging
import os
import uuid
import shutil
from datetime import datetime
from typing import Optional

import aiosqlite
from fastapi import APIRouter, File, UploadFile, Depends, HTTPException, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel

from db.database import get_db
from models.schemas import ReceiptSummary, Receipt, ProcessingResult, LineItem
from services.ocr_service import extract_text_from_image, parse_receipt_text, parse_receipt_with_vision, verify_total
from services.categorize_service import categorize_items, apply_manual_correction, persist_ai_mappings
from services.image_service import generate_thumbnail, detect_receipt_edges

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

    # Anthropic key
    key = _os.environ.get("ANTHROPIC_API_KEY", "")
    results["anthropic_key"] = {
        "ok": bool(key and key.startswith("sk-")),
        "set": bool(key),
        "hint": (key[:12] + "…") if key else "(not set)",
    }

    all_ok = all(v.get("ok") for v in results.values())
    return {"all_ok": all_ok, "checks": results}


# ── Upload & Process ──────────────────────────────────────────────────────────

@router.post("/upload", response_model=ProcessingResult)
async def upload_receipt(
    file: UploadFile = File(...),
    store_name_hint: Optional[str] = Form(None),
    crop_corners: Optional[str] = Form(None),   # JSON [[x,y],[x,y],[x,y],[x,y]] as 0–1 fractions
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Accept an image upload, run OCR, parse, verify total, categorize items.
    Returns a ProcessingResult for the review screen — nothing is saved to DB yet.
    If crop_corners is provided (4 [x,y] fraction pairs), the image is cropped first.
    """
    import json as _json
    from PIL import Image as _PILImage, ImageOps as _ImageOps
    import io as _io

    contents = await file.read()

    # Always normalise EXIF orientation (phone photos are often rotated in metadata)
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
            corners = _json.loads(crop_corners)
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

    # Save image to disk — always .jpg since we re-encoded above
    ext = ".jpg"
    image_filename = f"{uuid.uuid4()}{ext}"
    image_path = os.path.join(IMAGE_DIR, image_filename)

    with open(image_path, "wb") as f:
        f.write(contents)

    # Generate compressed thumbnail (used for image preview in the review page)
    thumb_filename = f"thumb_{uuid.uuid4()}.jpg"
    thumb_path = os.path.join(IMAGE_DIR, thumb_filename)
    thumbnail_path = generate_thumbnail(contents, thumb_path)

    # OCR — catch all exceptions so we return a clean 422/500 instead of a raw 500
    try:
        ocr_text = extract_text_from_image(contents)
    except Exception as e:
        if os.path.exists(image_path):
            os.remove(image_path)
        err_type = type(e).__name__
        err_msg  = str(e)
        if 'tesseract' in err_msg.lower() or 'Tesseract' in err_type:
            raise HTTPException(status_code=500,
                detail='Tesseract OCR not found in container. Run: docker compose build --no-cache')
        raise HTTPException(status_code=422, detail=f'OCR failed ({err_type}): {err_msg}')

    # Parse — Tesseract regex heuristics first, then Claude Vision enrichment
    parsed = parse_receipt_text(ocr_text)
    parsed = await parse_receipt_with_vision(contents, parsed)
    store = store_name_hint or parsed.store_name or "Unknown Store"

    # Verify total
    verified, verify_msg = verify_total(parsed)

    # Persist receipt (status = 'pending' until user saves)
    cursor = await db.execute(
        """INSERT INTO receipts
           (store_name, receipt_date, image_path, thumbnail_path, ocr_raw,
            subtotal, tax, discounts, total, total_verified, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')""",
        (store, parsed.receipt_date, image_path, thumbnail_path, ocr_text,
         parsed.subtotal, parsed.tax, parsed.discounts, parsed.total,
         1 if verified else 0),
    )
    receipt_id = cursor.lastrowid
    await db.commit()

    # Categorize items (checks learned DB first, then Claude)
    raw_items = [
        {"id": i, "raw_name": item["raw_name"], "clean_name": item["clean_name"],
         "price": item["price"], "quantity": item["quantity"]}
        for i, item in enumerate(parsed.raw_items)
    ]
    categorized = await categorize_items(raw_items, store, db)

    # Persist line items
    line_items = []
    for item in categorized:
        cur2 = await db.execute(
            """INSERT INTO line_items
               (receipt_id, raw_name, clean_name, price, quantity,
                category, category_source, ai_confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (receipt_id, item["raw_name"], item.get("clean_name"),
             item["price"], item.get("quantity", 1),
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
        items=line_items,
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
    async with db.execute("SELECT id FROM receipts WHERE id = ?", (receipt_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Receipt not found")

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

    corrected_ids: set[int] = set()
    for item_id_str, new_category in body.corrections.items():
        item_id_int = int(item_id_str)
        corrected_ids.add(item_id_int)
        await apply_manual_correction(db, item_id_int, new_category)

    # Persist AI-learned mappings only when the user approves (not on draft save).
    # This prevents orphaned mappings when a receipt is later deleted.
    if body.approve:
        await persist_ai_mappings(db, receipt_id, corrected_ids)

    for item_id_str, new_price in body.price_corrections.items():
        try:
            price_val = round(float(new_price), 2)
            if price_val > 0:
                await db.execute(
                    "UPDATE line_items SET price = ? WHERE id = ?",
                    (price_val, int(item_id_str)),
                )
        except (ValueError, TypeError):
            pass

    new_status = "'verified'" if body.approve else "status"

    # If the user manually entered the total, store it and update
    if body.manual_total is not None:
        await db.execute(
            f"""UPDATE receipts
               SET status = {new_status},
                   total = ?,
                   total_verified = 1,
                   receipt_date = COALESCE(?, receipt_date),
                   store_name = COALESCE(?, store_name)
               WHERE id = ?""",
            (round(body.manual_total, 2), body.receipt_date, body.store_name, receipt_id),
        )
    else:
        await db.execute(
            f"""UPDATE receipts
               SET status = {new_status},
                   receipt_date = COALESCE(?, receipt_date),
                   store_name = COALESCE(?, store_name)
               WHERE id = ?""",
            (body.receipt_date, body.store_name, receipt_id),
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

    return {"status": "ok", "receipt_id": receipt_id}


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
                   r.total, r.total_verified, r.status,
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
        "SELECT image_path, thumbnail_path FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")

    # Remove image files (full + thumbnail)
    for path_key in ("image_path", "thumbnail_path"):
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

async def _get_image_path(receipt_id: int, db: aiosqlite.Connection, field: str) -> str:
    async with db.execute(
        f"SELECT {field} FROM receipts WHERE id = ?", (receipt_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Receipt not found")
    path = row[field]
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Image file not found")
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
    corners = detect_receipt_edges(contents)
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
    with open(path, "rb") as f:
        image_bytes = f.read()

    corners = detect_receipt_edges(image_bytes)
    if corners is None:
        # Return full-image corners as fallback
        corners = [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]]

    return {"corners": corners}


@router.post("/{receipt_id}/crop")
async def crop_receipt_image(
    receipt_id: int,
    body: dict,
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Apply a user-confirmed crop to the receipt image.
    Body: { "corners": [[x0,y0],[x1,y1],[x2,y2],[x3,y3]] }
    Corners are fractions (0–1) of the original image dimensions.
    Replaces image_path + thumbnail_path in-place.
    """
    from services.image_service import generate_thumbnail
    from PIL import Image as PILImage
    import io as _io

    corners = body.get("corners")
    if not corners or len(corners) != 4:
        raise HTTPException(status_code=422, detail="Provide exactly 4 corners")

    path = await _get_image_path(receipt_id, db, "image_path")
    with open(path, "rb") as f:
        original_bytes = f.read()

    try:
        from PIL import ImageOps as _ImageOps2
        img = PILImage.open(_io.BytesIO(original_bytes))
        img = _ImageOps2.exif_transpose(img)  # fix phone EXIF rotation
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        w, h = img.size

        # Convert fractional corners → pixel coords
        px_corners = [(c[0] * w, c[1] * h) for c in corners]
        tl, tr, br, bl = px_corners

        # Simple axis-aligned crop (bounding box of the four points)
        x_min = max(0, int(min(tl[0], bl[0])))
        x_max = min(w, int(max(tr[0], br[0])))
        y_min = max(0, int(min(tl[1], tr[1])))
        y_max = min(h, int(max(bl[1], br[1])))

        if x_max <= x_min or y_max <= y_min:
            raise HTTPException(status_code=422, detail="Invalid crop region")

        cropped = img.crop((x_min, y_min, x_max, y_max))

        # Overwrite original file
        buf = _io.BytesIO()
        cropped.save(buf, format="JPEG", quality=90, optimize=True)
        cropped_bytes = buf.getvalue()
        with open(path, "wb") as f:
            f.write(cropped_bytes)

        # Regenerate thumbnail
        async with db.execute(
            "SELECT thumbnail_path FROM receipts WHERE id = ?", (receipt_id,)
        ) as cur:
            row = await cur.fetchone()
        old_thumb = row["thumbnail_path"] if row else None
        thumb_path = old_thumb or os.path.join(IMAGE_DIR, f"thumb_{uuid.uuid4()}.jpg")
        new_thumb = generate_thumbnail(cropped_bytes, thumb_path)

        await db.execute(
            "UPDATE receipts SET thumbnail_path = ? WHERE id = ?",
            (new_thumb, receipt_id),
        )
        await db.commit()

        return {"status": "cropped", "thumbnail_path": new_thumb}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Crop failed: {e}")
