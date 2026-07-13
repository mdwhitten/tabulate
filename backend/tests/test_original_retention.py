"""
Tests for original-image retention so crops stay reversible.

Covers:
- upload with an `original` file stores it separately (image_path is the
  corrected scan, original_path is the pristine source)
- upload without `original` leaves original_path null and /original falls back
- POST /{id}/replace-image swaps the displayed image while preserving the
  original (copying the current image on the first destructive re-crop)
- delete cleans up the original file too
"""
import io
import os
import sys
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image


def make_jpeg(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (240, 240, 240)).save(buf, format="JPEG")
    return buf.getvalue()


MOCK_PARSED = MagicMock(
    store_name="TestMart", receipt_date="2026-03-22",
    subtotal=10.0, tax=0.80, discounts=0.0, total=10.80,
    raw_items=[{"raw_name": "BANANA", "clean_name": "Banana", "price": 1.50, "quantity": 1}],
)


@pytest.fixture
def image_dir(tmp_path):
    return tmp_path / "images"


@pytest.fixture
def app(db, image_dir):
    os.environ["IMAGE_DIR"] = str(image_dir)
    sys.modules.pop("routers.receipts", None)

    from fastapi import FastAPI
    from routers.receipts import router
    from db.database import get_db

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/receipts")

    async def override_get_db():
        yield db

    test_app.dependency_overrides[get_db] = override_get_db
    return test_app


def _mock_pipeline(mock_ocr, mock_parse, mock_vision, mock_cat):
    mock_ocr.return_value = "BANANA 1.50"
    mock_parse.return_value = MOCK_PARSED
    mock_vision.return_value = MOCK_PARSED
    mock_cat.return_value = ([], False)


class TestUploadOriginal:

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_with_vision", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    async def test_upload_stores_original_separately(
        self, mock_ocr, mock_parse, mock_vision, mock_cat, db, app
    ):
        _mock_pipeline(mock_ocr, mock_parse, mock_vision, mock_cat)
        corrected = make_jpeg(60, 90)      # the client-corrected scan
        original = make_jpeg(120, 200)     # the pristine source

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={
                    "file": ("scan.jpg", corrected, "image/jpeg"),
                    "original": ("original.jpg", original, "image/jpeg"),
                },
            )
            assert resp.status_code == 200
            rid = resp.json()["receipt_id"]

            async with db.execute("SELECT image_path, original_path FROM receipts WHERE id = ?", (rid,)) as cur:
                row = await cur.fetchone()
            assert row["original_path"] is not None
            assert os.path.exists(row["original_path"])
            # image_path is the corrected scan; original_path is the full source
            assert Image.open(row["image_path"]).size == (60, 90)
            assert Image.open(row["original_path"]).size == (120, 200)

            # /original serves the pristine image
            assert (await client.get(f"/api/receipts/{rid}/original")).status_code == 200

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_with_vision", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    async def test_upload_without_original_falls_back(
        self, mock_ocr, mock_parse, mock_vision, mock_cat, db, app
    ):
        _mock_pipeline(mock_ocr, mock_parse, mock_vision, mock_cat)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("scan.jpg", make_jpeg(60, 90), "image/jpeg")},
            )
            rid = resp.json()["receipt_id"]

            async with db.execute("SELECT original_path FROM receipts WHERE id = ?", (rid,)) as cur:
                row = await cur.fetchone()
            assert row["original_path"] is None
            # /original falls back to image_path
            assert (await client.get(f"/api/receipts/{rid}/original")).status_code == 200


class TestReplaceImage:

    async def _insert(self, db, image_dir, original_path=None):
        os.makedirs(image_dir, exist_ok=True)
        img_path = str(image_dir / "img.jpg")
        with open(img_path, "wb") as f:
            f.write(make_jpeg(120, 200))
        cur = await db.execute(
            "INSERT INTO receipts (store_name, image_path, original_path, status) VALUES (?, ?, ?, 'pending')",
            ("TestMart", img_path, original_path),
        )
        await db.commit()
        return cur.lastrowid, img_path

    @pytest.mark.asyncio
    async def test_replace_preserves_first_original(self, db, app, image_dir):
        rid, img_path = await self._insert(db, image_dir)   # no original yet

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                f"/api/receipts/{rid}/replace-image",
                files={"file": ("scan.jpg", make_jpeg(50, 80), "image/jpeg")},
            )
            assert resp.status_code == 200
            assert resp.json()["status"] == "replaced"

        async with db.execute("SELECT image_path, original_path FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        # displayed image is now the new crop; the pre-crop image was preserved
        assert Image.open(row["image_path"]).size == (50, 80)
        assert row["original_path"] is not None and os.path.exists(row["original_path"])
        assert Image.open(row["original_path"]).size == (120, 200)

    @pytest.mark.asyncio
    async def test_replace_keeps_existing_original(self, db, app, image_dir):
        os.makedirs(image_dir, exist_ok=True)
        orig_path = str(image_dir / "orig.jpg")
        with open(orig_path, "wb") as f:
            f.write(make_jpeg(300, 500))
        rid, _ = await self._insert(db, image_dir, original_path=orig_path)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            await client.post(
                f"/api/receipts/{rid}/replace-image",
                files={"file": ("scan.jpg", make_jpeg(50, 80), "image/jpeg")},
            )

        async with db.execute("SELECT original_path FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        # the already-stored original is untouched
        assert row["original_path"] == orig_path
        assert Image.open(orig_path).size == (300, 500)

    @pytest.mark.asyncio
    async def test_delete_removes_original(self, db, app, image_dir):
        os.makedirs(image_dir, exist_ok=True)
        orig_path = str(image_dir / "orig.jpg")
        with open(orig_path, "wb") as f:
            f.write(make_jpeg(120, 200))
        rid, img_path = await self._insert(db, image_dir, original_path=orig_path)

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.delete(f"/api/receipts/{rid}")
            assert resp.status_code == 200

        assert not os.path.exists(orig_path)
        assert not os.path.exists(img_path)
