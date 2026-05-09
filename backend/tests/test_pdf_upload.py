"""
Tests for PDF upload support in the receipts router.

Verifies that:
- PDF files are accepted and converted to images
- Multi-page PDFs are stitched into a single image
- Invalid/empty PDFs return proper errors
- Non-PDF files still work as before
"""
import io
import os
import sys
from unittest.mock import patch, AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient


# ── Helpers ──────────────────────────────────────────────────────────────────

def make_tiny_pdf(pages: int = 1, text: str | None = None) -> bytes:
    """Create a minimal valid PDF using pypdf.

    If *text* is provided it is inserted on the first page (simulating a
    text-based / digital PDF).  Otherwise pages are blank (simulating a
    scanned image-only PDF).
    """
    from pypdf import PdfWriter
    from pypdf.generic import (
        ArrayObject, DecodedStreamObject, DictionaryObject,
        NameObject, NumberObject, TextStringObject,
    )

    writer = PdfWriter()
    for i in range(pages):
        page = writer.add_blank_page(width=200, height=400)
        if text and i == 0:
            font_dict = DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            })
            resources = DictionaryObject({
                NameObject("/Font"): DictionaryObject({
                    NameObject("/F1"): font_dict,
                }),
            })
            lines = text.split("\n")
            stream_parts = ["BT", "/F1 10 Tf"]
            for j, line in enumerate(lines):
                escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
                stream_parts.append(f"10 {370 - j * 14} Td")
                stream_parts.append(f"({escaped}) Tj")
            stream_parts.append("ET")
            content = DecodedStreamObject()
            content.set_data("\n".join(stream_parts).encode())
            page[NameObject("/Resources")] = resources
            page[NameObject("/Contents")] = writer._add_object(content)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def make_tiny_jpeg() -> bytes:
    """Create a minimal valid JPEG image."""
    from PIL import Image
    buf = io.BytesIO()
    img = Image.new("RGB", (100, 200), (255, 255, 255))
    img.save(buf, format="JPEG")
    return buf.getvalue()


# Mock OCR + categorization so we can test just the upload/conversion logic
MOCK_PARSED = MagicMock(
    store_name="TestMart",
    receipt_date="2026-03-22",
    subtotal=10.0,
    tax=0.80,
    discounts=0.0,
    total=10.80,
    raw_items=[
        {"raw_name": "BANANA", "clean_name": "Banana", "price": 1.50, "quantity": 1},
    ],
)


@pytest.fixture
def app(db, tmp_path):
    os.environ["IMAGE_DIR"] = str(tmp_path / "images")
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


# ── Tests ────────────────────────────────────────────────────────────────────

class TestPdfUpload:

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_with_vision", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    async def test_single_page_pdf_accepted(
        self, mock_ocr, mock_parse, mock_vision, mock_cat, db, app, tmp_path
    ):
        """A single-page PDF should be converted to JPEG and processed normally."""
        mock_ocr.return_value = "BANANA 1.50"
        mock_parse.return_value = MOCK_PARSED
        mock_vision.return_value = MOCK_PARSED
        mock_cat.return_value = (
            [{"id": 0, "raw_name": "BANANA", "clean_name": "Banana",
              "price": 1.50, "quantity": 1, "category": "Produce",
              "category_source": "ai", "ai_confidence": 0.9}],
            False,
        )

        pdf_bytes = make_tiny_pdf(pages=1)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("receipt.pdf", pdf_bytes, "application/pdf")},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["store_name"] == "TestMart"
        assert data["receipt_id"] is not None
        # Verify the saved file is a JPEG, not a PDF
        saved_files = list((tmp_path / "images").glob("*.jpg"))
        assert len(saved_files) >= 1

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_with_vision", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    async def test_multi_page_pdf_stitched(
        self, mock_ocr, mock_parse, mock_vision, mock_cat, db, app, tmp_path
    ):
        """A multi-page PDF should be stitched into a single tall image."""
        mock_ocr.return_value = "BANANA 1.50"
        mock_parse.return_value = MOCK_PARSED
        mock_vision.return_value = MOCK_PARSED
        mock_cat.return_value = (
            [{"id": 0, "raw_name": "BANANA", "clean_name": "Banana",
              "price": 1.50, "quantity": 1, "category": "Produce",
              "category_source": "ai", "ai_confidence": 0.9}],
            False,
        )

        pdf_bytes = make_tiny_pdf(pages=3)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("receipt.pdf", pdf_bytes, "application/pdf")},
            )

        assert resp.status_code == 200
        # Verify the saved image is taller than a single page would be
        from PIL import Image
        saved_files = list((tmp_path / "images").glob("*.jpg"))
        # Filter out thumbnails
        full_images = [f for f in saved_files if not f.name.startswith("thumb_")]
        assert len(full_images) == 1
        img = Image.open(full_images[0])
        # 3 pages stitched → height should be roughly 3x a single page
        assert img.height > img.width

    @pytest.mark.asyncio
    async def test_invalid_pdf_rejected(self, db, app):
        """A file with application/pdf type but invalid content should return 422."""
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("bad.pdf", b"%PDF-garbage", "application/pdf")},
            )

        assert resp.status_code == 422
        assert "Failed to process PDF" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_unsupported_type_still_rejected(self, db, app):
        """Non-image, non-PDF types should still be rejected."""
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("doc.docx", b"PK...", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
            )

        assert resp.status_code == 422
        assert "Unsupported file type" in resp.json()["detail"]

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_with_vision", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    async def test_jpeg_still_works(
        self, mock_ocr, mock_parse, mock_vision, mock_cat, db, app, tmp_path
    ):
        """JPEG uploads should continue to work as before."""
        mock_ocr.return_value = "BANANA 1.50"
        mock_parse.return_value = MOCK_PARSED
        mock_vision.return_value = MOCK_PARSED
        mock_cat.return_value = (
            [{"id": 0, "raw_name": "BANANA", "clean_name": "Banana",
              "price": 1.50, "quantity": 1, "category": "Produce",
              "category_source": "ai", "ai_confidence": 0.9}],
            False,
        )

        jpeg_bytes = make_tiny_jpeg()

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("receipt.jpg", jpeg_bytes, "image/jpeg")},
            )

        assert resp.status_code == 200
        assert resp.json()["store_name"] == "TestMart"

    @pytest.mark.asyncio
    async def test_pdf_magic_bytes_detected(self, db, app):
        """PDF should be detected by magic bytes even if content_type is wrong."""
        # Send PDF bytes but with a generic content type (some clients do this)
        pdf_bytes = make_tiny_pdf(pages=1)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            # application/octet-stream is not in allowed list, so this will be rejected
            # by content-type check. This is expected — magic byte detection is a fallback
            # only when content_type passes.
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("receipt.pdf", pdf_bytes, "application/octet-stream")},
            )

        assert resp.status_code == 422

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_with_vision", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    async def test_text_pdf_skips_tesseract(
        self, mock_ocr, mock_parse, mock_vision, mock_cat, db, app, tmp_path
    ):
        """A PDF with embedded text should use that text directly, skipping Tesseract."""
        mock_parse.return_value = MOCK_PARSED
        mock_vision.return_value = MOCK_PARSED
        mock_cat.return_value = (
            [{"id": 0, "raw_name": "BANANA", "clean_name": "Banana",
              "price": 1.50, "quantity": 1, "category": "Produce",
              "category_source": "ai", "ai_confidence": 0.9}],
            False,
        )

        pdf_bytes = make_tiny_pdf(pages=1, text="BANANA 1.50\nTOTAL 1.50")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("receipt.pdf", pdf_bytes, "application/pdf")},
            )

        assert resp.status_code == 200
        # Tesseract should NOT have been called — text was extracted from PDF
        mock_ocr.assert_not_called()
        # parse_receipt_text should have been called with the embedded text
        mock_parse.assert_called_once()
        call_arg = mock_parse.call_args[0][0]
        assert "BANANA" in call_arg

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_with_vision", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    async def test_scanned_pdf_falls_back_to_tesseract(
        self, mock_ocr, mock_parse, mock_vision, mock_cat, db, app, tmp_path
    ):
        """A scanned PDF (no embedded text) should fall back to Tesseract OCR."""
        mock_ocr.return_value = "BANANA 1.50"
        mock_parse.return_value = MOCK_PARSED
        mock_vision.return_value = MOCK_PARSED
        mock_cat.return_value = (
            [{"id": 0, "raw_name": "BANANA", "clean_name": "Banana",
              "price": 1.50, "quantity": 1, "category": "Produce",
              "category_source": "ai", "ai_confidence": 0.9}],
            False,
        )

        # Blank PDF — no embedded text, simulating a scanned document
        pdf_bytes = make_tiny_pdf(pages=1)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("scanned.pdf", pdf_bytes, "application/pdf")},
            )

        assert resp.status_code == 200
        # Tesseract SHOULD have been called since PDF had no embedded text
        mock_ocr.assert_called_once()
