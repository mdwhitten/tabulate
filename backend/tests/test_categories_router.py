"""
Tests for the categories router — CRUD operations on the categories table.

Covers:
- GET    /api/categories              — list all categories
- POST   /api/categories              — create a new custom category
- PATCH  /api/categories/{id}         — rename / recolor / disable a category
- DELETE /api/categories/{id}         — delete a custom category
"""
import pytest
from httpx import ASGITransport, AsyncClient


# ── Helpers ──────────────────────────────────────────────────────────────────

async def insert_custom_category(db, name="Bakery", color="#d4a017", icon="🍞"):
    cur = await db.execute(
        """INSERT INTO categories (name, color, icon, is_builtin, sort_order)
           VALUES (?, ?, ?, 0, 200)""",
        (name, color, icon),
    )
    await db.commit()
    return cur.lastrowid


async def get_builtin_id(db, name="Produce"):
    async with db.execute(
        "SELECT id FROM categories WHERE name = ? AND is_builtin = 1", (name,)
    ) as cur:
        row = await cur.fetchone()
    return row["id"] if row else None


async def insert_receipt_with_items(db, category="Bakery"):
    """Insert a receipt + line item + mapping using the given category."""
    cur = await db.execute(
        "INSERT INTO receipts (store_name, status) VALUES ('Test', 'verified')"
    )
    rid = cur.lastrowid
    await db.execute(
        "INSERT INTO line_items (receipt_id, raw_name, price, category) VALUES (?, 'bread', 5.00, ?)",
        (rid, category),
    )
    await db.execute(
        "INSERT INTO item_mappings (normalized_key, display_name, category, source) VALUES ('bread', 'Bread', ?, 'ai')",
        (category,),
    )
    await db.commit()
    return rid


# ── Fixture ──────────────────────────────────────────────────────────────────

@pytest.fixture
def app(db):
    from fastapi import FastAPI
    from routers.categories import router
    from db.database import get_db

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/categories")

    async def override_get_db():
        yield db
    test_app.dependency_overrides[get_db] = override_get_db
    return test_app


# ── GET /api/categories ─────────────────────────────────────────────────────

class TestListCategories:

    @pytest.mark.asyncio
    async def test_returns_builtin_categories(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/categories")

        assert resp.status_code == 200
        cats = resp.json()
        names = [c["name"] for c in cats]
        assert "Produce" in names
        assert "Other" in names

    @pytest.mark.asyncio
    async def test_includes_custom_categories(self, db, app):
        await insert_custom_category(db, "Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/categories")

        names = [c["name"] for c in resp.json()]
        assert "Bakery" in names

    @pytest.mark.asyncio
    async def test_ordered_by_sort_order(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/categories")

        cats = resp.json()
        orders = [c["sort_order"] for c in cats]
        assert orders == sorted(orders)

    @pytest.mark.asyncio
    async def test_response_schema(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/categories")

        cat = resp.json()[0]
        assert "id" in cat
        assert "name" in cat
        assert "color" in cat
        assert "icon" in cat
        assert "is_builtin" in cat
        assert "is_disabled" in cat
        assert "sort_order" in cat
        assert "created_at" in cat


# ── POST /api/categories ────────────────────────────────────────────────────

class TestCreateCategory:

    @pytest.mark.asyncio
    async def test_create_returns_201(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/categories", json={
                "name": "Bakery", "color": "#d4a017", "icon": "🍞"
            })

        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Bakery"
        assert body["is_builtin"] is False

    @pytest.mark.asyncio
    async def test_create_auto_increments_sort_order(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/categories", json={"name": "Bakery"})

        body = resp.json()
        # Built-in max sort_order is 90 (Other), so custom should be 100
        assert body["sort_order"] == 100

    @pytest.mark.asyncio
    async def test_create_duplicate_returns_409(self, db, app):
        await insert_custom_category(db, "Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/categories", json={"name": "Bakery"})

        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_create_duplicate_case_insensitive(self, db, app):
        await insert_custom_category(db, "Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/categories", json={"name": "bakery"})

        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_create_with_defaults(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.post("/api/categories", json={"name": "Test Cat"})

        assert resp.status_code == 201
        body = resp.json()
        assert body["color"] == "#8a7d6b"  # default
        assert body["icon"] == "🏷️"       # default


# ── PATCH /api/categories/{id} ──────────────────────────────────────────────

class TestUpdateCategory:

    @pytest.mark.asyncio
    async def test_rename_custom_category(self, db, app):
        cid = await insert_custom_category(db, "Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(f"/api/categories/{cid}", json={"name": "Bread & Bakery"})

        assert resp.status_code == 200
        assert resp.json()["name"] == "Bread & Bakery"

    @pytest.mark.asyncio
    async def test_rename_cascades_to_line_items(self, db, app):
        cid = await insert_custom_category(db, "Bakery")
        await insert_receipt_with_items(db, category="Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.patch(f"/api/categories/{cid}", json={"name": "Bread"})

        async with db.execute("SELECT category FROM line_items WHERE raw_name = 'bread'") as cur:
            row = await cur.fetchone()
        assert row["category"] == "Bread"

    @pytest.mark.asyncio
    async def test_rename_cascades_to_item_mappings(self, db, app):
        cid = await insert_custom_category(db, "Bakery")
        await insert_receipt_with_items(db, category="Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.patch(f"/api/categories/{cid}", json={"name": "Bread"})

        async with db.execute("SELECT category FROM item_mappings WHERE normalized_key = 'bread'") as cur:
            row = await cur.fetchone()
        assert row["category"] == "Bread"

    @pytest.mark.asyncio
    async def test_rename_builtin_returns_403(self, db, app):
        pid = await get_builtin_id(db, "Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(f"/api/categories/{pid}", json={"name": "Veggies"})

        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_disable_builtin_allowed(self, db, app):
        pid = await get_builtin_id(db, "Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(f"/api/categories/{pid}", json={"is_disabled": True})

        assert resp.status_code == 200
        assert resp.json()["is_disabled"] is True

    @pytest.mark.asyncio
    async def test_rename_to_existing_returns_409(self, db, app):
        cid = await insert_custom_category(db, "Bakery")
        await insert_custom_category(db, "Deli")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(f"/api/categories/{cid}", json={"name": "Deli"})

        assert resp.status_code == 409

    @pytest.mark.asyncio
    async def test_update_nonexistent_returns_404(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch("/api/categories/99999", json={"name": "X"})

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_update_color_only(self, db, app):
        cid = await insert_custom_category(db, "Bakery", color="#000000")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.patch(f"/api/categories/{cid}", json={"color": "#ff0000"})

        assert resp.status_code == 200
        assert resp.json()["color"] == "#ff0000"
        assert resp.json()["name"] == "Bakery"  # unchanged


# ── DELETE /api/categories/{id} ──────────────────────────────────────────────

class TestDeleteCategory:

    @pytest.mark.asyncio
    async def test_delete_custom_category(self, db, app):
        cid = await insert_custom_category(db, "Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.delete(f"/api/categories/{cid}")

        assert resp.status_code == 200
        assert resp.json()["status"] == "deleted"
        assert resp.json()["reassigned_to"] == "Other"

    @pytest.mark.asyncio
    async def test_delete_reassigns_line_items_to_other(self, db, app):
        cid = await insert_custom_category(db, "Bakery")
        await insert_receipt_with_items(db, category="Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.delete(f"/api/categories/{cid}")

        async with db.execute("SELECT category FROM line_items WHERE raw_name = 'bread'") as cur:
            row = await cur.fetchone()
        assert row["category"] == "Other"

    @pytest.mark.asyncio
    async def test_delete_reassigns_mappings_to_other(self, db, app):
        cid = await insert_custom_category(db, "Bakery")
        await insert_receipt_with_items(db, category="Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.delete(f"/api/categories/{cid}")

        async with db.execute("SELECT category FROM item_mappings WHERE normalized_key = 'bread'") as cur:
            row = await cur.fetchone()
        assert row["category"] == "Other"

    @pytest.mark.asyncio
    async def test_delete_builtin_returns_403(self, db, app):
        pid = await get_builtin_id(db, "Produce")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.delete(f"/api/categories/{pid}")

        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_delete_nonexistent_returns_404(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.delete("/api/categories/99999")

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_removes_from_categories_table(self, db, app):
        cid = await insert_custom_category(db, "Bakery")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.delete(f"/api/categories/{cid}")

        async with db.execute("SELECT id FROM categories WHERE id = ?", (cid,)) as cur:
            assert await cur.fetchone() is None
