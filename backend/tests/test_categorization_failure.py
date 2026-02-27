"""
Tests for categorization failure detection and retry.

Covers:
  - categorize_items returning (results, categorization_failed=True) when Claude API fails
  - categorize_items returning (results, categorization_failed=False) on success
  - categorize_items returning False when all items are learned (no API call)
  - CategorizationError raised by _call_claude on API error / missing key
  - POST /api/receipts/{id}/recategorize endpoint
"""
import os
import sys
import pytest
from unittest.mock import patch, AsyncMock

from services.categorize_service import (
    categorize_items,
    CategorizationError,
    save_mapping,
)


# ── categorize_items failure detection ───────────────────────────────────────

class TestCategorizeItemsFailureFlag:

    @pytest.mark.asyncio
    async def test_returns_failed_true_when_claude_raises(self, db):
        """When _call_claude raises CategorizationError, items default to Other
        and categorization_failed is True."""
        items = [
            {"id": 0, "raw_name": "ORGANIC KALE", "clean_name": "Organic Kale",
             "price": 3.99, "quantity": 1},
            {"id": 1, "raw_name": "CHICKEN BREAST", "clean_name": "Chicken Breast",
             "price": 8.99, "quantity": 1},
        ]

        with patch("services.categorize_service._call_claude",
                    new_callable=AsyncMock, side_effect=CategorizationError("API down")):
            results, failed = await categorize_items(items, "TestMart", db)

        assert failed is True
        assert len(results) == 2
        for r in results:
            assert r["category"] == "Other"
            assert r["category_source"] == "ai"
            assert r["ai_confidence"] == 0.0

    @pytest.mark.asyncio
    async def test_returns_failed_false_when_claude_succeeds(self, db):
        """When _call_claude succeeds, categorization_failed is False."""
        items = [
            {"id": 0, "raw_name": "ORGANIC KALE", "clean_name": "Organic Kale",
             "price": 3.99, "quantity": 1},
        ]

        mock_response = [{"id": 0, "category": "Produce", "confidence": 0.95}]
        with patch("services.categorize_service._call_claude",
                    new_callable=AsyncMock, return_value=mock_response):
            results, failed = await categorize_items(items, "TestMart", db)

        assert failed is False
        assert len(results) == 1
        assert results[0]["category"] == "Produce"
        assert results[0]["ai_confidence"] == 0.95

    @pytest.mark.asyncio
    async def test_returns_failed_false_when_all_learned(self, db):
        """When all items match learned mappings, no API call is made and
        categorization_failed is False."""
        # Pre-seed a learned mapping
        await save_mapping(db, "ORGANIC KALE", "Produce", source="manual")
        await db.commit()

        items = [
            {"id": 0, "raw_name": "ORGANIC KALE", "clean_name": "Organic Kale",
             "price": 3.99, "quantity": 1},
        ]

        # _call_claude should NOT be called at all
        with patch("services.categorize_service._call_claude",
                    new_callable=AsyncMock) as mock_claude:
            results, failed = await categorize_items(items, "TestMart", db)
            mock_claude.assert_not_called()

        assert failed is False
        assert len(results) == 1
        assert results[0]["category"] == "Produce"
        assert results[0]["category_source"] == "learned"

    @pytest.mark.asyncio
    async def test_mixed_learned_and_failed(self, db):
        """When some items are learned and others need Claude, failure only
        affects the unknown items — learned items keep their categories."""
        await save_mapping(db, "MILK", "Dairy & Eggs", source="manual")
        await db.commit()

        items = [
            {"id": 0, "raw_name": "MILK", "clean_name": "Milk",
             "price": 4.99, "quantity": 1},
            {"id": 1, "raw_name": "MYSTERY ITEM", "clean_name": "Mystery Item",
             "price": 2.99, "quantity": 1},
        ]

        with patch("services.categorize_service._call_claude",
                    new_callable=AsyncMock, side_effect=CategorizationError("timeout")):
            results, failed = await categorize_items(items, "TestMart", db)

        assert failed is True
        assert len(results) == 2

        # Learned item keeps its category
        milk = next(r for r in results if r["raw_name"] == "MILK")
        assert milk["category"] == "Dairy & Eggs"
        assert milk["category_source"] == "learned"

        # Unknown item defaults to Other
        mystery = next(r for r in results if r["raw_name"] == "MYSTERY ITEM")
        assert mystery["category"] == "Other"
        assert mystery["category_source"] == "ai"
        assert mystery["ai_confidence"] == 0.0

    @pytest.mark.asyncio
    async def test_preserves_original_order_on_failure(self, db):
        """Items should be returned in their original order even when
        categorization fails."""
        items = [
            {"id": 0, "raw_name": "AAA", "clean_name": "Aaa", "price": 1.0, "quantity": 1},
            {"id": 1, "raw_name": "BBB", "clean_name": "Bbb", "price": 2.0, "quantity": 1},
            {"id": 2, "raw_name": "CCC", "clean_name": "Ccc", "price": 3.0, "quantity": 1},
        ]

        with patch("services.categorize_service._call_claude",
                    new_callable=AsyncMock, side_effect=CategorizationError("fail")):
            results, failed = await categorize_items(items, "TestMart", db)

        assert failed is True
        assert [r["id"] for r in results] == [0, 1, 2]


# ── _call_claude raises CategorizationError ──────────────────────────────────

class TestCallClaudeRaisesError:

    @pytest.mark.asyncio
    async def test_missing_api_key_raises(self, db):
        """When ANTHROPIC_API_KEY is empty, _call_claude should raise
        CategorizationError instead of returning a silent fallback."""
        from services.categorize_service import _call_claude

        items = [{"id": 0, "raw_name": "TEST", "clean_name": "Test"}]

        with patch("services.categorize_service.ANTHROPIC_API_KEY", ""):
            with pytest.raises(CategorizationError, match="ANTHROPIC_API_KEY not set"):
                await _call_claude(items, "Store", db)

    @pytest.mark.asyncio
    async def test_api_exception_raises(self, db):
        """When the Anthropic client throws, _call_claude should wrap it
        in CategorizationError."""
        from services.categorize_service import _call_claude

        items = [{"id": 0, "raw_name": "TEST", "clean_name": "Test"}]

        mock_client = AsyncMock()
        mock_client.messages.create.side_effect = RuntimeError("Connection refused")

        with patch("services.categorize_service.ANTHROPIC_API_KEY", "sk-test-key"):
            with patch("services.categorize_service.anthropic.AsyncAnthropic",
                        return_value=mock_client):
                with pytest.raises(CategorizationError, match="Connection refused"):
                    await _call_claude(items, "Store", db)


# ── POST /api/receipts/{id}/recategorize ─────────────────────────────────────

from httpx import ASGITransport, AsyncClient


async def insert_receipt(db, *, store_name="TestMart", receipt_date="2026-02-15",
                         status="pending", total=50.00):
    cur = await db.execute(
        """INSERT INTO receipts (store_name, receipt_date, status, total)
           VALUES (?, ?, ?, ?)""",
        (store_name, receipt_date, status, total),
    )
    await db.commit()
    return cur.lastrowid


async def insert_item(db, receipt_id, *, raw_name="ITEM", clean_name="Item",
                      price=5.00, quantity=1.0, category="Other",
                      category_source="ai", ai_confidence=0.0):
    cur = await db.execute(
        """INSERT INTO line_items
           (receipt_id, raw_name, clean_name, price, quantity,
            category, category_source, ai_confidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (receipt_id, raw_name, clean_name, price, quantity,
         category, category_source, ai_confidence),
    )
    await db.commit()
    return cur.lastrowid


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


class TestRecategorizeEndpoint:

    @pytest.mark.asyncio
    async def test_recategorize_not_found(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/receipts/99999/recategorize")

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_recategorize_no_items_needing_retry(self, db, app):
        """When no items have category='Other' + category_source='ai',
        returns immediately with updated=0."""
        rid = await insert_receipt(db)
        await insert_item(db, rid, category="Produce", category_source="learned")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/recategorize")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["categorization_failed"] is False
        assert body["updated"] == 0

    @pytest.mark.asyncio
    async def test_recategorize_success_updates_items(self, db, app):
        """Successful recategorization updates line items in the DB."""
        rid = await insert_receipt(db)
        iid1 = await insert_item(db, rid, raw_name="KALE", clean_name="Kale",
                                  category="Other", category_source="ai")
        iid2 = await insert_item(db, rid, raw_name="SALMON", clean_name="Salmon",
                                  category="Other", category_source="ai")
        # This item should NOT be touched (already categorized)
        iid3 = await insert_item(db, rid, raw_name="BREAD", clean_name="Bread",
                                  category="Pantry", category_source="learned")

        mock_result = ([
            {"id": iid1, "raw_name": "KALE", "clean_name": "Kale", "price": 3.99,
             "quantity": 1.0, "category": "Produce", "category_source": "ai",
             "ai_confidence": 0.92},
            {"id": iid2, "raw_name": "SALMON", "clean_name": "Salmon", "price": 12.99,
             "quantity": 1.0, "category": "Meat & Seafood", "category_source": "ai",
             "ai_confidence": 0.88},
        ], False)

        with patch("routers.receipts.categorize_items",
                    new_callable=AsyncMock, return_value=mock_result):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post(f"/api/receipts/{rid}/recategorize")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["categorization_failed"] is False
        assert body["updated"] == 2

        # Verify DB was updated
        async with db.execute("SELECT category FROM line_items WHERE id = ?", (iid1,)) as cur:
            row = await cur.fetchone()
        assert row["category"] == "Produce"

        async with db.execute("SELECT category FROM line_items WHERE id = ?", (iid2,)) as cur:
            row = await cur.fetchone()
        assert row["category"] == "Meat & Seafood"

        # Bread should be untouched
        async with db.execute("SELECT category FROM line_items WHERE id = ?", (iid3,)) as cur:
            row = await cur.fetchone()
        assert row["category"] == "Pantry"

    @pytest.mark.asyncio
    async def test_recategorize_failure_returns_failed(self, db, app):
        """When categorization fails again, returns categorization_failed=True
        and doesn't update any items."""
        rid = await insert_receipt(db)
        iid = await insert_item(db, rid, raw_name="MYSTERY", clean_name="Mystery",
                                 category="Other", category_source="ai")

        mock_result = ([
            {"id": iid, "raw_name": "MYSTERY", "clean_name": "Mystery", "price": 5.0,
             "quantity": 1.0, "category": "Other", "category_source": "ai",
             "ai_confidence": 0.0},
        ], True)

        with patch("routers.receipts.categorize_items",
                    new_callable=AsyncMock, return_value=mock_result):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post(f"/api/receipts/{rid}/recategorize")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "failed"
        assert body["categorization_failed"] is True
        assert body["updated"] == 0

        # Item should remain unchanged
        async with db.execute("SELECT category FROM line_items WHERE id = ?", (iid,)) as cur:
            row = await cur.fetchone()
        assert row["category"] == "Other"

    @pytest.mark.asyncio
    async def test_recategorize_skips_manual_corrections(self, db, app):
        """Items with category_source='manual' should not be recategorized,
        even if their category is 'Other'."""
        rid = await insert_receipt(db)
        await insert_item(db, rid, raw_name="ITEM1", category="Other",
                          category_source="manual")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/recategorize")

        body = resp.json()
        assert body["status"] == "ok"
        assert body["updated"] == 0

    @pytest.mark.asyncio
    async def test_recategorize_skips_non_other_ai_items(self, db, app):
        """Items already categorized as something other than 'Other' should
        not be recategorized."""
        rid = await insert_receipt(db)
        await insert_item(db, rid, raw_name="ITEM1", category="Produce",
                          category_source="ai")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post(f"/api/receipts/{rid}/recategorize")

        body = resp.json()
        assert body["status"] == "ok"
        assert body["updated"] == 0
