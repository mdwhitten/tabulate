"""
Tests for the YNAB router — status, config get/put, dropdown proxies, and
manual receipt sync. Service-level HTTP and sync are mocked.
"""
import pytest
from unittest.mock import patch, AsyncMock
from httpx import ASGITransport, AsyncClient

from services import ynab_service


@pytest.fixture
def app(db):
    from fastapi import FastAPI
    from routers.ynab import router
    from db.database import get_db

    test_app = FastAPI()
    test_app.include_router(router, prefix="/api/ynab")

    async def override_get_db():
        yield db
    test_app.dependency_overrides[get_db] = override_get_db
    return test_app


def client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def cat_id(db, name):
    async with db.execute("SELECT id FROM categories WHERE name = ?", (name,)) as cur:
        row = await cur.fetchone()
    return row["id"]


# ── status / config ──────────────────────────────────────────────────────────

class TestConfigEndpoints:

    @pytest.mark.asyncio
    async def test_status_defaults(self, db, app):
        async with client(app) as c:
            resp = await c.get("/api/ynab/status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["enabled"] is False
        assert body["configured"] is False

    @pytest.mark.asyncio
    async def test_put_then_get_config(self, db, app):
        pid = await cat_id(db, "Produce")
        payload = {
            "enabled": True,
            "budget_id": "b1",
            "account_id": "a1",
            "default_category_id": "ycat-default",
            "mappings": [{"category_id": pid, "ynab_category_id": "ycat-prod"}],
        }
        async with client(app) as c:
            put = await c.put("/api/ynab/config", json=payload)
            assert put.status_code == 200
            get = await c.get("/api/ynab/config")

        cfg = get.json()
        assert cfg["enabled"] is True
        assert cfg["budget_id"] == "b1"
        assert cfg["configured"] is True
        assert cfg["mappings"] == [{"category_id": pid, "ynab_category_id": "ycat-prod"}]


# ── proxy endpoints ──────────────────────────────────────────────────────────

class TestProxies:

    @pytest.mark.asyncio
    async def test_budgets(self, db, app):
        with patch.object(
            ynab_service, "list_budgets", new_callable=AsyncMock,
            return_value=[{"id": "b1", "name": "My Budget"}],
        ):
            async with client(app) as c:
                resp = await c.get("/api/ynab/budgets")
        assert resp.status_code == 200
        assert resp.json() == [{"id": "b1", "name": "My Budget"}]

    @pytest.mark.asyncio
    async def test_budgets_error_maps_to_502(self, db, app):
        with patch.object(
            ynab_service, "list_budgets", new_callable=AsyncMock,
            side_effect=ynab_service.YnabError("no token"),
        ):
            async with client(app) as c:
                resp = await c.get("/api/ynab/budgets")
        assert resp.status_code == 502
        assert "no token" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_categories_proxy(self, db, app):
        groups = [{"id": "g1", "name": "Monthly", "categories": [{"id": "c1", "name": "Groceries"}]}]
        with patch.object(
            ynab_service, "list_categories", new_callable=AsyncMock, return_value=groups,
        ):
            async with client(app) as c:
                resp = await c.get("/api/ynab/budgets/b1/categories")
        assert resp.status_code == 200
        assert resp.json() == groups


# ── sync ─────────────────────────────────────────────────────────────────────

class TestSyncEndpoint:

    @pytest.mark.asyncio
    async def test_sync_missing_receipt_404(self, db, app):
        async with client(app) as c:
            resp = await c.post("/api/ynab/receipts/999/sync")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_sync_calls_service(self, db, app):
        cur = await db.execute(
            "INSERT INTO receipts (store_name, receipt_date, total, status) "
            "VALUES ('Mart', '2026-07-01', 10.0, 'verified')"
        )
        await db.commit()
        rid = cur.lastrowid
        with patch.object(
            ynab_service, "sync_receipt", new_callable=AsyncMock,
            return_value={"status": "synced", "transaction_id": "t1"},
        ) as mock_sync:
            async with client(app) as c:
                resp = await c.post(f"/api/ynab/receipts/{rid}/sync")
        assert resp.status_code == 200
        assert resp.json()["status"] == "synced"
        mock_sync.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_sync_error_maps_to_502(self, db, app):
        cur = await db.execute(
            "INSERT INTO receipts (store_name, status) VALUES ('Mart', 'verified')"
        )
        await db.commit()
        rid = cur.lastrowid
        with patch.object(
            ynab_service, "sync_receipt", new_callable=AsyncMock,
            side_effect=ynab_service.YnabError("api down"),
        ):
            async with client(app) as c:
                resp = await c.post(f"/api/ynab/receipts/{rid}/sync")
        assert resp.status_code == 502
