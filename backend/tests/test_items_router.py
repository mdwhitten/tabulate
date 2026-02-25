"""
Tests for the items router — category updates and mapping management.

Covers:
- PATCH /api/items/{item_id}/category          — update line item category
- PATCH /api/items/mappings/{mapping_id}/category — update mapping category
- GET   /api/items/mappings                    — list learned mappings with pagination/search
- GET   /api/items/categories                  — list all category names
"""
import pytest
from httpx import ASGITransport, AsyncClient


# ── Helpers ──────────────────────────────────────────────────────────────────

async def insert_receipt(db, status="verified"):
    cur = await db.execute(
        "INSERT INTO receipts (store_name, status) VALUES ('TestMart', ?)", (status,)
    )
    await db.commit()
    return cur.lastrowid


async def insert_item(db, receipt_id, *, raw_name="ITEM", clean_name="Item",
                      price=5.00, category="Produce", category_source="ai"):
    cur = await db.execute(
        """INSERT INTO line_items
           (receipt_id, raw_name, clean_name, price, quantity, category, category_source)
           VALUES (?, ?, ?, ?, 1, ?, ?)""",
        (receipt_id, raw_name, clean_name, price, category, category_source),
    )
    await db.commit()
    return cur.lastrowid


async def insert_mapping(db, normalized_key="milk", display_name="Milk",
                         category="Dairy & Eggs", source="ai"):
    cur = await db.execute(
        """INSERT INTO item_mappings (normalized_key, display_name, category, source, times_seen)
           VALUES (?, ?, ?, ?, 1)""",
        (normalized_key, display_name, category, source),
    )
    await db.commit()
    return cur.lastrowid


# ── Fixture ──────────────────────────────────────────────────────────────────

@pytest.fixture
def app(db):
    from fastapi import FastAPI
    from routers.items import router
    from db.database import get_db

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/items")

    async def override_get_db():
        yield db
    test_app.dependency_overrides[get_db] = override_get_db
    return test_app


# ── PATCH /api/items/{item_id}/category ─────────────────────────────────────

class TestUpdateItemCategory:

    @pytest.mark.asyncio
    async def test_update_category_success(self, db, app):
        rid = await insert_receipt(db)
        iid = await insert_item(db, rid, category="Other")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(
                f"/api/items/{iid}/category",
                json={"category": "Produce"},
            )

        assert resp.status_code == 200
        assert resp.json()["category"] == "Produce"

    @pytest.mark.asyncio
    async def test_update_sets_manual_source(self, db, app):
        rid = await insert_receipt(db)
        iid = await insert_item(db, rid, category="Other", category_source="ai")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.patch(f"/api/items/{iid}/category", json={"category": "Produce"})

        async with db.execute(
            "SELECT category_source, corrected FROM line_items WHERE id = ?", (iid,)
        ) as cur:
            row = await cur.fetchone()
        assert row["category_source"] == "manual"
        assert row["corrected"] == 1

    @pytest.mark.asyncio
    async def test_update_persists_mapping_immediately(self, db, app):
        """On already-approved receipts, mapping is saved immediately."""
        rid = await insert_receipt(db, status="verified")
        iid = await insert_item(db, rid, raw_name="ORGANIC MILK", clean_name="Organic Milk")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.patch(f"/api/items/{iid}/category", json={"category": "Dairy & Eggs"})

        async with db.execute("SELECT * FROM item_mappings") as cur:
            rows = await cur.fetchall()
        assert len(rows) == 1
        assert rows[0]["category"] == "Dairy & Eggs"
        assert rows[0]["source"] == "manual"

    @pytest.mark.asyncio
    async def test_invalid_category_returns_422(self, db, app):
        rid = await insert_receipt(db)
        iid = await insert_item(db, rid)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(
                f"/api/items/{iid}/category",
                json={"category": "NonexistentCategory"},
            )

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_nonexistent_item_returns_404(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(
                "/api/items/99999/category",
                json={"category": "Produce"},
            )

        assert resp.status_code == 404


# ── PATCH /api/items/mappings/{id}/category ─────────────────────────────────

class TestUpdateMappingCategory:

    @pytest.mark.asyncio
    async def test_update_mapping_category(self, db, app):
        mid = await insert_mapping(db, category="Other")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(
                f"/api/items/mappings/{mid}/category",
                json={"category": "Dairy & Eggs"},
            )

        assert resp.status_code == 200
        assert resp.json()["category"] == "Dairy & Eggs"

    @pytest.mark.asyncio
    async def test_update_sets_manual_source(self, db, app):
        mid = await insert_mapping(db, source="ai")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.patch(
                f"/api/items/mappings/{mid}/category",
                json={"category": "Produce"},
            )

        async with db.execute(
            "SELECT source FROM item_mappings WHERE id = ?", (mid,)
        ) as cur:
            row = await cur.fetchone()
        assert row["source"] == "manual"

    @pytest.mark.asyncio
    async def test_invalid_category_returns_422(self, db, app):
        mid = await insert_mapping(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(
                f"/api/items/mappings/{mid}/category",
                json={"category": "Fake"},
            )

        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_nonexistent_mapping_returns_404(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(
                "/api/items/mappings/99999/category",
                json={"category": "Produce"},
            )

        assert resp.status_code == 404


# ── GET /api/items/mappings ─────────────────────────────────────────────────

class TestListMappings:

    @pytest.mark.asyncio
    async def test_empty_list(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/mappings")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 0
        assert body["items"] == []

    @pytest.mark.asyncio
    async def test_returns_mappings(self, db, app):
        await insert_mapping(db, "milk", "Milk", "Dairy & Eggs")
        await insert_mapping(db, "bread", "Bread", "Pantry")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/mappings")

        body = resp.json()
        assert body["total"] == 2
        assert len(body["items"]) == 2

    @pytest.mark.asyncio
    async def test_pagination_limit(self, db, app):
        for i in range(5):
            await insert_mapping(db, f"item{i}", f"Item {i}", "Other")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/mappings", params={"limit": 2})

        body = resp.json()
        assert body["total"] == 5
        assert len(body["items"]) == 2

    @pytest.mark.asyncio
    async def test_pagination_offset(self, db, app):
        for i in range(5):
            await insert_mapping(db, f"item{i}", f"Item {i}", "Other")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/mappings", params={"limit": 50, "offset": 3})

        body = resp.json()
        assert len(body["items"]) == 2

    @pytest.mark.asyncio
    async def test_search_by_display_name(self, db, app):
        await insert_mapping(db, "milk", "Organic Milk", "Dairy & Eggs")
        await insert_mapping(db, "bread", "Wheat Bread", "Pantry")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/mappings", params={"search": "Milk"})

        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["display_name"] == "Organic Milk"

    @pytest.mark.asyncio
    async def test_filter_by_category(self, db, app):
        await insert_mapping(db, "milk", "Milk", "Dairy & Eggs")
        await insert_mapping(db, "bread", "Bread", "Pantry")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/mappings", params={"category": "Pantry"})

        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["category"] == "Pantry"

    @pytest.mark.asyncio
    async def test_combined_search_and_category_filter(self, db, app):
        await insert_mapping(db, "wholemilk", "Whole Milk", "Dairy & Eggs")
        await insert_mapping(db, "almond milk", "Almond Milk", "Beverages")
        await insert_mapping(db, "bread", "Bread", "Pantry")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/mappings", params={
                "search": "Milk", "category": "Dairy & Eggs"
            })

        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["display_name"] == "Whole Milk"

    @pytest.mark.asyncio
    async def test_response_schema(self, db, app):
        await insert_mapping(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/mappings")

        item = resp.json()["items"][0]
        for field in ("id", "normalized_key", "display_name", "category",
                       "source", "times_seen", "last_seen", "created_at"):
            assert field in item


# ── GET /api/items/categories ────────────────────────────────────────────────

class TestListItemCategories:

    @pytest.mark.asyncio
    async def test_returns_category_names(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/categories")

        assert resp.status_code == 200
        cats = resp.json()
        assert "Produce" in cats
        assert "Other" in cats

    @pytest.mark.asyncio
    async def test_excludes_disabled_categories(self, db, app):
        """Disabled categories should not appear."""
        await db.execute(
            "UPDATE categories SET is_disabled = 1 WHERE name = 'Frozen'"
        )
        await db.commit()

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/items/categories")

        assert "Frozen" not in resp.json()
