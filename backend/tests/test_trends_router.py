"""
Tests for the trends router — monthly spending, store breakdown, and dashboard summary.

Covers:
- GET /api/trends/monthly                       — multi-month category spending
- GET /api/trends/monthly/{year}/{month}        — single month detail with per-store breakdown
- GET /api/trends/stores                        — spending by store
- GET /api/trends/summary                       — dashboard stats
"""
import pytest
from httpx import ASGITransport, AsyncClient


# ── Helpers ──────────────────────────────────────────────────────────────────

async def insert_receipt(db, *, store_name="TestMart", receipt_date="2026-02-15",
                         status="verified", total=50.00):
    cur = await db.execute(
        """INSERT INTO receipts (store_name, receipt_date, status, total, total_verified)
           VALUES (?, ?, ?, ?, 1)""",
        (store_name, receipt_date, status, total),
    )
    await db.commit()
    return cur.lastrowid


async def insert_item(db, receipt_id, *, raw_name="Item", clean_name="Item",
                      price=5.00, quantity=1.0, category="Produce"):
    cur = await db.execute(
        """INSERT INTO line_items
           (receipt_id, raw_name, clean_name, price, quantity, category)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (receipt_id, raw_name, clean_name, price, quantity, category),
    )
    await db.commit()
    return cur.lastrowid


async def insert_mapping(db, normalized_key, display_name, category):
    cur = await db.execute(
        """INSERT INTO item_mappings (normalized_key, display_name, category, source, times_seen)
           VALUES (?, ?, ?, 'ai', 1)""",
        (normalized_key, display_name, category),
    )
    await db.commit()
    return cur.lastrowid


# ── Fixture ──────────────────────────────────────────────────────────────────

@pytest.fixture
def app(db):
    from fastapi import FastAPI
    from routers.trends import router
    from db.database import get_db

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/trends")

    async def override_get_db():
        yield db
    test_app.dependency_overrides[get_db] = override_get_db
    return test_app


# ── GET /api/trends/monthly ─────────────────────────────────────────────────

class TestMonthlyTrends:

    @pytest.mark.asyncio
    async def test_empty_returns_empty(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly")

        assert resp.status_code == 200
        body = resp.json()
        assert body["months"] == []
        assert isinstance(body["categories"], list)

    @pytest.mark.asyncio
    async def test_returns_monthly_data(self, db, app):
        rid = await insert_receipt(db, receipt_date="2026-02-15")
        await insert_item(db, rid, price=10.00, category="Produce")
        await insert_item(db, rid, price=5.00, category="Dairy & Eggs")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly")

        body = resp.json()
        assert len(body["months"]) >= 1
        feb = body["months"][-1]
        assert feb["year"] == 2026
        assert feb["month"] == 2
        assert feb["total"] == 15.00
        assert feb["by_category"]["Produce"] == 10.00
        assert feb["by_category"]["Dairy & Eggs"] == 5.00

    @pytest.mark.asyncio
    async def test_zero_fills_missing_categories(self, db, app):
        rid = await insert_receipt(db, receipt_date="2026-02-15")
        await insert_item(db, rid, price=10.00, category="Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly")

        feb = resp.json()["months"][-1]
        # Categories with no spending should be 0
        assert feb["by_category"].get("Frozen", 0) == 0.0

    @pytest.mark.asyncio
    async def test_excludes_unverified_receipts(self, db, app):
        rid = await insert_receipt(db, receipt_date="2026-02-15", status="pending")
        await insert_item(db, rid, price=10.00, category="Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly")

        assert resp.json()["months"] == []

    @pytest.mark.asyncio
    async def test_months_param(self, db, app):
        """Requesting 1 month should only include recent data."""
        rid = await insert_receipt(db, receipt_date="2026-02-15")
        await insert_item(db, rid, price=10.00, category="Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly", params={"months": 1})

        body = resp.json()
        assert len(body["months"]) <= 1

    @pytest.mark.asyncio
    async def test_month_label_format(self, db, app):
        rid = await insert_receipt(db, receipt_date="2026-02-15")
        await insert_item(db, rid, price=10.00, category="Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly")

        feb = resp.json()["months"][-1]
        assert feb["month_label"] == "Feb 2026"


# ── GET /api/trends/monthly/{year}/{month} ──────────────────────────────────

class TestSingleMonth:

    @pytest.mark.asyncio
    async def test_returns_breakdown(self, db, app):
        rid = await insert_receipt(db, receipt_date="2026-02-15", store_name="Costco")
        await insert_item(db, rid, price=20.00, category="Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly/2026/2")

        assert resp.status_code == 200
        body = resp.json()
        assert body["year"] == 2026
        assert body["month"] == 2
        assert len(body["breakdown"]) == 1
        assert body["breakdown"][0]["category"] == "Produce"
        assert body["breakdown"][0]["store_name"] == "Costco"

    @pytest.mark.asyncio
    async def test_empty_month(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly/2026/6")

        assert resp.status_code == 200
        assert resp.json()["breakdown"] == []

    @pytest.mark.asyncio
    async def test_per_store_grouping(self, db, app):
        rid1 = await insert_receipt(db, receipt_date="2026-02-10", store_name="Costco")
        rid2 = await insert_receipt(db, receipt_date="2026-02-20", store_name="H-E-B")
        await insert_item(db, rid1, price=15.00, category="Produce")
        await insert_item(db, rid2, price=10.00, category="Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly/2026/2")

        breakdown = resp.json()["breakdown"]
        stores = {r["store_name"] for r in breakdown}
        assert "Costco" in stores
        assert "H-E-B" in stores

    @pytest.mark.asyncio
    async def test_ordered_by_total_desc(self, db, app):
        rid = await insert_receipt(db, receipt_date="2026-02-15")
        await insert_item(db, rid, price=5.00, category="Snacks")
        await insert_item(db, rid, price=20.00, category="Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/monthly/2026/2")

        breakdown = resp.json()["breakdown"]
        totals = [r["total"] for r in breakdown]
        assert totals == sorted(totals, reverse=True)


# ── GET /api/trends/stores ──────────────────────────────────────────────────

class TestStoreBreakdown:

    @pytest.mark.asyncio
    async def test_empty(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/stores")

        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_returns_store_data(self, db, app):
        await insert_receipt(db, store_name="Costco", receipt_date="2026-02-15", total=100.00)
        await insert_receipt(db, store_name="Costco", receipt_date="2026-02-20", total=80.00)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/stores")

        data = resp.json()
        assert len(data) == 1
        assert data[0]["store_name"] == "Costco"
        assert data[0]["receipt_count"] == 2
        assert data[0]["total_spent"] == 180.00
        assert data[0]["avg_trip"] == 90.00

    @pytest.mark.asyncio
    async def test_ordered_by_total_desc(self, db, app):
        await insert_receipt(db, store_name="SmallShop", receipt_date="2026-02-15", total=20.00)
        await insert_receipt(db, store_name="BigStore", receipt_date="2026-02-15", total=200.00)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/stores")

        data = resp.json()
        assert data[0]["store_name"] == "BigStore"
        assert data[1]["store_name"] == "SmallShop"

    @pytest.mark.asyncio
    async def test_excludes_pending_receipts(self, db, app):
        await insert_receipt(db, store_name="Pending", receipt_date="2026-02-15",
                             total=50.00, status="pending")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/stores")

        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_months_param(self, db, app):
        # Old receipt outside 1-month window
        await insert_receipt(db, store_name="OldStore", receipt_date="2025-01-15", total=50.00)
        # Recent receipt
        await insert_receipt(db, store_name="NewStore", receipt_date="2026-02-15", total=50.00)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/stores", params={"months": 1})

        stores = [r["store_name"] for r in resp.json()]
        assert "NewStore" in stores
        assert "OldStore" not in stores


# ── GET /api/trends/summary ─────────────────────────────────────────────────

class TestDashboardSummary:

    @pytest.mark.asyncio
    async def test_empty_db_returns_zeros(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/summary")

        assert resp.status_code == 200
        body = resp.json()
        assert body["month_total"] == 0
        assert body["receipt_count"] == 0
        assert body["items_learned"] == 0
        assert body["avg_trip"] == 0

    @pytest.mark.asyncio
    async def test_receipt_count_all_statuses(self, db, app):
        """receipt_count includes all receipts (any status)."""
        await insert_receipt(db, status="verified")
        await insert_receipt(db, status="pending")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/summary")

        assert resp.json()["receipt_count"] == 2

    @pytest.mark.asyncio
    async def test_items_learned_count(self, db, app):
        await insert_mapping(db, "milk", "Milk", "Dairy & Eggs")
        await insert_mapping(db, "bread", "Bread", "Pantry")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/summary")

        assert resp.json()["items_learned"] == 2

    @pytest.mark.asyncio
    async def test_month_total_only_verified_current_month(self, db, app):
        """month_total sums only verified receipts from the current month."""
        # This month, verified
        await insert_receipt(db, receipt_date="2026-02-15", total=100.00, status="verified")
        # This month, pending (should not count)
        await insert_receipt(db, receipt_date="2026-02-20", total=50.00, status="pending")
        # Last month, verified (should not count)
        await insert_receipt(db, receipt_date="2026-01-15", total=75.00, status="verified")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/summary")

        assert resp.json()["month_total"] == 100.00

    @pytest.mark.asyncio
    async def test_response_schema(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/trends/summary")

        body = resp.json()
        assert "month_total" in body
        assert "receipt_count" in body
        assert "items_learned" in body
        assert "avg_trip" in body
