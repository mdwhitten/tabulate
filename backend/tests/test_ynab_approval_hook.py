"""
Tests for the YNAB sync hook in the receipt save/approve flow.

Verifies the integration is opt-in and non-blocking:
  - approving a receipt triggers ynab_service.sync_receipt
  - a sync failure never fails the receipt save
  - a non-approving (draft) save does not trigger sync
"""
import os
import sys
import pytest
from unittest.mock import patch, AsyncMock
from httpx import ASGITransport, AsyncClient

from services import ynab_service


async def insert_receipt(db, *, status="pending", receipt_date="2026-07-01"):
    cur = await db.execute(
        "INSERT INTO receipts (store_name, receipt_date, status, total) "
        "VALUES ('Mart', ?, ?, 10.0)",
        (receipt_date, status),
    )
    await db.execute(
        "INSERT INTO line_items (receipt_id, raw_name, price, category, category_source) "
        "VALUES (?, 'apple', 10.0, 'Produce', 'ai')",
        (cur.lastrowid,),
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


def client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


class TestApprovalHook:

    @pytest.mark.asyncio
    async def test_approve_triggers_sync(self, db, app):
        rid = await insert_receipt(db)
        with patch.object(
            ynab_service, "sync_receipt", new_callable=AsyncMock,
            return_value={"status": "synced"},
        ) as mock_sync:
            async with client(app) as c:
                resp = await c.post(f"/api/receipts/{rid}/save", json={"approve": True})
        assert resp.status_code == 200
        mock_sync.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_sync_failure_does_not_fail_save(self, db, app):
        rid = await insert_receipt(db)
        with patch.object(
            ynab_service, "sync_receipt", new_callable=AsyncMock,
            side_effect=ynab_service.YnabError("api down"),
        ):
            async with client(app) as c:
                resp = await c.post(f"/api/receipts/{rid}/save", json={"approve": True})
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
        # Receipt is still marked verified despite the sync failure
        async with db.execute("SELECT status FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["status"] == "verified"

    @pytest.mark.asyncio
    async def test_draft_save_does_not_sync(self, db, app):
        rid = await insert_receipt(db)
        with patch.object(
            ynab_service, "sync_receipt", new_callable=AsyncMock,
        ) as mock_sync:
            async with client(app) as c:
                resp = await c.post(f"/api/receipts/{rid}/save", json={"approve": False})
        assert resp.status_code == 200
        mock_sync.assert_not_awaited()
