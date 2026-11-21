"""
Tests for accept-then-process uploads (routers.receipts + services.receipt_jobs).

Covers:
- POST /enqueue answers before processing finishes; the receipt is listed as
  'processing' with live progress, then becomes 'pending' with its items
- failures are kept on the receipt ('failed' + processing_error) and can be
  retried with POST /{id}/reprocess
- a receipt that is still processing can't be saved / recategorized / re-cropped,
  and deleting it stops the job and removes the raw upload
- resume_processing() re-queues receipts left 'processing' by a restart, and
  gives up after MAX_PROCESSING_ATTEMPTS
- the concurrency cap, and the job runner's snapshot/subscribe/wait behaviour

extract_receipt_with_ai is always mocked; no network calls are made.
"""
import asyncio
import io
import json
import os
import sys
from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image

from services.ocr_service import ParsedReceipt
from services.receipt_jobs import ReceiptJobs, jobs, merge_progress


def make_jpeg(w: int = 300, h: int = 600) -> bytes:
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


class Gate:
    """A fake extract_receipt_with_ai that reports progress, then waits to be released."""

    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0
        self.running = 0
        self.max_running = 0

    async def __call__(self, image_bytes, categories, text_hint=None, *, on_progress=None):
        self.calls += 1
        self.running += 1
        self.max_running = max(self.max_running, self.running)
        try:
            on_progress("reading", method="ai", items=3)
            self.started.set()
            await self.release.wait()
            return ai_parsed()
        finally:
            self.running -= 1


@pytest.fixture
def image_dir(tmp_path):
    return tmp_path / "images"


@pytest.fixture
async def app(db, image_dir, monkeypatch):
    os.environ["IMAGE_DIR"] = str(image_dir)
    sys.modules.pop("routers.receipts", None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    from fastapi import FastAPI
    from routers.receipts import router
    from routers.trends import router as trends_router
    from db.database import get_db

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/receipts")
    test_app.include_router(trends_router, prefix="/api/trends")

    async def override_get_db():
        yield db

    test_app.dependency_overrides[get_db] = override_get_db
    await jobs.reset()          # receipt ids repeat across tests' fresh DBs
    yield test_app
    await jobs.reset()          # don't leak a hanging job into the next test


def client_for(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def enqueue(client, **extra_files) -> int:
    resp = await client.post(
        "/api/receipts/enqueue",
        files={"file": ("r.jpg", make_jpeg(), "image/jpeg"), **extra_files},
    )
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["status"] == "processing"
    return body["receipt_id"]


async def status_of(client, *ids) -> list[dict]:
    resp = await client.get("/api/receipts/status", params={"ids": ",".join(map(str, ids))})
    assert resp.status_code == 200, resp.text
    return resp.json()


def uploads_on_disk(image_dir) -> list[str]:
    return sorted(f for f in os.listdir(image_dir) if f.startswith("upload_"))


# ── Accept, then process ─────────────────────────────────────────────────────

class TestEnqueue:

    @patch("services.categorize_service._call_claude", new_callable=AsyncMock)
    async def test_answers_before_processing_and_finishes_in_background(
        self, mock_cat, db, app, image_dir
    ):
        gate = Gate()
        with patch("routers.receipts.extract_receipt_with_ai", new=gate):
            async with client_for(app) as client:
                receipt_id = await enqueue(
                    client, original=("orig.jpg", make_jpeg(400, 800), "image/jpeg"))
                await asyncio.wait_for(gate.started.wait(), timeout=5)

                # Durable already: raw upload + original on disk, a row in the list.
                assert len(uploads_on_disk(image_dir)) == 2
                listed = (await client.get("/api/receipts")).json()
                assert [(r["id"], r["status"], r["item_count"]) for r in listed] == [
                    (receipt_id, "processing", 0)]
                detail = (await client.get(f"/api/receipts/{receipt_id}")).json()
                assert detail["status"] == "processing" and detail["items"] == []

                # Live progress while it works.
                [st] = await status_of(client, receipt_id)
                assert st["status"] == "processing"
                assert st["progress"] == {"stage": "reading", "method": "ai", "items": 3}
                assert st["result"] is None and st["error"] is None

                gate.release.set()
                await asyncio.wait_for(jobs.wait(receipt_id), timeout=5)

                [st] = await status_of(client, receipt_id)
                assert st["status"] == "pending"
                assert st["progress"] is None
                assert st["result"]["receipt_id"] == receipt_id
                assert st["result"]["store_name"] == "ALDI"
                assert [i["category"] for i in st["result"]["items"]] == ["Produce", "Dairy & Eggs"]

                detail = (await client.get(f"/api/receipts/{receipt_id}")).json()
                assert detail["status"] == "pending"
                assert detail["total"] == 6.49
                assert len(detail["items"]) == 2

        # The raw upload is only needed until processing succeeds.
        assert uploads_on_disk(image_dir) == []
        async with db.execute(
            "SELECT image_path, original_path, thumbnail_path, processing_job FROM receipts"
        ) as cur:
            row = await cur.fetchone()
        assert row["processing_job"] is None
        for key in ("image_path", "original_path", "thumbnail_path"):
            assert os.path.exists(row[key]), key

    async def test_validation_errors_store_nothing(self, db, app, image_dir):
        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/enqueue", files={"file": ("doc.txt", b"hello", "text/plain")})
        assert resp.status_code == 422
        async with db.execute("SELECT COUNT(*) AS n FROM receipts") as cur:
            assert (await cur.fetchone())["n"] == 0
        assert not image_dir.exists() or uploads_on_disk(image_dir) == []

    async def test_store_name_hint_is_used(self, db, app):
        with patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock) as mock_ai, \
             patch("services.categorize_service._call_claude", new_callable=AsyncMock):
            mock_ai.return_value = ai_parsed()
            async with client_for(app) as client:
                resp = await client.post(
                    "/api/receipts/enqueue",
                    files={"file": ("r.jpg", make_jpeg(), "image/jpeg")},
                    data={"store_name_hint": "Costco"},
                )
                receipt_id = resp.json()["receipt_id"]
                await jobs.wait(receipt_id)
                detail = (await client.get(f"/api/receipts/{receipt_id}")).json()
        assert detail["store_name"] == "Costco"


class TestStatusEndpoint:

    async def test_skips_unknown_ids_and_rejects_garbage(self, db, app):
        await db.execute("INSERT INTO receipts (store_name, status) VALUES ('Old', 'verified')")
        await db.commit()
        async with client_for(app) as client:
            assert await status_of(client, 1, 999) == [
                {"id": 1, "status": "verified", "progress": None, "error": None, "result": None}]
            assert (await client.get("/api/receipts/status", params={"ids": "1,abc"})).status_code == 422
            assert (await client.get("/api/receipts/status", params={"ids": ""})).json() == []

    @patch("services.categorize_service._call_claude", new_callable=AsyncMock)
    async def test_result_is_omitted_once_forgotten(self, mock_cat, db, app):
        """After a restart the finished job's result is gone; the client then
        fetches the receipt instead."""
        with patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock) as mock_ai:
            mock_ai.return_value = ai_parsed()
            async with client_for(app) as client:
                receipt_id = await enqueue(client)
                await jobs.wait(receipt_id)
                await jobs.reset()
                [st] = await status_of(client, receipt_id)
        assert st["status"] == "pending" and st["result"] is None

    async def test_processing_row_without_a_job_reads_as_queued(self, db, app):
        await db.execute("INSERT INTO receipts (store_name, status) VALUES ('', 'processing')")
        await db.commit()
        async with client_for(app) as client:
            [st] = await status_of(client, 1)
        assert st["progress"] == {"stage": "queued"}


# ── Failures and retry ───────────────────────────────────────────────────────

class TestFailureAndReprocess:

    @patch("services.categorize_service._call_claude", new_callable=AsyncMock)
    async def test_failure_is_kept_and_reprocess_recovers(self, mock_cat, db, app, image_dir):
        with patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock) as mock_ai:
            mock_ai.side_effect = RuntimeError("secret internals")
            async with client_for(app) as client:
                receipt_id = await enqueue(client)
                terminal = await jobs.wait(receipt_id)
                assert terminal == {"type": "error", "status": 500, "detail": "Receipt processing failed"}

                [st] = await status_of(client, receipt_id)
                assert st == {"id": receipt_id, "status": "failed", "progress": None,
                              "error": "Receipt processing failed", "result": None}
                detail = (await client.get(f"/api/receipts/{receipt_id}")).json()
                assert detail["status"] == "failed"
                assert detail["processing_error"] == "Receipt processing failed"
                # The raw upload is kept so a retry is possible.
                assert len(uploads_on_disk(image_dir)) == 1

                # A failed receipt has nothing to edit.
                save = await client.post(f"/api/receipts/{receipt_id}/save", json={})
                assert save.status_code == 409

                mock_ai.side_effect = None
                mock_ai.return_value = ai_parsed()
                retry = await client.post(f"/api/receipts/{receipt_id}/reprocess")
                assert retry.status_code == 202
                assert retry.json() == {"receipt_id": receipt_id, "status": "processing"}
                terminal = await jobs.wait(receipt_id)
                assert terminal["type"] == "result"

                detail = (await client.get(f"/api/receipts/{receipt_id}")).json()
                assert detail["status"] == "pending"
                assert detail["processing_error"] is None
                assert len(detail["items"]) == 2
        assert uploads_on_disk(image_dir) == []

    async def test_reprocess_only_applies_to_failed_receipts(self, db, app):
        await db.execute("INSERT INTO receipts (store_name, status) VALUES ('Done', 'pending')")
        await db.execute(
            "INSERT INTO receipts (store_name, status, processing_job) VALUES ('', 'failed', ?)",
            (json.dumps({"source": "/nonexistent/upload.bin"}),),
        )
        await db.commit()
        async with client_for(app) as client:
            assert (await client.post("/api/receipts/1/reprocess")).status_code == 409
            gone = await client.post("/api/receipts/2/reprocess")
            assert gone.status_code == 409 and "no longer on the server" in gone.json()["detail"]
            assert (await client.post("/api/receipts/99/reprocess")).status_code == 404

    async def test_bad_pdf_fails_with_the_reason(self, db, app):
        async with client_for(app) as client:
            resp = await client.post(
                "/api/receipts/enqueue", files={"file": ("bad.pdf", b"%PDF-garbage", "application/pdf")})
            receipt_id = resp.json()["receipt_id"]
            await jobs.wait(receipt_id)
            [st] = await status_of(client, receipt_id)
        assert st["status"] == "failed"
        assert "Failed to process PDF" in st["error"]


# ── A receipt that is still processing ───────────────────────────────────────

class TestWhileProcessing:

    async def test_edits_are_refused(self, db, app):
        gate = Gate()
        with patch("routers.receipts.extract_receipt_with_ai", new=gate):
            async with client_for(app) as client:
                receipt_id = await enqueue(client)
                await asyncio.wait_for(gate.started.wait(), timeout=5)
                base = f"/api/receipts/{receipt_id}"
                assert (await client.post(f"{base}/save", json={})).status_code == 409
                assert (await client.post(f"{base}/recategorize")).status_code == 409
                replace = await client.post(
                    f"{base}/replace-image", files={"file": ("r.jpg", make_jpeg(), "image/jpeg")})
                assert replace.status_code == 409
                assert (await client.post(f"{base}/reprocess")).status_code == 409

    async def test_delete_stops_the_job_and_removes_the_upload(self, db, app, image_dir):
        gate = Gate()
        with patch("routers.receipts.extract_receipt_with_ai", new=gate):
            async with client_for(app) as client:
                receipt_id = await enqueue(client)
                await asyncio.wait_for(gate.started.wait(), timeout=5)
                assert jobs.is_running(receipt_id)

                resp = await client.delete(f"/api/receipts/{receipt_id}")
                assert resp.status_code == 200
                assert not jobs.is_running(receipt_id)
                assert await status_of(client, receipt_id) == []
        assert os.listdir(image_dir) == []
        async with db.execute("SELECT COUNT(*) AS n FROM receipts") as cur:
            assert (await cur.fetchone())["n"] == 0

    async def test_processing_and_failed_receipts_are_not_counted_as_scanned(self, db, app):
        await db.execute("INSERT INTO receipts (store_name, status) VALUES ('A', 'verified')")
        await db.execute("INSERT INTO receipts (store_name, status) VALUES ('B', 'pending')")
        await db.execute("INSERT INTO receipts (store_name, status) VALUES ('', 'processing')")
        await db.execute("INSERT INTO receipts (store_name, status) VALUES ('', 'failed')")
        await db.commit()
        async with client_for(app) as client:
            summary = (await client.get("/api/trends/summary")).json()
        assert summary["receipt_count"] == 2


# ── Restart recovery ─────────────────────────────────────────────────────────

class TestResume:

    @patch("services.categorize_service._call_claude", new_callable=AsyncMock)
    async def test_requeues_receipts_left_processing(self, mock_cat, db, app, image_dir):
        import routers.receipts as receipts
        from db.database import get_db

        gate = Gate()
        with patch("routers.receipts.extract_receipt_with_ai", new=gate):
            async with client_for(app) as client:
                receipt_id = await enqueue(client)
                await asyncio.wait_for(gate.started.wait(), timeout=5)

                # The server goes down mid-extraction…
                await jobs.shutdown()
                assert not jobs.is_running(receipt_id)
                async with db.execute("SELECT status FROM receipts") as cur:
                    assert (await cur.fetchone())["status"] == "processing"
                assert len(uploads_on_disk(image_dir)) == 1

                # …and picks the receipt up again when it comes back.
                gate.release.set()
                resumed = await receipts.resume_processing(app.dependency_overrides[get_db])
                assert resumed == 1
                terminal = await asyncio.wait_for(jobs.wait(receipt_id), timeout=5)
                assert terminal["type"] == "result"
                assert gate.calls == 2

                detail = (await client.get(f"/api/receipts/{receipt_id}")).json()
        assert detail["status"] == "pending" and len(detail["items"]) == 2

    async def test_gives_up_after_repeated_interruptions(self, db, app, image_dir):
        import routers.receipts as receipts
        from db.database import get_db

        image_dir.mkdir(parents=True, exist_ok=True)
        source = image_dir / "upload_x.bin"
        source.write_bytes(make_jpeg())
        job = {"source": str(source), "content_type": "image/jpeg",
               "attempts": receipts.MAX_PROCESSING_ATTEMPTS}
        await db.execute(
            "INSERT INTO receipts (store_name, status, processing_job) VALUES ('', 'processing', ?)",
            (json.dumps(job),),
        )
        await db.commit()

        with patch("routers.receipts.extract_receipt_with_ai", new_callable=AsyncMock) as mock_ai:
            assert await receipts.resume_processing(app.dependency_overrides[get_db]) == 1
            terminal = await asyncio.wait_for(jobs.wait(1), timeout=5)
            mock_ai.assert_not_called()

        assert terminal["type"] == "error" and "interrupted" in terminal["detail"]
        async with db.execute("SELECT status, processing_error FROM receipts") as cur:
            row = await cur.fetchone()
        assert row["status"] == "failed" and "interrupted" in row["processing_error"]

    async def test_missing_upload_file_fails_cleanly(self, db, app):
        import routers.receipts as receipts
        from db.database import get_db

        await db.execute(
            "INSERT INTO receipts (store_name, status, processing_job) VALUES ('', 'processing', ?)",
            (json.dumps({"source": "/nonexistent/upload.bin", "attempts": 0}),),
        )
        await db.commit()
        await receipts.resume_processing(app.dependency_overrides[get_db])
        terminal = await asyncio.wait_for(jobs.wait(1), timeout=5)
        assert terminal["type"] == "error" and "no longer on the server" in terminal["detail"]


# ── Bounded parallelism ──────────────────────────────────────────────────────

class TestConcurrency:

    @patch("services.categorize_service._call_claude", new_callable=AsyncMock)
    async def test_batch_is_processed_at_most_n_at_a_time(self, mock_cat, db, app, monkeypatch):
        monkeypatch.setenv("PROCESSING_CONCURRENCY", "2")
        gate = Gate()
        with patch("routers.receipts.extract_receipt_with_ai", new=gate):
            async with client_for(app) as client:
                ids = [await enqueue(client) for _ in range(5)]
                await asyncio.wait_for(gate.started.wait(), timeout=5)
                for _ in range(20):
                    await asyncio.sleep(0)      # let every job that can start, start

                stages = [s["progress"]["stage"] for s in await status_of(client, *ids)]
                assert stages.count("queued") == 3
                assert gate.running == 2

                gate.release.set()
                for receipt_id in ids:
                    await asyncio.wait_for(jobs.wait(receipt_id), timeout=5)
                assert [s["status"] for s in await status_of(client, *ids)] == ["pending"] * 5
        assert gate.max_running == 2
        assert gate.calls == 5


# ── Job runner ───────────────────────────────────────────────────────────────

class TestMergeProgress:

    def test_later_stage_replaces_earlier_and_keeps_details(self):
        snap = merge_progress({"stage": "queued"}, "preparing", {})
        snap = merge_progress(snap, "reading", {"method": "ai"})
        snap = merge_progress(snap, "reading", {"method": "ai", "items": 4})
        assert snap == {"stage": "reading", "method": "ai", "items": 4}

    def test_rereading_during_a_recheck_keeps_the_rechecking_stage(self):
        snap = {"stage": "reading", "method": "ai", "items": 4}
        snap = merge_progress(snap, "rechecking", {"problems": 1})
        snap = merge_progress(snap, "reading", {"method": "ai", "items": 5})
        assert snap["stage"] == "rechecking" and snap["items"] == 5
        assert merge_progress(snap, "checking", {})["stage"] == "checking"

    def test_ocr_fallback_drops_the_ai_item_count(self):
        snap = {"stage": "reading", "method": "ai", "items": 4}
        assert merge_progress(snap, "reading", {"method": "ocr"}) == {"stage": "reading", "method": "ocr"}


class TestReceiptJobs:

    async def test_subscriber_sees_progress_then_terminal_then_end(self):
        runner = ReceiptJobs()

        async def work(progress):
            progress("preparing")
            progress("reading", method="ai")
            return {"type": "result", "data": {"ok": True}}

        runner.submit(7, work)
        queue = runner.subscribe(7)
        seen = []
        while (event := await asyncio.wait_for(queue.get(), timeout=5)) is not None:
            seen.append(event)
        assert seen == [
            {"type": "progress", "stage": "preparing"},
            {"type": "progress", "stage": "reading", "method": "ai"},
            {"type": "result", "data": {"ok": True}},
        ]
        assert not runner.is_running(7)
        assert runner.snapshot(7) is None
        assert runner.result(7) == {"type": "result", "data": {"ok": True}}

    async def test_crashing_work_becomes_an_error_event(self):
        runner = ReceiptJobs()

        async def work(progress):
            raise RuntimeError("boom")

        runner.submit(1, work)
        assert await runner.wait(1) == {"type": "error", "status": 500, "detail": "Receipt processing failed"}

    async def test_giving_up_waiting_does_not_cancel_the_work(self):
        runner = ReceiptJobs()
        release = asyncio.Event()

        async def work(progress):
            await release.wait()
            return {"type": "result", "data": {}}

        runner.submit(1, work)
        waiter = asyncio.create_task(runner.wait(1))
        await asyncio.sleep(0)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert runner.is_running(1)
        release.set()
        assert (await runner.wait(1))["type"] == "result"

    async def test_cancel_ends_subscribers_without_a_result(self):
        runner = ReceiptJobs()

        async def work(progress):
            await asyncio.Event().wait()

        runner.submit(1, work)
        queue = runner.subscribe(1)
        await asyncio.sleep(0)
        await runner.cancel(1)
        assert await asyncio.wait_for(queue.get(), timeout=5) is None
        assert not runner.is_running(1) and runner.result(1) is None

    async def test_subscribing_to_a_finished_job_ends_immediately(self):
        assert await ReceiptJobs().subscribe(123).get() is None
