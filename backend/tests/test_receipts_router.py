"""
Tests for the receipts router — save, list, get, delete, and duplicate detection.

Skips upload (requires OCR/Vision) and image/edge endpoints (require filesystem).
Focuses on the DB-backed endpoints that are testable with in-memory SQLite.
"""
import os
import sys
import pytest
from httpx import ASGITransport, AsyncClient


# ── Helpers ──────────────────────────────────────────────────────────────────

async def insert_receipt(db, *, store_name="TestMart", receipt_date="2026-02-15",
                         status="pending", total=50.00, total_verified=0):
    cur = await db.execute(
        """INSERT INTO receipts (store_name, receipt_date, status, total, total_verified)
           VALUES (?, ?, ?, ?, ?)""",
        (store_name, receipt_date, status, total, total_verified),
    )
    await db.commit()
    return cur.lastrowid


async def insert_item(db, receipt_id, *, raw_name="ITEM", clean_name="Item",
                      price=5.00, quantity=1.0, category="Produce",
                      category_source="ai"):
    cur = await db.execute(
        """INSERT INTO line_items
           (receipt_id, raw_name, clean_name, price, quantity, category, category_source)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (receipt_id, raw_name, clean_name, price, quantity, category, category_source),
    )
    await db.commit()
    return cur.lastrowid


# ── Fixture ──────────────────────────────────────────────────────────────────

@pytest.fixture
def app(db, tmp_path):
    # Set IMAGE_DIR to a temp directory so the module-level os.makedirs
    # doesn't fail in environments where /data is not writable (e.g. CI).
    os.environ["IMAGE_DIR"] = str(tmp_path / "images")
    # Force re-import so the module picks up the new IMAGE_DIR
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


# ── GET /api/receipts (list) ────────────────────────────────────────────────

class TestListReceipts:

    @pytest.mark.asyncio
    async def test_empty_list(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts")

        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_returns_receipts(self, db, app):
        await insert_receipt(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts")

        data = resp.json()
        assert len(data) == 1
        assert data[0]["store_name"] == "TestMart"

    @pytest.mark.asyncio
    async def test_includes_item_count(self, db, app):
        rid = await insert_receipt(db)
        await insert_item(db, rid, raw_name="A")
        await insert_item(db, rid, raw_name="B")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts")

        assert resp.json()[0]["item_count"] == 2

    @pytest.mark.asyncio
    async def test_pagination_limit(self, db, app):
        for i in range(5):
            await insert_receipt(db, store_name=f"Store{i}", receipt_date=f"2026-02-{10+i:02d}")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts", params={"limit": 2})

        assert len(resp.json()) == 2

    @pytest.mark.asyncio
    async def test_pagination_offset(self, db, app):
        for i in range(5):
            await insert_receipt(db, store_name=f"Store{i}", receipt_date=f"2026-02-{10+i:02d}")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts", params={"limit": 50, "offset": 3})

        assert len(resp.json()) == 2

    @pytest.mark.asyncio
    async def test_ordered_by_date_desc(self, db, app):
        await insert_receipt(db, store_name="Old", receipt_date="2026-01-01")
        await insert_receipt(db, store_name="New", receipt_date="2026-02-15")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts")

        data = resp.json()
        assert data[0]["store_name"] == "New"
        assert data[1]["store_name"] == "Old"

    @pytest.mark.asyncio
    async def test_response_schema(self, db, app):
        await insert_receipt(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts")

        r = resp.json()[0]
        for field in ("id", "store_name", "receipt_date", "scanned_at",
                       "total", "item_count", "total_verified", "status"):
            assert field in r


# ── GET /api/receipts/{id} ──────────────────────────────────────────────────

class TestGetReceipt:

    @pytest.mark.asyncio
    async def test_returns_receipt_with_items(self, db, app):
        rid = await insert_receipt(db)
        await insert_item(db, rid, raw_name="CHICKEN", clean_name="Chicken")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(f"/api/receipts/{rid}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == rid
        assert body["store_name"] == "TestMart"
        assert len(body["items"]) == 1
        assert body["items"][0]["raw_name"] == "CHICKEN"

    @pytest.mark.asyncio
    async def test_not_found(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts/99999")

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_response_includes_all_fields(self, db, app):
        rid = await insert_receipt(db, total=25.50)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(f"/api/receipts/{rid}")

        body = resp.json()
        assert body["total"] == 25.50
        assert body["status"] == "pending"
        assert "items" in body


# ── DELETE /api/receipts/{id} ────────────────────────────────────────────────

class TestDeleteReceipt:

    @pytest.mark.asyncio
    async def test_delete_receipt(self, db, app):
        rid = await insert_receipt(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.delete(f"/api/receipts/{rid}")

        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"

    @pytest.mark.asyncio
    async def test_delete_removes_from_db(self, db, app):
        rid = await insert_receipt(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.delete(f"/api/receipts/{rid}")

        async with db.execute("SELECT id FROM receipts WHERE id = ?", (rid,)) as cur:
            assert await cur.fetchone() is None

    @pytest.mark.asyncio
    async def test_delete_cascades_line_items(self, db, app):
        rid = await insert_receipt(db)
        await insert_item(db, rid)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.delete(f"/api/receipts/{rid}")

        async with db.execute("SELECT id FROM line_items WHERE receipt_id = ?", (rid,)) as cur:
            assert await cur.fetchone() is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_returns_404(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.delete("/api/receipts/99999")

        assert resp.status_code == 404


# ── GET /api/receipts/check-duplicates ──────────────────────────────────────

class TestCheckDuplicates:

    @pytest.mark.asyncio
    async def test_no_params_returns_empty(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts/check-duplicates")

        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_finds_duplicate(self, db, app):
        await insert_receipt(db, receipt_date="2026-02-15", total=42.50)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts/check-duplicates", params={
                "total": 42.50, "receipt_date": "2026-02-15"
            })

        data = resp.json()
        assert len(data) == 1
        assert data[0]["total"] == 42.50

    @pytest.mark.asyncio
    async def test_near_match_within_tolerance(self, db, app):
        await insert_receipt(db, receipt_date="2026-02-15", total=42.50)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts/check-duplicates", params={
                "total": 42.505, "receipt_date": "2026-02-15"
            })

        assert len(resp.json()) == 1

    @pytest.mark.asyncio
    async def test_no_match_different_date(self, db, app):
        await insert_receipt(db, receipt_date="2026-02-15", total=42.50)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts/check-duplicates", params={
                "total": 42.50, "receipt_date": "2026-02-16"
            })

        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_exclude_id(self, db, app):
        rid = await insert_receipt(db, receipt_date="2026-02-15", total=42.50)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts/check-duplicates", params={
                "total": 42.50, "receipt_date": "2026-02-15", "exclude_id": rid
            })

        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_missing_total_returns_empty(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/receipts/check-duplicates", params={
                "receipt_date": "2026-02-15"
            })

        assert resp.json() == []


# ── POST /api/receipts/{id}/save ────────────────────────────────────────────

class TestSaveReceipt:

    @pytest.mark.asyncio
    async def test_save_not_found(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/receipts/99999/save", json={})

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_draft_save_keeps_status(self, db, app):
        rid = await insert_receipt(db, status="pending")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "approve": False
            })

        assert resp.status_code == 200
        async with db.execute("SELECT status FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["status"] == "pending"

    @pytest.mark.asyncio
    async def test_approve_sets_verified(self, db, app):
        rid = await insert_receipt(db, status="pending")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "approve": True
            })

        assert resp.status_code == 200
        async with db.execute("SELECT status FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["status"] == "verified"

    @pytest.mark.asyncio
    async def test_delete_items(self, db, app):
        rid = await insert_receipt(db)
        iid = await insert_item(db, rid, raw_name="TO_DELETE")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={
                "deleted_item_ids": [iid]
            })

        async with db.execute("SELECT id FROM line_items WHERE id = ?", (iid,)) as cur:
            assert await cur.fetchone() is None

    @pytest.mark.asyncio
    async def test_add_new_items(self, db, app):
        rid = await insert_receipt(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={
                "new_items": [{"name": "Manual Item", "price": 3.99, "category": "Snacks"}]
            })

        async with db.execute(
            "SELECT raw_name, price, category, category_source FROM line_items WHERE receipt_id = ?",
            (rid,),
        ) as cur:
            row = await cur.fetchone()
        assert row["raw_name"] == "Manual Item"
        assert row["price"] == 3.99
        assert row["category"] == "Snacks"
        assert row["category_source"] == "manual"

    @pytest.mark.asyncio
    async def test_name_corrections_update_clean_name(self, db, app):
        rid = await insert_receipt(db)
        iid = await insert_item(db, rid, raw_name="CHKN BRST", clean_name="Chkn Brst")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={
                "name_corrections": {str(iid): "Chicken Breast"}
            })

        async with db.execute(
            "SELECT raw_name, clean_name FROM line_items WHERE id = ?", (iid,)
        ) as cur:
            row = await cur.fetchone()
        assert row["raw_name"] == "CHKN BRST"  # immutable
        assert row["clean_name"] == "Chicken Breast"

    @pytest.mark.asyncio
    async def test_price_corrections(self, db, app):
        rid = await insert_receipt(db)
        iid = await insert_item(db, rid, price=5.00)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={
                "price_corrections": {str(iid): 7.99}
            })

        async with db.execute("SELECT price FROM line_items WHERE id = ?", (iid,)) as cur:
            row = await cur.fetchone()
        assert row["price"] == 7.99

    @pytest.mark.asyncio
    async def test_manual_total(self, db, app):
        rid = await insert_receipt(db, total=None)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={
                "manual_total": 35.99
            })

        async with db.execute("SELECT total, total_verified FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["total"] == 35.99
        assert row["total_verified"] == 1

    @pytest.mark.asyncio
    async def test_store_name_update(self, db, app):
        rid = await insert_receipt(db, store_name="Unknown Store")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={
                "store_name": "Costco"
            })

        async with db.execute("SELECT store_name FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["store_name"] == "Costco"

    @pytest.mark.asyncio
    async def test_receipt_date_update(self, db, app):
        rid = await insert_receipt(db, receipt_date=None)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={
                "receipt_date": "2026-03-01"
            })

        async with db.execute("SELECT receipt_date FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["receipt_date"] == "2026-03-01"

    @pytest.mark.asyncio
    async def test_category_corrections(self, db, app):
        rid = await insert_receipt(db)
        iid = await insert_item(db, rid, category="Other", category_source="ai")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={
                "corrections": {str(iid): "Produce"}
            })

        async with db.execute(
            "SELECT category, category_source, corrected FROM line_items WHERE id = ?", (iid,)
        ) as cur:
            row = await cur.fetchone()
        assert row["category"] == "Produce"
        assert row["category_source"] == "manual"
        assert row["corrected"] == 1

    @pytest.mark.asyncio
    async def test_approve_persists_mappings(self, db, app):
        """Approving a receipt should persist item mappings."""
        rid = await insert_receipt(db)
        await insert_item(db, rid, raw_name="ORGANIC MILK", clean_name="Organic Milk",
                          category="Dairy & Eggs", category_source="ai")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={"approve": True})

        async with db.execute("SELECT * FROM item_mappings") as cur:
            rows = await cur.fetchall()
        assert len(rows) >= 1
        mapping = rows[0]
        assert mapping["category"] == "Dairy & Eggs"

    @pytest.mark.asyncio
    async def test_draft_save_does_not_persist_mappings(self, db, app):
        """Draft save (approve=False) should NOT persist item mappings."""
        rid = await insert_receipt(db)
        await insert_item(db, rid, raw_name="ORGANIC MILK", category="Dairy & Eggs")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(f"/api/receipts/{rid}/save", json={"approve": False})

        async with db.execute("SELECT COUNT(*) FROM item_mappings") as cur:
            count = (await cur.fetchone())[0]
        assert count == 0


# ── Blank receipt_date save/approve ───────────────────────────────────────────

class TestSaveReceiptDateValidation:
    """
    Regression tests for receipts saved or approved without a date.

    The frontend guards against this (handleSave blocks when receiptDate is
    empty), but the backend must also reject it — especially on approve —
    to prevent blank-date receipts from entering the verified state.
    """

    @pytest.mark.asyncio
    async def test_approve_rejects_null_date_when_db_date_is_null(self, db, app):
        """Approving a receipt that has no date (and sends none) should fail."""
        rid = await insert_receipt(db, receipt_date=None)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "approve": True, "receipt_date": None,
            })

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_approve_rejects_empty_string_date(self, db, app):
        """Approving with receipt_date='' should fail — empty string is not a valid date."""
        rid = await insert_receipt(db, receipt_date=None)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "approve": True, "receipt_date": "",
            })

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_approve_rejects_when_no_date_in_body_or_db(self, db, app):
        """Approving without sending receipt_date when DB has none should fail."""
        rid = await insert_receipt(db, receipt_date=None)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "approve": True,
            })

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_approve_succeeds_when_db_already_has_date(self, db, app):
        """Approving without sending a new date is fine if the DB already has one."""
        rid = await insert_receipt(db, receipt_date="2026-02-20")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "approve": True,
            })

        assert resp.status_code == 200
        async with db.execute("SELECT receipt_date FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["receipt_date"] == "2026-02-20"

    @pytest.mark.asyncio
    async def test_approve_succeeds_with_valid_date(self, db, app):
        """Approving with a valid date should work even if DB date was null."""
        rid = await insert_receipt(db, receipt_date=None)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "approve": True, "receipt_date": "2026-02-25",
            })

        assert resp.status_code == 200
        async with db.execute("SELECT receipt_date FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["receipt_date"] == "2026-02-25"

    @pytest.mark.asyncio
    async def test_draft_save_allows_null_date(self, db, app):
        """Draft saves (approve=False) should still be allowed without a date."""
        rid = await insert_receipt(db, receipt_date=None)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "approve": False,
            })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_empty_string_date_not_stored_in_db(self, db, app):
        """Sending receipt_date='' on draft save should not store an empty string."""
        rid = await insert_receipt(db, receipt_date=None)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "receipt_date": "",
            })

        assert resp.status_code == 200
        async with db.execute("SELECT receipt_date FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        # Empty string should be treated as null, not stored as ""
        assert row["receipt_date"] is None

    @pytest.mark.asyncio
    async def test_coalesce_preserves_existing_date_on_null_input(self, db, app):
        """Sending receipt_date=null should keep the existing date, not clear it."""
        rid = await insert_receipt(db, receipt_date="2026-02-20")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/save", json={
                "receipt_date": None,
            })

        assert resp.status_code == 200
        async with db.execute("SELECT receipt_date FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["receipt_date"] == "2026-02-20"
