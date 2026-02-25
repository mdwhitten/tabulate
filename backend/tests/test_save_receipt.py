"""
Tests for the save receipt endpoint — specifically that name corrections
only update clean_name and never overwrite raw_name (the immutable OCR key).

Regression test for the duplicate-mapping-key bug where editing an item name
in the review screen would set raw_name = friendly_name, causing
apply_manual_correction to create a mapping keyed on the friendly name
instead of the original OCR text.
"""
import pytest
from services.categorize_service import normalize_key, load_mappings


# ── Helper ────────────────────────────────────────────────────────────────────

async def insert_receipt_with_items(db, items):
    """Insert a receipt and line items. Returns (receipt_id, [item_ids])."""
    cur = await db.execute(
        "INSERT INTO receipts (store_name, receipt_date, total, status) VALUES (?, ?, ?, 'pending')",
        ("Costco", "2025-06-15", 50.00),
    )
    receipt_id = cur.lastrowid

    item_ids = []
    for raw_name, clean_name, price, category in items:
        cur = await db.execute(
            """INSERT INTO line_items (receipt_id, raw_name, clean_name, price, category, category_source)
               VALUES (?, ?, ?, ?, ?, 'ai')""",
            (receipt_id, raw_name, clean_name, price, category),
        )
        item_ids.append(cur.lastrowid)

    await db.commit()
    return receipt_id, item_ids


async def get_line_item(db, item_id):
    async with db.execute("SELECT * FROM line_items WHERE id = ?", (item_id,)) as cur:
        return await cur.fetchone()


async def get_mapping_by_key(db, key):
    async with db.execute(
        "SELECT * FROM item_mappings WHERE normalized_key = ?", (key,)
    ) as cur:
        return await cur.fetchone()


# ── Name correction preserves raw_name ──────────────────────────────────────

class TestNameCorrectionPreservesRawName:
    @pytest.mark.asyncio
    async def test_name_correction_only_updates_clean_name(self, db):
        """
        When a user edits the display name of an item, only clean_name should
        change. raw_name must remain the original OCR text.
        """
        receipt_id, [item_id] = await insert_receipt_with_items(db, [
            ("KS STEAKSTRIP", "Ks Steakstrip", 15.99, "Other"),
        ])

        # Simulate what save_receipt does for name corrections (the fixed version)
        new_name = "Kirkland Signature Steak Strips"
        await db.execute(
            "UPDATE line_items SET clean_name = ? WHERE id = ? AND receipt_id = ?",
            (new_name, item_id, receipt_id),
        )
        await db.commit()

        row = await get_line_item(db, item_id)
        assert row["raw_name"] == "KS STEAKSTRIP", "raw_name must not change"
        assert row["clean_name"] == "Kirkland Signature Steak Strips"

    @pytest.mark.asyncio
    async def test_name_plus_category_correction_maps_to_raw_name(self, db):
        """
        Bug regression: when a user corrects both the name and category in a
        single save, the mapping key must be based on raw_name (OCR text),
        not the user-edited friendly name.
        """
        from services.categorize_service import apply_manual_correction, persist_approved_mappings

        receipt_id, [item_id] = await insert_receipt_with_items(db, [
            ("KS STEAKSTRIP", "Ks Steakstrip", 15.99, "Other"),
        ])

        # Step 1: Apply name correction (only clean_name, as fixed)
        await db.execute(
            "UPDATE line_items SET clean_name = ? WHERE id = ? AND receipt_id = ?",
            ("Kirkland Signature Steak Strips", item_id, receipt_id),
        )
        await db.commit()

        # Step 2: Apply category correction + approve (mappings saved at approval)
        await apply_manual_correction(db, item_id, "Meat & Seafood")
        await persist_approved_mappings(db, receipt_id)
        await db.commit()

        # The mapping should be keyed on raw_name, not the edited clean_name
        raw_key = normalize_key("KS STEAKSTRIP")
        mapping = await get_mapping_by_key(db, raw_key)
        assert mapping is not None, "Mapping must be keyed on raw OCR text"
        assert mapping["category"] == "Meat & Seafood"

        # No mapping should exist for the friendly name
        friendly_key = normalize_key("Kirkland Signature Steak Strips")
        bad_mapping = await get_mapping_by_key(db, friendly_key)
        assert bad_mapping is None, "No mapping should be created for the display name"

    @pytest.mark.asyncio
    async def test_subsequent_scan_matches_original_raw_name(self, db):
        """
        After a name edit + category correction + approval, a future scan of
        the same item (with the same raw OCR text) should match the existing mapping.
        """
        from services.categorize_service import (
            apply_manual_correction, persist_approved_mappings, find_best_match,
        )

        receipt_id, [item_id] = await insert_receipt_with_items(db, [
            ("KS STEAKSTRIP", "Ks Steakstrip", 15.99, "Other"),
        ])

        # Edit name + correct category + approve
        await db.execute(
            "UPDATE line_items SET clean_name = ? WHERE id = ?",
            ("Kirkland Signature Steak Strips", item_id),
        )
        await db.commit()
        await apply_manual_correction(db, item_id, "Meat & Seafood")
        await persist_approved_mappings(db, receipt_id)
        await db.commit()

        # Simulate a future scan encountering the same OCR text
        mappings = await load_mappings(db)
        lookup_key = normalize_key("KS STEAKSTRIP")
        matched = find_best_match(lookup_key, mappings)
        assert matched == "Meat & Seafood"

    @pytest.mark.asyncio
    async def test_multiple_items_name_corrections_isolated(self, db):
        """
        Name corrections for multiple items should each only update their own
        clean_name, and raw_name should remain untouched for all.
        """
        receipt_id, item_ids = await insert_receipt_with_items(db, [
            ("KS STEAKSTRIP", "Ks Steakstrip", 15.99, "Other"),
            ("HEB ORG TX RTS", "Heb Org Tx Rts", 3.47, "Other"),
        ])

        corrections = {
            item_ids[0]: "Kirkland Signature Steak Strips",
            item_ids[1]: "H-E-B Organic Texas Roots",
        }

        for iid, new_name in corrections.items():
            await db.execute(
                "UPDATE line_items SET clean_name = ? WHERE id = ? AND receipt_id = ?",
                (new_name, iid, receipt_id),
            )
        await db.commit()

        row0 = await get_line_item(db, item_ids[0])
        assert row0["raw_name"] == "KS STEAKSTRIP"
        assert row0["clean_name"] == "Kirkland Signature Steak Strips"

        row1 = await get_line_item(db, item_ids[1])
        assert row1["raw_name"] == "HEB ORG TX RTS"
        assert row1["clean_name"] == "H-E-B Organic Texas Roots"
