"""
Tests for deferred mapping persistence — mappings should only be written to
item_mappings when a receipt is approved, never during upload or draft save.
"""
import pytest
from services.categorize_service import (
    apply_manual_correction,
    load_mappings,
    persist_approved_mappings,
    save_mapping,
    normalize_key,
)


# ── Helpers ──────────────────────────────────────────────────────────────────

async def insert_receipt(db, items, *, status="pending"):
    """Insert a receipt with line items. Returns (receipt_id, [item_ids])."""
    cur = await db.execute(
        "INSERT INTO receipts (store_name, receipt_date, total, status) VALUES (?, ?, ?, ?)",
        ("Test Store", "2025-03-01", 25.00, status),
    )
    receipt_id = cur.lastrowid
    item_ids = []
    for raw_name, clean_name, price, category, source in items:
        cur = await db.execute(
            """INSERT INTO line_items
               (receipt_id, raw_name, clean_name, price, category, category_source)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (receipt_id, raw_name, clean_name, price, category, source),
        )
        item_ids.append(cur.lastrowid)
    await db.commit()
    return receipt_id, item_ids


async def mapping_count(db):
    async with db.execute("SELECT COUNT(*) FROM item_mappings") as cur:
        return (await cur.fetchone())[0]


async def get_mapping(db, key):
    async with db.execute(
        "SELECT * FROM item_mappings WHERE normalized_key = ?", (key,)
    ) as cur:
        return await cur.fetchone()


# ── apply_manual_correction does NOT create mappings ─────────────────────────

class TestManualCorrectionNoMapping:
    @pytest.mark.asyncio
    async def test_correction_does_not_create_mapping(self, db):
        """apply_manual_correction should update line_items but NOT item_mappings."""
        receipt_id, [item_id] = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Other", "ai"),
        ])

        await apply_manual_correction(db, item_id, "Dairy & Eggs")

        assert await mapping_count(db) == 0

    @pytest.mark.asyncio
    async def test_multiple_corrections_no_mappings(self, db):
        """Even multiple corrections on a receipt should leave item_mappings empty."""
        receipt_id, item_ids = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Other", "ai"),
            ("ORG BANANA", "Organic Banana", 0.79, "Other", "ai"),
            ("CHKN BREAST", "Chicken Breast", 8.99, "Pantry", "ai"),
        ])

        await apply_manual_correction(db, item_ids[0], "Dairy & Eggs")
        await apply_manual_correction(db, item_ids[1], "Produce")
        await apply_manual_correction(db, item_ids[2], "Meat & Seafood")

        assert await mapping_count(db) == 0


# ── persist_approved_mappings creates mappings at approval ───────────────────

class TestPersistApprovedMappings:
    @pytest.mark.asyncio
    async def test_ai_items_persisted_on_approval(self, db):
        """AI-categorized items should get mappings when the receipt is approved."""
        receipt_id, _ids = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Dairy & Eggs", "ai"),
            ("ORG BANANA", "Organic Banana", 0.79, "Produce", "ai"),
        ])

        await persist_approved_mappings(db, receipt_id)
        await db.commit()

        assert await mapping_count(db) == 2
        m = await get_mapping(db, normalize_key("WHOLE MILK 1GAL"))
        assert m["category"] == "Dairy & Eggs"
        assert m["source"] == "ai"

    @pytest.mark.asyncio
    async def test_manual_corrections_persisted_as_manual(self, db):
        """Manually corrected items should get source='manual' mappings."""
        receipt_id, [item_id] = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Other", "ai"),
        ])

        await apply_manual_correction(db, item_id, "Dairy & Eggs")
        await persist_approved_mappings(db, receipt_id)
        await db.commit()

        m = await get_mapping(db, normalize_key("WHOLE MILK 1GAL"))
        assert m is not None
        assert m["category"] == "Dairy & Eggs"
        assert m["source"] == "manual"

    @pytest.mark.asyncio
    async def test_learned_items_persisted_as_ai(self, db):
        """Items with category_source='learned' should get source='ai' mappings."""
        receipt_id, _ids = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Dairy & Eggs", "learned"),
        ])

        await persist_approved_mappings(db, receipt_id)
        await db.commit()

        m = await get_mapping(db, normalize_key("WHOLE MILK 1GAL"))
        assert m["source"] == "ai"

    @pytest.mark.asyncio
    async def test_mixed_sources_correct_priority(self, db):
        """A receipt with both AI and manual items should persist correct sources."""
        receipt_id, [_, item_b] = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Dairy & Eggs", "ai"),
            ("ORG BANANA", "Organic Banana", 0.79, "Other", "ai"),
        ])

        # User corrects banana from Other → Produce
        await apply_manual_correction(db, item_b, "Produce")
        await persist_approved_mappings(db, receipt_id)
        await db.commit()

        milk = await get_mapping(db, normalize_key("WHOLE MILK 1GAL"))
        assert milk["source"] == "ai"
        assert milk["category"] == "Dairy & Eggs"

        banana = await get_mapping(db, normalize_key("ORG BANANA"))
        assert banana["source"] == "manual"
        assert banana["category"] == "Produce"

    @pytest.mark.asyncio
    async def test_display_name_from_clean_name(self, db):
        """Persisted mapping display_name should come from clean_name."""
        receipt_id, _ids = await insert_receipt(db, [
            ("CNUT MLK 32OZ", "Coconut Milk", 3.99, "Dairy & Eggs", "ai"),
        ])

        await persist_approved_mappings(db, receipt_id)
        await db.commit()

        m = await get_mapping(db, normalize_key("CNUT MLK 32OZ"))
        assert m["display_name"] == "Coconut Milk"


# ── Deletion of unapproved receipt leaves no mappings ────────────────────────

class TestDeleteUnapprovedNoOrphans:
    @pytest.mark.asyncio
    async def test_draft_save_then_delete_no_mappings(self, db):
        """Simulates: upload → manual correction → draft save → delete receipt."""
        receipt_id, [item_id] = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Other", "ai"),
        ])

        # Draft save: correct category but don't approve
        await apply_manual_correction(db, item_id, "Dairy & Eggs")

        # Delete the receipt (simulating cancel/delete flow)
        await db.execute("DELETE FROM line_items WHERE receipt_id = ?", (receipt_id,))
        await db.execute("DELETE FROM receipts WHERE id = ?", (receipt_id,))
        await db.commit()

        # No orphaned mappings
        assert await mapping_count(db) == 0

    @pytest.mark.asyncio
    async def test_upload_without_review_then_delete_no_mappings(self, db):
        """Simulates: upload (AI categorizes) → user deletes immediately."""
        receipt_id, _ids = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Dairy & Eggs", "ai"),
            ("ORG BANANA", "Organic Banana", 0.79, "Produce", "ai"),
        ])

        # Delete without reviewing
        await db.execute("DELETE FROM line_items WHERE receipt_id = ?", (receipt_id,))
        await db.execute("DELETE FROM receipts WHERE id = ?", (receipt_id,))
        await db.commit()

        assert await mapping_count(db) == 0


# ── Manual mapping priority preserved across approval ────────────────────────

class TestApprovalSourcePriority:
    @pytest.mark.asyncio
    async def test_manual_not_downgraded_by_second_approval(self, db):
        """
        If a manual mapping already exists from a prior approval, a second
        receipt's AI mapping for the same item should not downgrade it.
        """
        # First receipt: user manually corrects milk → Dairy & Eggs
        r1_id, [r1_item] = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Other", "ai"),
        ])
        await apply_manual_correction(db, r1_item, "Dairy & Eggs")
        await persist_approved_mappings(db, r1_id)
        await db.commit()

        m = await get_mapping(db, normalize_key("WHOLE MILK 1GAL"))
        assert m["source"] == "manual"
        assert m["category"] == "Dairy & Eggs"

        # Second receipt: AI categorizes same item as "Beverages"
        r2_id, _ = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Beverages", "ai"),
        ])
        await persist_approved_mappings(db, r2_id)
        await db.commit()

        # Manual mapping should not be downgraded
        m = await get_mapping(db, normalize_key("WHOLE MILK 1GAL"))
        assert m["source"] == "manual"
        assert m["category"] == "Dairy & Eggs"

    @pytest.mark.asyncio
    async def test_times_seen_increments_on_reapproval(self, db):
        """Approving a second receipt with the same item should bump times_seen."""
        r1_id, _ = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Dairy & Eggs", "ai"),
        ])
        await persist_approved_mappings(db, r1_id)
        await db.commit()

        m = await get_mapping(db, normalize_key("WHOLE MILK 1GAL"))
        assert m["times_seen"] == 1

        r2_id, _ = await insert_receipt(db, [
            ("WHOLE MILK 1GAL", "Whole Milk", 4.29, "Dairy & Eggs", "ai"),
        ])
        await persist_approved_mappings(db, r2_id)
        await db.commit()

        m = await get_mapping(db, normalize_key("WHOLE MILK 1GAL"))
        assert m["times_seen"] == 2
