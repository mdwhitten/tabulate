"""
Tests for DELETE /api/items/mappings/{mapping_id} — deleting learned mapping rules.
"""
import pytest
from httpx import ASGITransport, AsyncClient


# ── Helper ────────────────────────────────────────────────────────────────────

async def insert_mapping(db, normalized_key="milk", display_name="Milk",
                         category="Dairy & Eggs", source="manual"):
    """Insert a mapping and return its id."""
    cur = await db.execute(
        """INSERT INTO item_mappings (normalized_key, display_name, category, source, times_seen)
           VALUES (?, ?, ?, ?, 1)""",
        (normalized_key, display_name, category, source),
    )
    await db.commit()
    return cur.lastrowid


async def count_mappings(db):
    async with db.execute("SELECT COUNT(*) FROM item_mappings") as cur:
        return (await cur.fetchone())[0]


async def get_mapping_by_id(db, mapping_id):
    async with db.execute("SELECT * FROM item_mappings WHERE id = ?", (mapping_id,)) as cur:
        return await cur.fetchone()


# ── Direct DB tests ──────────────────────────────────────────────────────────

class TestDeleteMappingDB:
    @pytest.mark.asyncio
    async def test_delete_removes_mapping(self, db):
        """Deleting a mapping removes it from the database."""
        mid = await insert_mapping(db)
        assert await get_mapping_by_id(db, mid) is not None

        await db.execute("DELETE FROM item_mappings WHERE id = ?", (mid,))
        await db.commit()

        assert await get_mapping_by_id(db, mid) is None

    @pytest.mark.asyncio
    async def test_delete_only_affects_target(self, db):
        """Deleting one mapping leaves others untouched."""
        mid1 = await insert_mapping(db, "milk", "Milk", "Dairy & Eggs")
        mid2 = await insert_mapping(db, "bread", "Bread", "Pantry")
        assert await count_mappings(db) == 2

        await db.execute("DELETE FROM item_mappings WHERE id = ?", (mid1,))
        await db.commit()

        assert await get_mapping_by_id(db, mid1) is None
        assert await get_mapping_by_id(db, mid2) is not None
        assert await count_mappings(db) == 1


# ── API endpoint tests ───────────────────────────────────────────────────────

@pytest.fixture
def app(db):
    """Create a FastAPI app with the items router, wired to the test DB."""
    from fastapi import FastAPI
    from routers.items import router

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/items")

    # Override the DB dependency to use our in-memory test DB
    from db.database import get_db
    async def override_get_db():
        yield db
    test_app.dependency_overrides[get_db] = override_get_db

    return test_app


class TestDeleteMappingEndpoint:
    @pytest.mark.asyncio
    async def test_delete_returns_200(self, db, app):
        mid = await insert_mapping(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.delete(f"/api/items/mappings/{mid}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "deleted"
        assert body["mapping_id"] == mid

    @pytest.mark.asyncio
    async def test_delete_actually_removes_from_db(self, db, app):
        mid = await insert_mapping(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.delete(f"/api/items/mappings/{mid}")

        assert await get_mapping_by_id(db, mid) is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_returns_404(self, db, app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.delete("/api/items/mappings/99999")

        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_is_idempotent_second_call_404(self, db, app):
        """Deleting the same mapping twice: first succeeds, second returns 404."""
        mid = await insert_mapping(db)

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp1 = await client.delete(f"/api/items/mappings/{mid}")
            assert resp1.status_code == 200

            resp2 = await client.delete(f"/api/items/mappings/{mid}")
            assert resp2.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_one_leaves_others(self, db, app):
        """Deleting one mapping doesn't affect others."""
        mid1 = await insert_mapping(db, "milk", "Milk", "Dairy & Eggs")
        mid2 = await insert_mapping(db, "bread", "Bread", "Pantry")

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.delete(f"/api/items/mappings/{mid1}")

        assert await get_mapping_by_id(db, mid1) is None
        row = await get_mapping_by_id(db, mid2)
        assert row is not None
        assert row["display_name"] == "Bread"
