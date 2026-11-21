"""
Tests for the AI-first upload pipeline in routers.receipts.

Covers:
- POST /upload on the Claude path: categories from Claude's hints are stored
  without a separate categorization call, processing gets the full-resolution
  image while the stored copy is width-capped, PDF text is passed as a hint
- POST /upload-stream: server-sent progress events in order then a result matching
  ProcessingResult, error events for failures inside processing, normal 422s
  for validation errors, DB connection cleanup, and processing that carries
  on after the client disconnects

extract_receipt_with_ai is always mocked; no network calls are made.
"""
import asyncio
import io
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from models.schemas import ProcessingResult
from services.ocr_service import ParsedReceipt


def make_jpeg(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (245, 245, 245)).save(buf, format="JPEG")
    return buf.getvalue()


def ai_parsed() -> ParsedReceipt:
    p = ParsedReceipt()
    p.store_name = "ALDI"
    p.receipt_date = "2026-03-01"
    p.tax = 0.50
    p.discounts = 0.0
    p.total = 6.49
    p.raw_items = [
        {"raw_name": "BANANAS", "clean_name": "Bananas", "price": 1.99, "quantity": 1,
         "category": "Produce"},
        {"raw_name": "MILK GAL", "clean_name": "Milk Gallon", "price": 2.00, "quantity": 2,
         "category": "Dairy & Eggs"},
    ]
    return p


@pytest.fixture
def image_dir(tmp_path):
    return tmp_path / "images"


@pytest.fixture
def db_closed():
    return []


@pytest.fixture
def app(db, image_dir, db_closed):
    os.environ["IMAGE_DIR"] = str(image_dir)
    sys.modules.pop("routers.receipts", None)

    from fastapi import FastAPI
    from routers.receipts import router
    from db.database import get_db

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/receipts")

    async def override_get_db():
        try:
            yield db
        finally:
            db_closed.append(True)

    test_app.dependency_overrides[get_db] = override_get_db
    return test_app


def client_for(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def parse_sse(text: str) -> list[dict]:
    """Parse the server-sent events body: one `data: <json>` line per event,
    each event terminated by a blank line."""
    blocks = text.split("\n\n")
    assert blocks[-1] == "", "the stream must end with a complete event"
    events = []
    for block in blocks[:-1]:
        assert block.startswith("data: ") and "\n" not in block, block
        events.append(json.loads(block[len("data: "):]))
    assert events
    return events


# ── /upload on the Claude path ───────────────────────────────────────────────

class TestUploadAiPath:

    @pytest.mark.asyncio
    @patch("services.categorize_service._call_claude", new_callable=AsyncMock)
    @patch("routers.receipts.extract_text_from_image")
    @patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock)
    async def test_stores_hint_categories_and_width_capped_image(
        self, mock_ai, mock_ocr, mock_cat_claude, db, app
    ):
        mock_ai.return_value = ai_parsed()

        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("r.jpg", make_jpeg(2400, 3000), "image/jpeg")},
            )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        ProcessingResult.model_validate(data)

        assert data["store_name"] == "ALDI"
        assert data["total"] == 6.49
        assert data["total_verified"] is True       # 1.99 + 2×2.00 + 0.50 = 6.49
        assert data["ocr_raw"] == ""                 # image upload: no text layer
        assert [(i["raw_name"], i["category"], i["category_source"]) for i in data["items"]] == [
            ("BANANAS", "Produce", "ai"), ("MILK GAL", "Dairy & Eggs", "ai"),
        ]
        mock_ocr.assert_not_called()                 # no Tesseract on the AI path
        mock_cat_claude.assert_not_called()          # no separate categorization call

        # Claude got the full-resolution image and the enabled categories
        sent_bytes, categories = mock_ai.call_args.args
        assert Image.open(io.BytesIO(sent_bytes)).size == (2400, 3000)
        assert "Produce" in categories
        assert callable(mock_ai.call_args.kwargs["on_progress"])

        # ...but the stored copy is width-capped
        async with db.execute(
            "SELECT image_path, thumbnail_path, ocr_raw FROM receipts WHERE id = ?",
            (data["receipt_id"],),
        ) as cur:
            row = await cur.fetchone()
        assert Image.open(row["image_path"]).size == (1200, 1500)
        assert os.path.exists(row["thumbnail_path"])

        async with db.execute(
            "SELECT category, category_source, ai_confidence FROM line_items "
            "WHERE receipt_id = ? ORDER BY id", (data["receipt_id"],),
        ) as cur:
            rows = await cur.fetchall()
        assert [(r["category"], r["category_source"]) for r in rows] == [
            ("Produce", "ai"), ("Dairy & Eggs", "ai"),
        ]

    @pytest.mark.asyncio
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock)
    async def test_pdf_text_layer_passed_as_hint(self, mock_ai, mock_parse, db, app):
        from tests.test_pdf_upload import make_tiny_pdf

        mock_ai.return_value = ai_parsed()
        pdf = make_tiny_pdf(pages=1, text="BANANAS 1.99\nTOTAL 6.49")

        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/upload",
                files={"file": ("r.pdf", pdf, "application/pdf")},
            )
        assert resp.status_code == 200, resp.text
        assert "BANANAS" in mock_ai.call_args.kwargs["text_hint"]
        assert "BANANAS" in resp.json()["ocr_raw"]
        mock_parse.assert_not_called()


# ── /upload-stream ───────────────────────────────────────────────────────────

async def fake_extract(image_bytes, categories, text_hint=None, *, on_progress=None):
    for n in (1, 2):
        on_progress("reading", method="ai", items=n)
    return ai_parsed()


class TestUploadStream:

    @pytest.mark.asyncio
    @patch("services.categorize_service._call_claude", new_callable=AsyncMock)
    @patch("routers.receipts.extract_receipt_with_ai", side_effect=fake_extract)
    async def test_progress_then_result(self, mock_ai, mock_cat_claude, db, app, db_closed, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/upload-stream",
                files={"file": ("r.jpg", make_jpeg(300, 600), "image/jpeg")},
            )
        assert resp.status_code == 200
        # Must stay text/event-stream: Home Assistant ingress compresses (and so
        # buffers) application/*json* responses, which froze the progress UI.
        assert resp.headers["content-type"].startswith("text/event-stream")
        assert resp.headers["cache-control"] == "no-cache"
        events = parse_sse(resp.text)

        progress = [e for e in events if e["type"] == "progress"]
        assert [e["stage"] for e in progress] == [
            "preparing", "reading", "reading", "reading", "checking", "categorizing", "saving",
        ]
        reading = [e for e in progress if e["stage"] == "reading"]
        assert reading[0] == {"type": "progress", "stage": "reading", "method": "ai"}
        assert [e.get("items") for e in reading[1:]] == [1, 2]

        assert events[-1]["type"] == "result"
        result = ProcessingResult.model_validate(events[-1]["data"])
        assert result.store_name == "ALDI"
        assert [i.category for i in result.items] == ["Produce", "Dairy & Eggs"]
        assert events[0] == {"type": "accepted", "receipt_id": result.receipt_id}
        async with db.execute("SELECT id, status FROM receipts") as cur:
            rows = [tuple(r) for r in await cur.fetchall()]
        assert rows == [(result.receipt_id, "pending")]
        # Two connections were opened — the request's and the background job's —
        # and both were closed.
        assert db_closed == [True, True]

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    @patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock)
    async def test_fallback_emits_ocr_reading_stage(
        self, mock_ai, mock_ocr, mock_parse, mock_cat, db, app, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        mock_ai.return_value = None
        mock_ocr.return_value = "BANANAS 1.99"
        mock_parse.return_value = ai_parsed()
        mock_cat.return_value = ([], False)

        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/upload-stream",
                files={"file": ("r.jpg", make_jpeg(300, 600), "image/jpeg")},
            )
        events = parse_sse(resp.text)
        reading = [e.get("method") for e in events if e.get("stage") == "reading"]
        assert reading == ["ai", "ocr"]
        assert events[-1]["type"] == "result"
        assert events[-1]["data"]["ocr_raw"] == "BANANAS 1.99"

    @pytest.mark.asyncio
    @patch("routers.receipts.categorize_items", new_callable=AsyncMock)
    @patch("routers.receipts.parse_receipt_text")
    @patch("routers.receipts.extract_text_from_image")
    @patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock)
    async def test_no_api_key_reports_only_ocr_reading(
        self, mock_ai, mock_ocr, mock_parse, mock_cat, db, app, monkeypatch
    ):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        mock_ai.return_value = None
        mock_ocr.return_value = "BANANAS 1.99"
        mock_parse.return_value = ai_parsed()
        mock_cat.return_value = ([], False)

        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/upload-stream",
                files={"file": ("r.jpg", make_jpeg(300, 600), "image/jpeg")},
            )
        events = parse_sse(resp.text)
        reading = [e.get("method") for e in events if e.get("stage") == "reading"]
        assert reading == ["ocr"]

    @pytest.mark.asyncio
    async def test_http_exception_inside_processing_yields_error_event(self, db, app, db_closed):
        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/upload-stream",
                files={"file": ("bad.pdf", b"%PDF-garbage", "application/pdf")},
            )
        assert resp.status_code == 200
        events = parse_sse(resp.text)
        assert events[0]["type"] == "accepted"
        assert events[1] == {"type": "progress", "stage": "preparing"}
        assert events[-1]["type"] == "error"
        assert events[-1]["status"] == 422
        assert "Failed to process PDF" in events[-1]["detail"]
        assert db_closed == [True, True]
        # The upload was accepted, so the failure is kept on the receipt.
        async with db.execute("SELECT status, processing_error FROM receipts") as cur:
            rows = [tuple(r) for r in await cur.fetchall()]
        assert len(rows) == 1 and rows[0][0] == "failed"
        assert "Failed to process PDF" in rows[0][1]

    @pytest.mark.asyncio
    @patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock)
    async def test_unexpected_exception_yields_generic_error_event(self, mock_ai, db, app):
        mock_ai.side_effect = RuntimeError("secret internals")
        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/upload-stream",
                files={"file": ("r.jpg", make_jpeg(300, 600), "image/jpeg")},
            )
        events = parse_sse(resp.text)
        assert events[-1] == {"type": "error", "status": 500, "detail": "Receipt processing failed"}

    @pytest.mark.asyncio
    async def test_unsupported_type_is_a_plain_422(self, db, app, db_closed):
        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/upload-stream",
                files={"file": ("doc.txt", b"hello", "text/plain")},
            )
        assert resp.status_code == 422
        assert resp.headers["content-type"].startswith("application/json")
        assert "Unsupported file type" in resp.json()["detail"]
        async with db.execute("SELECT COUNT(*) AS n FROM receipts") as cur:
            assert (await cur.fetchone())["n"] == 0   # rejected before anything is stored

    @pytest.mark.asyncio
    async def test_missing_file_is_a_plain_422(self, db, app):
        async with client_for(app) as client:
            resp = await client.post("/api/receipts/upload-stream", data={"store_name_hint": "X"})
        assert resp.status_code == 422
        assert resp.headers["content-type"].startswith("application/json")

    @pytest.mark.asyncio
    async def test_client_disconnect_does_not_stop_processing(self, db, app, db_closed):
        """Once an upload is accepted, the work no longer belongs to the request."""
        from fastapi import UploadFile
        from starlette.datastructures import Headers
        import routers.receipts as receipts
        from services.receipt_jobs import jobs

        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_extract(*args, **kwargs):
            started.set()
            await release.wait()
            return ai_parsed()

        upload = UploadFile(
            file=io.BytesIO(make_jpeg(300, 600)), filename="r.jpg",
            headers=Headers({"content-type": "image/jpeg"}),
        )
        with patch.object(receipts, "extract_receipt_with_ai", side_effect=slow_extract), \
             patch("services.categorize_service._call_claude", new_callable=AsyncMock):
            response = await receipts.upload_receipt_stream(
                request=SimpleNamespace(app=app), file=upload,
                store_name_hint=None, crop_corners=None, original=None, db=db,
            )
            body = response.body_iterator
            accepted = parse_sse(await body.__anext__())[0]
            assert accepted["type"] == "accepted"
            receipt_id = accepted["receipt_id"]
            assert parse_sse(await body.__anext__())[0] == {"type": "progress", "stage": "preparing"}
            await asyncio.wait_for(started.wait(), timeout=5)

            await body.aclose()         # the client went away mid-extraction
            assert jobs.is_running(receipt_id)

            release.set()
            terminal = await asyncio.wait_for(jobs.wait(receipt_id), timeout=5)

        assert terminal["type"] == "result"
        async with db.execute("SELECT status FROM receipts WHERE id = ?", (receipt_id,)) as cur:
            assert (await cur.fetchone())["status"] == "pending"
        async with db.execute("SELECT COUNT(*) AS n FROM line_items WHERE receipt_id = ?", (receipt_id,)) as cur:
            assert (await cur.fetchone())["n"] == 2
        assert db_closed == [True]      # the job's connection
