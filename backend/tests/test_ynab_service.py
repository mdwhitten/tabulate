"""
Tests for the YNAB service — config storage, transaction building (split logic),
and receipt sync (create/update paths, skip conditions).

The YNAB HTTP layer (`_request`) is always mocked; no real network calls.
"""
import pytest
from unittest.mock import patch, AsyncMock

from services import ynab_service
from services.ynab_service import build_transaction_payload


# ── Helpers ──────────────────────────────────────────────────────────────────

async def insert_receipt(db, total=11.00, store="Mart", date="2026-07-01"):
    cur = await db.execute(
        "INSERT INTO receipts (store_name, receipt_date, total, status) VALUES (?, ?, ?, 'verified')",
        (store, date, total),
    )
    await db.commit()
    return cur.lastrowid


async def insert_item(db, rid, category, price, quantity=1):
    await db.execute(
        "INSERT INTO line_items (receipt_id, raw_name, price, quantity, category) VALUES (?, ?, ?, ?, ?)",
        (rid, category.lower(), price, quantity, category),
    )
    await db.commit()


async def cat_id(db, name):
    async with db.execute("SELECT id FROM categories WHERE name = ?", (name,)) as cur:
        row = await cur.fetchone()
    return row["id"]


async def configure(db, **overrides):
    cfg = {
        "enabled": True,
        "budget_id": "budget-1",
        "account_id": "account-1",
        "default_category_id": "ycat-default",
        "mappings": [],
    }
    cfg.update(overrides)
    await ynab_service.save_config(db, cfg)


# ── build_transaction_payload (pure) ─────────────────────────────────────────

class TestBuildPayload:

    def _receipt(self, total=11.00):
        return {"id": 1, "store_name": "Mart", "receipt_date": "2026-07-01", "total": total}

    def test_single_category_all_default(self):
        items = [{"category": "Snacks", "price": 5.0, "quantity": 1},
                 {"category": "Pantry", "price": 5.0, "quantity": 1}]
        # total == items sum, everything unmapped → single default transaction
        p = build_transaction_payload(self._receipt(10.0), items, "acct", "ycat-default", {})
        assert p["amount"] == -10000
        assert p["category_id"] == "ycat-default"
        assert "subtransactions" not in p
        assert p["approved"] is False
        assert p["cleared"] == "uncleared"
        assert p["payee_name"] == "Mart"

    def test_remainder_distributed_proportionally(self):
        items = [{"category": "Produce", "price": 3.0, "quantity": 1},
                 {"category": "Snacks", "price": 5.0, "quantity": 1}]
        # total 11 → $3 remainder (tax) spread by subtotal share: Produce 3/8, default 5/8.
        p = build_transaction_payload(
            self._receipt(11.0), items, "acct", "ycat-default", {"Produce": "ycat-prod"}
        )
        assert p["category_id"] is None
        subs = {s["category_id"]: s["amount"] for s in p["subtransactions"]}
        assert subs["ycat-prod"] == -4125      # 3000 + 3/8 of 3000
        assert subs["ycat-default"] == -6875   # 5000 + 5/8 of 3000
        assert sum(s["amount"] for s in p["subtransactions"]) == p["amount"] == -11000

    def test_single_mapped_category_absorbs_tax(self):
        items = [{"category": "Produce", "price": 10.0, "quantity": 1}]
        p = build_transaction_payload(
            self._receipt(11.0), items, "acct", "ycat-default", {"Produce": "ycat-prod"}
        )
        # One category → the whole $1 tax folds into it; stays a single transaction.
        assert p["category_id"] == "ycat-prod"
        assert p["amount"] == -11000
        assert "subtransactions" not in p

    def test_remainder_split_sums_exactly_with_rounding(self):
        # Uneven split (1:2) of a remainder that doesn't divide evenly must still
        # sum to the total (largest-remainder allocation).
        items = [{"category": "Produce", "price": 1.0, "quantity": 1},
                 {"category": "Snacks", "price": 2.0, "quantity": 1}]
        p = build_transaction_payload(
            self._receipt(3.10), items, "acct", "ycat-default",
            {"Produce": "ycat-prod", "Snacks": "ycat-snacks"},
        )
        subs = {s["category_id"]: s["amount"] for s in p["subtransactions"]}
        assert subs["ycat-prod"] == -1033   # 1000 + 33 (0.10 * 1/3, rounded up)
        assert subs["ycat-snacks"] == -2067  # 2000 + 67
        assert sum(s["amount"] for s in p["subtransactions"]) == p["amount"] == -3100

    def test_zero_remainder_stays_single(self):
        items = [{"category": "Produce", "price": 10.0, "quantity": 1}]
        p = build_transaction_payload(
            self._receipt(10.0), items, "acct", "ycat-default", {"Produce": "ycat-prod"}
        )
        assert p["category_id"] == "ycat-prod"
        assert "subtransactions" not in p

    def test_quantity_multiplies_price(self):
        items = [{"category": "Produce", "price": 2.5, "quantity": 4}]  # 10.00
        p = build_transaction_payload(
            self._receipt(10.0), items, "acct", "ycat-default", {"Produce": "ycat-prod"}
        )
        assert p["amount"] == -10000
        assert p["category_id"] == "ycat-prod"

    def test_total_falls_back_to_item_sum(self):
        items = [{"category": "Snacks", "price": 4.25, "quantity": 1}]
        r = {"id": 2, "store_name": "S", "receipt_date": "2026-07-01", "total": None}
        p = build_transaction_payload(r, items, "acct", "ycat-default", {})
        assert p["amount"] == -4250


# ── SDK model builders (serialization guard) ─────────────────────────────────

class TestModelBuilders:
    """Guard the payload → SDK model mapping (the `date` field uses an alias)."""

    def _payload(self, split: bool):
        import uuid
        acct, c1, c2 = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        base = {
            "account_id": acct, "date": "2026-07-01", "amount": -11000,
            "payee_name": "Mart", "memo": "Tabulate receipt #5",
            "cleared": "uncleared", "approved": False,
        }
        if split:
            base["category_id"] = None
            base["subtransactions"] = [
                {"amount": -3000, "category_id": c1}, {"amount": -8000, "category_id": c2}]
        else:
            base["category_id"] = c1
        return base

    def test_new_transaction_serializes_split(self):
        import json
        from services.ynab_service import _new_transaction
        d = json.loads(_new_transaction(self._payload(split=True)).to_json())
        assert d["date"] == "2026-07-01"
        assert d["amount"] == -11000
        assert d["cleared"] == "uncleared"
        assert d["approved"] is False
        assert sum(s["amount"] for s in d["subtransactions"]) == -11000

    def test_existing_transaction_serializes_single(self):
        import json
        from services.ynab_service import _existing_transaction
        d = json.loads(_existing_transaction(self._payload(split=False)).to_json())
        assert d["date"] == "2026-07-01"
        assert d["category_id"] is not None
        assert not d.get("subtransactions")


# ── Config storage ───────────────────────────────────────────────────────────

class TestConfig:

    @pytest.mark.asyncio
    async def test_roundtrip(self, db):
        pid = await cat_id(db, "Produce")
        await configure(db, mappings=[{"category_id": pid, "ynab_category_id": "ycat-prod"}])
        cfg = await ynab_service.get_config(db)
        assert cfg["enabled"] is True
        assert cfg["budget_id"] == "budget-1"
        assert cfg["account_id"] == "account-1"
        assert cfg["default_category_id"] == "ycat-default"
        assert cfg["configured"] is True
        assert cfg["mappings"] == [{"category_id": pid, "ynab_category_id": "ycat-prod"}]

    @pytest.mark.asyncio
    async def test_not_configured_when_missing_fields(self, db):
        await configure(db, budget_id=None)
        cfg = await ynab_service.get_config(db)
        assert cfg["configured"] is False

    @pytest.mark.asyncio
    async def test_save_replaces_mappings(self, db):
        pid = await cat_id(db, "Produce")
        sid = await cat_id(db, "Snacks")
        await configure(db, mappings=[{"category_id": pid, "ynab_category_id": "a"}])
        await configure(db, mappings=[{"category_id": sid, "ynab_category_id": "b"}])
        cfg = await ynab_service.get_config(db)
        assert cfg["mappings"] == [{"category_id": sid, "ynab_category_id": "b"}]


# ── sync_receipt ─────────────────────────────────────────────────────────────

class TestSyncReceipt:

    @pytest.mark.asyncio
    async def test_skips_when_disabled(self, db):
        rid = await insert_receipt(db)
        await configure(db, enabled=False)
        result = await ynab_service.sync_receipt(db, rid)
        assert result["status"] == "skipped"

    @pytest.mark.asyncio
    async def test_skips_and_marks_failed_when_not_configured(self, db):
        rid = await insert_receipt(db)
        with patch.object(ynab_service, "YNAB_API_TOKEN", "test-token"):
            await configure(db, budget_id=None)
            result = await ynab_service.sync_receipt(db, rid)
        assert result["status"] == "skipped"
        async with db.execute("SELECT ynab_sync_status FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["ynab_sync_status"] == "failed"

    @pytest.mark.asyncio
    async def test_creates_transaction_and_stores_id(self, db):
        rid = await insert_receipt(db, total=10.0)
        await insert_item(db, rid, "Snacks", 10.0)
        with patch.object(ynab_service, "YNAB_API_TOKEN", "test-token"):
            await configure(db)
            with patch.object(
                ynab_service, "_create_transaction", new_callable=AsyncMock,
                return_value="txn-123",
            ) as mock_create:
                result = await ynab_service.sync_receipt(db, rid)

        assert result["status"] == "synced"
        assert result["transaction_id"] == "txn-123"
        mock_create.assert_awaited_once()
        assert mock_create.call_args[0][0] == "budget-1"  # budget id
        async with db.execute(
            "SELECT ynab_transaction_id, ynab_sync_status FROM receipts WHERE id = ?", (rid,)
        ) as cur:
            row = await cur.fetchone()
        assert row["ynab_transaction_id"] == "txn-123"
        assert row["ynab_sync_status"] == "synced"

    @pytest.mark.asyncio
    async def test_updates_single_category_in_place(self, db):
        # No mapping + total == item sum → a single (non-split) transaction, which
        # is updated in place via _update_transaction.
        rid = await insert_receipt(db, total=10.0)
        await insert_item(db, rid, "Snacks", 10.0)
        await db.execute(
            "UPDATE receipts SET ynab_transaction_id = 'existing-1' WHERE id = ?", (rid,)
        )
        await db.commit()
        with patch.object(ynab_service, "YNAB_API_TOKEN", "test-token"):
            await configure(db)
            with patch.object(ynab_service, "_get_transaction", new_callable=AsyncMock,
                              return_value={"id": "existing-1", "is_split": False}), \
                 patch.object(ynab_service, "_update_transaction", new_callable=AsyncMock,
                              return_value="existing-1") as mock_update, \
                 patch.object(ynab_service, "_delete_transaction", new_callable=AsyncMock) as mock_delete, \
                 patch.object(ynab_service, "_create_transaction", new_callable=AsyncMock) as mock_create:
                result = await ynab_service.sync_receipt(db, rid)

        assert result["status"] == "synced"
        mock_update.assert_awaited_once()
        assert mock_update.call_args[0][1] == "existing-1"  # txn id
        mock_delete.assert_not_awaited()
        mock_create.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_split_transaction_is_deleted_and_recreated(self, db):
        # Existing YNAB transaction is a split → cannot be updated, so delete + recreate.
        rid = await insert_receipt(db, total=10.0)
        await insert_item(db, rid, "Snacks", 10.0)
        await db.execute(
            "UPDATE receipts SET ynab_transaction_id = 'old-split' WHERE id = ?", (rid,)
        )
        await db.commit()
        with patch.object(ynab_service, "YNAB_API_TOKEN", "test-token"):
            await configure(db)
            with patch.object(ynab_service, "_get_transaction", new_callable=AsyncMock,
                              return_value={"id": "old-split", "is_split": True}), \
                 patch.object(ynab_service, "_delete_transaction", new_callable=AsyncMock) as mock_delete, \
                 patch.object(ynab_service, "_create_transaction", new_callable=AsyncMock,
                              return_value="new-txn") as mock_create, \
                 patch.object(ynab_service, "_update_transaction", new_callable=AsyncMock) as mock_update:
                result = await ynab_service.sync_receipt(db, rid)

        assert result["status"] == "synced"
        assert result["transaction_id"] == "new-txn"
        mock_delete.assert_awaited_once()
        assert mock_delete.call_args[0][1] == "old-split"
        mock_create.assert_awaited_once()
        mock_update.assert_not_awaited()
        async with db.execute("SELECT ynab_transaction_id FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["ynab_transaction_id"] == "new-txn"

    @pytest.mark.asyncio
    async def test_recreates_when_existing_transaction_is_gone(self, db):
        rid = await insert_receipt(db, total=10.0)
        await insert_item(db, rid, "Snacks", 10.0)
        await db.execute(
            "UPDATE receipts SET ynab_transaction_id = 'deleted-in-ynab' WHERE id = ?", (rid,)
        )
        await db.commit()
        with patch.object(ynab_service, "YNAB_API_TOKEN", "test-token"):
            await configure(db)
            with patch.object(ynab_service, "_get_transaction", new_callable=AsyncMock,
                              return_value=None), \
                 patch.object(ynab_service, "_create_transaction", new_callable=AsyncMock,
                              return_value="fresh-1") as mock_create:
                result = await ynab_service.sync_receipt(db, rid)

        assert result["status"] == "synced"
        assert result["transaction_id"] == "fresh-1"
        mock_create.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_marks_failed_on_api_error(self, db):
        rid = await insert_receipt(db, total=10.0)
        await insert_item(db, rid, "Snacks", 10.0)
        with patch.object(ynab_service, "YNAB_API_TOKEN", "test-token"):
            await configure(db)
            with patch.object(
                ynab_service, "_create_transaction", new_callable=AsyncMock,
                side_effect=ynab_service.YnabError("boom"),
            ):
                with pytest.raises(ynab_service.YnabError):
                    await ynab_service.sync_receipt(db, rid)
        async with db.execute("SELECT ynab_sync_status FROM receipts WHERE id = ?", (rid,)) as cur:
            row = await cur.fetchone()
        assert row["ynab_sync_status"] == "failed"
