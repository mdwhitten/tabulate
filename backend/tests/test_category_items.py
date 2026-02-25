"""
Tests for GET /api/trends/monthly/{year}/{month}/items?category=X
— category item drill-down for trends view.
"""
import pytest
from httpx import ASGITransport, AsyncClient


# ── Helpers ──────────────────────────────────────────────────────────────────

async def insert_receipt(db, *, store_name="TestMart", receipt_date="2026-02-15",
                         status="verified", total=50.00):
    """Insert a receipt and return its id."""
    cur = await db.execute(
        """INSERT INTO receipts (store_name, receipt_date, status, total)
           VALUES (?, ?, ?, ?)""",
        (store_name, receipt_date, status, total),
    )
    await db.commit()
    return cur.lastrowid


async def insert_item(db, receipt_id, *, raw_name="Item", clean_name="Item",
                      price=5.00, quantity=1.0, category="Produce"):
    """Insert a line item and return its id."""
    cur = await db.execute(
        """INSERT INTO line_items (receipt_id, raw_name, clean_name, price, quantity, category)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (receipt_id, raw_name, clean_name, price, quantity, category),
    )
    await db.commit()
    return cur.lastrowid


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def app(db):
    """Create a FastAPI app with the trends router, wired to the test DB."""
    from fastapi import FastAPI
    from routers.trends import router

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/trends")

    from db.database import get_db
    async def override_get_db():
        yield db
    test_app.dependency_overrides[get_db] = override_get_db

    return test_app


# ── Tests ────────────────────────────────────────────────────────────────────

class TestCategoryItemsEndpoint:

    @pytest.mark.asyncio
    async def test_returns_items_for_category_and_month(self, db, app):
        """Returns matching items with correct fields."""
        rid = await insert_receipt(db, receipt_date="2026-02-10", store_name="ShopA")
        await insert_item(db, rid, clean_name="Chicken Breast", raw_name="CHKN BRST",
                          price=12.99, quantity=2, category="Meat & Seafood")
        await insert_item(db, rid, clean_name="Salmon", raw_name="SALMON",
                          price=14.50, category="Meat & Seafood")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/trends/monthly/2026/2/items",
                params={"category": "Meat & Seafood"},
            )

        assert resp.status_code == 200
        items = resp.json()
        assert len(items) == 2

        # Check fields on first item
        first = items[0]
        assert "clean_name" in first
        assert "raw_name" in first
        assert "price" in first
        assert "quantity" in first
        assert "store_name" in first
        assert "receipt_date" in first

    @pytest.mark.asyncio
    async def test_excludes_unverified_receipts(self, db, app):
        """Items on pending/review receipts should not appear."""
        rid = await insert_receipt(db, receipt_date="2026-02-10", status="pending")
        await insert_item(db, rid, category="Produce", clean_name="Apples")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/trends/monthly/2026/2/items",
                params={"category": "Produce"},
            )

        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_excludes_other_categories(self, db, app):
        """Only items matching the requested category are returned."""
        rid = await insert_receipt(db, receipt_date="2026-02-10")
        await insert_item(db, rid, clean_name="Milk", category="Dairy & Eggs", price=4.99)
        await insert_item(db, rid, clean_name="Apples", category="Produce", price=3.50)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/trends/monthly/2026/2/items",
                params={"category": "Dairy & Eggs"},
            )

        items = resp.json()
        assert len(items) == 1
        assert items[0]["clean_name"] == "Milk"

    @pytest.mark.asyncio
    async def test_excludes_other_months(self, db, app):
        """Items from a different month should not appear."""
        rid_jan = await insert_receipt(db, receipt_date="2026-01-15")
        rid_feb = await insert_receipt(db, receipt_date="2026-02-15")
        await insert_item(db, rid_jan, clean_name="January Item", category="Produce")
        await insert_item(db, rid_feb, clean_name="February Item", category="Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/trends/monthly/2026/2/items",
                params={"category": "Produce"},
            )

        items = resp.json()
        assert len(items) == 1
        assert items[0]["clean_name"] == "February Item"

    @pytest.mark.asyncio
    async def test_empty_result(self, db, app):
        """Querying a month/category with no data returns empty list."""
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/trends/monthly/2026/6/items",
                params={"category": "Produce"},
            )

        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_orders_by_price_desc(self, db, app):
        """Items should be ordered by price * quantity descending."""
        rid = await insert_receipt(db, receipt_date="2026-02-10")
        await insert_item(db, rid, clean_name="Cheap", category="Produce", price=2.00, quantity=1)
        await insert_item(db, rid, clean_name="Expensive", category="Produce", price=10.00, quantity=1)
        await insert_item(db, rid, clean_name="Mid Bulk", category="Produce", price=3.00, quantity=3)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/trends/monthly/2026/2/items",
                params={"category": "Produce"},
            )

        items = resp.json()
        assert len(items) == 3
        # $10, $9 (3x$3), $2
        assert items[0]["clean_name"] == "Expensive"
        assert items[1]["clean_name"] == "Mid Bulk"
        assert items[2]["clean_name"] == "Cheap"
