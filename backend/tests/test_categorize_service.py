"""
Tests for the categorization service — source-priority logic, key consistency,
normalize_key, and find_best_match.
"""
import pytest
from services.categorize_service import (
    normalize_key,
    find_best_match,
    save_mapping,
    load_mappings,
    apply_manual_correction,
)


# ── Helper ────────────────────────────────────────────────────────────────────

async def get_mapping(db, key):
    """Fetch a single mapping row by normalized_key."""
    async with db.execute(
        "SELECT category, source, times_seen, display_name FROM item_mappings WHERE normalized_key = ?",
        (key,),
    ) as cur:
        return await cur.fetchone()


# ── normalize_key ─────────────────────────────────────────────────────────────

class TestNormalizeKey:
    def test_basic_lowercase(self):
        assert normalize_key("Coconut Milk") == "coconutmilk"

    def test_strips_weight_suffix(self):
        assert normalize_key("COCONUT MILK 32OZ") == "coconutmilk"

    def test_strips_lb_suffix(self):
        assert normalize_key("Chicken Breast 2.5lb") == "chickenbreast"

    def test_strips_count_suffix(self):
        assert normalize_key("Eggs 12ct") == "eggs"

    def test_strips_pack_suffix(self):
        assert normalize_key("Water 24pack") == "water"

    def test_strips_standalone_numbers(self):
        assert normalize_key("Item 42") == "item"

    def test_strips_special_characters(self):
        assert normalize_key("Coconut Milk $4.99") == "coconutmilk"

    def test_collapses_whitespace(self):
        assert normalize_key("  Coconut   Milk  ") == "coconutmilk"

    def test_empty_string(self):
        assert normalize_key("") == ""

    def test_only_numbers(self):
        assert normalize_key("123") == ""

    def test_fl_oz_unit(self):
        assert normalize_key("OJ 64fl oz") == "oj"

    def test_ml_unit(self):
        assert normalize_key("Sprite 500ml") == "sprite"

    def test_kg_unit(self):
        assert normalize_key("Flour 2.5kg") == "flour"

    def test_spaces_ignored_for_matching(self):
        """OCR variants with/without spaces produce the same key."""
        assert normalize_key("KS Steakstrip") == normalize_key("KSSteakstrip")
        assert normalize_key("KS Steakstrip") == "kssteakstrip"


# ── find_best_match ───────────────────────────────────────────────────────────

class TestFindBestMatch:
    def test_exact_match(self):
        mappings = {"coconutmilk": "Dairy & Eggs", "milk": "Dairy & Eggs"}
        assert find_best_match("coconutmilk", mappings) == "Dairy & Eggs"

    def test_substring_similar_length(self):
        """Learned key 'milk' is a substring of 'oatmilk' — 4/7 = 57% > 50%."""
        mappings = {"milk": "Dairy & Eggs"}
        assert find_best_match("oatmilk", mappings) == "Dairy & Eggs"

    def test_substring_key_in_learned(self):
        """Query 'milk' is a substring of learned key 'oatmilk' — within 50% ratio."""
        mappings = {"oatmilk": "Dairy & Eggs"}
        assert find_best_match("milk", mappings) == "Dairy & Eggs"

    def test_short_seed_does_not_match_long_key(self):
        """Short generic seed 'milk' must NOT match long specific keys.

        'milk' (4 chars) vs 'tasteofthaicoconutmilk' (22 chars) = 18% < 50%.
        This was the root cause of the bug: items like 'Taste of Thai Coconut
        Milk' would match the 'milk' seed and get 'Dairy & Eggs' instead of
        going to AI categorization or matching a more specific user mapping.
        """
        mappings = {"milk": "Dairy & Eggs"}
        assert find_best_match("tasteofthaicoconutmilk", mappings) is None

    def test_short_seed_does_not_override_user_mapping(self):
        """When user has a specific mapping, short seed must not steal the match.

        Regression test for the reported bug: user mapped a 'Taste of Thai'
        product to Pantry, but a different 'Taste of Thai' product containing
        'milk' in its name would match the 'milk' → 'Dairy & Eggs' seed
        instead of going to AI.
        """
        mappings = {
            "tasteofthaipadthai": "Pantry",   # user's mapping for one product
            "milk": "Dairy & Eggs",            # generic seed
        }
        # A different product from the same brand — should not match either
        assert find_best_match("tasteofthaicoconutmilk", mappings) is None

    def test_longest_match_wins(self):
        """When multiple substrings match and pass ratio, the longest learned key wins."""
        mappings = {
            "milk": "Beverages",
            "coconutmilk": "Dairy & Eggs",
        }
        # coconutmilk (11) / organiccoconutmilk (18) = 61% > 50% — matches
        # milk (4) / organiccoconutmilk (18) = 22% < 50% — filtered out
        assert find_best_match("organiccoconutmilk", mappings) == "Dairy & Eggs"

    def test_no_match_returns_none(self):
        mappings = {"butter": "Dairy & Eggs", "bread": "Pantry"}
        assert find_best_match("salmon", mappings) is None

    def test_empty_mappings(self):
        assert find_best_match("anything", {}) is None

    def test_empty_key(self):
        mappings = {"milk": "Dairy & Eggs"}
        result = find_best_match("", mappings)
        assert result is None


# ── save_mapping source priority ──────────────────────────────────────────────

class TestSaveMappingSourcePriority:
    @pytest.mark.asyncio
    async def test_ai_does_not_overwrite_manual(self, db):
        """AI upsert must not downgrade a manual mapping."""
        await save_mapping(db, "Coconut Milk", "Dairy & Eggs", source="manual")
        await db.commit()

        await save_mapping(db, "Coconut Milk", "Pantry", source="ai")
        await db.commit()

        row = await get_mapping(db, "coconutmilk")
        assert row["category"] == "Dairy & Eggs"
        assert row["source"] == "manual"

    @pytest.mark.asyncio
    async def test_ai_can_overwrite_ai(self, db):
        """AI upsert can overwrite another AI mapping."""
        await save_mapping(db, "Kombucha", "Beverages", source="ai")
        await db.commit()

        await save_mapping(db, "Kombucha", "Other", source="ai")
        await db.commit()

        row = await get_mapping(db, "kombucha")
        assert row["category"] == "Other"
        assert row["source"] == "ai"

    @pytest.mark.asyncio
    async def test_manual_can_overwrite_manual(self, db):
        """A manual correction can overwrite a previous manual correction."""
        await save_mapping(db, "Oat Milk", "Dairy & Eggs", source="manual")
        await db.commit()

        await save_mapping(db, "Oat Milk", "Beverages", source="manual")
        await db.commit()

        row = await get_mapping(db, "oatmilk")
        assert row["category"] == "Beverages"
        assert row["source"] == "manual"

    @pytest.mark.asyncio
    async def test_manual_can_overwrite_ai(self, db):
        """A manual correction should overwrite an AI mapping."""
        await save_mapping(db, "Trail Mix", "Pantry", source="ai")
        await db.commit()

        await save_mapping(db, "Trail Mix", "Snacks", source="manual")
        await db.commit()

        row = await get_mapping(db, "trailmix")
        assert row["category"] == "Snacks"
        assert row["source"] == "manual"

    @pytest.mark.asyncio
    async def test_times_seen_increments_on_conflict(self, db):
        """Every upsert should increment times_seen regardless of source outcome."""
        await save_mapping(db, "Bread", "Pantry", source="manual")
        await db.commit()

        row = await get_mapping(db, "bread")
        assert row["times_seen"] == 1

        await save_mapping(db, "Bread", "Other", source="ai")
        await db.commit()

        row = await get_mapping(db, "bread")
        assert row["times_seen"] == 2
        # Category should NOT have changed
        assert row["category"] == "Pantry"

    @pytest.mark.asyncio
    async def test_display_name_override(self, db):
        """Explicit display_name parameter should be used instead of auto-title."""
        await save_mapping(db, "CNUT MLK", "Dairy & Eggs", source="manual", display_name="Coconut Milk")
        await db.commit()

        row = await get_mapping(db, "cnutmlk")
        assert row["display_name"] == "Coconut Milk"

    @pytest.mark.asyncio
    async def test_display_name_defaults_to_title_case(self, db):
        """Without explicit display_name, raw_name.strip().title() is used."""
        await save_mapping(db, "organic eggs", "Dairy & Eggs", source="ai")
        await db.commit()

        row = await get_mapping(db, "organiceggs")
        assert row["display_name"] == "Organic Eggs"


# ── Batch upsert (simulates categorize_items Stage 2) ────────────────────────

class TestBatchUpsert:
    @pytest.mark.asyncio
    async def test_batch_preserves_manual_mappings(self, db):
        """Batch AI upsert must not downgrade manual mappings."""
        await save_mapping(db, "Almond Butter", "Pantry", source="manual")
        await db.commit()

        mapping_rows = [
            (normalize_key("Almond Butter"), "Almond Butter", "Other", "ai"),
            (normalize_key("Sparkling Water"), "Sparkling Water", "Beverages", "ai"),
        ]

        await db.executemany(
            """
            INSERT INTO item_mappings (normalized_key, display_name, category, source, times_seen)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(normalized_key) DO UPDATE SET
                category   = CASE WHEN item_mappings.source = 'manual'
                                  THEN item_mappings.category
                                  ELSE excluded.category END,
                source     = CASE WHEN item_mappings.source = 'manual'
                                  THEN 'manual'
                                  ELSE excluded.source END,
                times_seen = times_seen + 1,
                last_seen  = datetime('now')
            """,
            mapping_rows,
        )
        await db.commit()

        row = await get_mapping(db, "almondbutter")
        assert row["category"] == "Pantry"
        assert row["source"] == "manual"
        assert row["times_seen"] == 2

        row = await get_mapping(db, "sparklingwater")
        assert row["category"] == "Beverages"
        assert row["source"] == "ai"

    @pytest.mark.asyncio
    async def test_batch_ai_can_update_ai(self, db):
        """Batch AI upsert can update existing AI mappings."""
        await save_mapping(db, "Energy Drink", "Beverages", source="ai")
        await db.commit()

        mapping_rows = [
            (normalize_key("Energy Drink"), "Energy Drink", "Snacks", "ai"),
        ]

        await db.executemany(
            """
            INSERT INTO item_mappings (normalized_key, display_name, category, source, times_seen)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(normalized_key) DO UPDATE SET
                category   = CASE WHEN item_mappings.source = 'manual'
                                  THEN item_mappings.category
                                  ELSE excluded.category END,
                source     = CASE WHEN item_mappings.source = 'manual'
                                  THEN 'manual'
                                  ELSE excluded.source END,
                times_seen = times_seen + 1,
                last_seen  = datetime('now')
            """,
            mapping_rows,
        )
        await db.commit()

        row = await get_mapping(db, "energydrink")
        assert row["category"] == "Snacks"
        assert row["source"] == "ai"


# ── apply_manual_correction ───────────────────────────────────────────────────

class TestApplyManualCorrection:
    @pytest.fixture
    async def receipt_with_item(self, db):
        """Insert a receipt + line item, return the line item id."""
        await db.execute(
            "INSERT INTO receipts (store_name, receipt_date, total) VALUES (?, ?, ?)",
            ("Test Store", "2025-01-15", 9.99),
        )
        await db.execute(
            """INSERT INTO line_items (receipt_id, raw_name, clean_name, price, category, category_source)
               VALUES (1, 'CNUT MLK 32OZ', 'Coconut Milk', 4.99, 'Other', 'ai')""",
        )
        await db.commit()
        async with db.execute("SELECT id FROM line_items LIMIT 1") as cur:
            row = await cur.fetchone()
        return row["id"]

    @pytest.mark.asyncio
    async def test_correction_updates_line_item(self, db, receipt_with_item):
        item_id = receipt_with_item
        await apply_manual_correction(db, item_id, "Dairy & Eggs")

        async with db.execute(
            "SELECT category, category_source, corrected FROM line_items WHERE id = ?",
            (item_id,),
        ) as cur:
            row = await cur.fetchone()

        assert row["category"] == "Dairy & Eggs"
        assert row["category_source"] == "manual"
        assert row["corrected"] == 1

    @pytest.mark.asyncio
    async def test_correction_keys_mapping_on_raw_name(self, db, receipt_with_item):
        """Mapping should be keyed on raw_name, not clean_name."""
        item_id = receipt_with_item
        await apply_manual_correction(db, item_id, "Dairy & Eggs")

        raw_key = normalize_key("CNUT MLK 32OZ")
        assert raw_key == "cnutmlk"  # spaces stripped
        row = await get_mapping(db, raw_key)
        assert row is not None
        assert row["category"] == "Dairy & Eggs"
        assert row["source"] == "manual"

    @pytest.mark.asyncio
    async def test_correction_uses_clean_name_for_display(self, db, receipt_with_item):
        """display_name should come from clean_name, not the OCR raw_name."""
        item_id = receipt_with_item
        await apply_manual_correction(db, item_id, "Dairy & Eggs")

        raw_key = normalize_key("CNUT MLK 32OZ")
        row = await get_mapping(db, raw_key)
        assert row["display_name"] == "Coconut Milk"

    @pytest.mark.asyncio
    async def test_correction_rejects_invalid_category(self, db, receipt_with_item):
        item_id = receipt_with_item
        with pytest.raises(ValueError, match="Unknown category"):
            await apply_manual_correction(db, item_id, "Nonexistent Category")

    @pytest.mark.asyncio
    async def test_correction_noop_for_missing_item(self, db):
        """Correcting a non-existent item should be a silent no-op."""
        await apply_manual_correction(db, 99999, "Produce")
        # No mapping should be created
        mappings = await load_mappings(db)
        assert len(mappings) == 0

    @pytest.mark.asyncio
    async def test_correction_does_not_downgrade_after_ai_rescan(self, db, receipt_with_item):
        """
        Full lifecycle: manual correction → AI re-encounter → mapping stays manual.
        Simulates the original reported bug.
        """
        item_id = receipt_with_item

        # 1. User manually corrects
        await apply_manual_correction(db, item_id, "Dairy & Eggs")

        raw_key = normalize_key("CNUT MLK 32OZ")
        row = await get_mapping(db, raw_key)
        assert row["source"] == "manual"
        assert row["category"] == "Dairy & Eggs"

        # 2. Same item scanned again — AI tries to categorize as "Pantry"
        await save_mapping(db, "CNUT MLK 32OZ", "Pantry", source="ai")
        await db.commit()

        row = await get_mapping(db, raw_key)
        assert row["source"] == "manual"
        assert row["category"] == "Dairy & Eggs"


# ── load_mappings ─────────────────────────────────────────────────────────────

class TestLoadMappings:
    @pytest.mark.asyncio
    async def test_empty_db(self, db):
        mappings = await load_mappings(db)
        assert mappings == {}

    @pytest.mark.asyncio
    async def test_returns_all_mappings(self, db):
        await save_mapping(db, "Milk", "Dairy & Eggs", source="manual")
        await save_mapping(db, "Bread", "Pantry", source="ai")
        await db.commit()

        mappings = await load_mappings(db)
        assert mappings["milk"] == "Dairy & Eggs"
        assert mappings["bread"] == "Pantry"
        assert len(mappings) == 2


# ── End-to-end key consistency ────────────────────────────────────────────────

class TestKeyConsistency:
    @pytest.mark.asyncio
    async def test_stage1_lookup_finds_manual_correction(self, db, ):
        """
        After a manual correction keyed on raw_name, a Stage 1 lookup
        (also keyed on raw_name) should find the mapping.
        """
        # Insert receipt + item
        await db.execute(
            "INSERT INTO receipts (store_name, total) VALUES (?, ?)",
            ("Store", 10.0),
        )
        await db.execute(
            """INSERT INTO line_items (receipt_id, raw_name, clean_name, price, category, category_source)
               VALUES (1, 'ORG ALMND MILK 64OZ', 'Organic Almond Milk', 5.49, 'Beverages', 'ai')""",
        )
        await db.commit()

        async with db.execute("SELECT id FROM line_items LIMIT 1") as cur:
            item_id = (await cur.fetchone())["id"]

        # Manual correction
        await apply_manual_correction(db, item_id, "Dairy & Eggs")

        # Stage 1 lookup: uses normalize_key(raw_name)
        mappings = await load_mappings(db)
        lookup_key = normalize_key("ORG ALMND MILK 64OZ")
        matched = find_best_match(lookup_key, mappings)
        assert matched == "Dairy & Eggs"

    @pytest.mark.asyncio
    async def test_mapping_key_uses_raw_name_not_clean_name_after_edit(self, db):
        """
        Bug regression: when clean_name is edited to a friendly name (e.g.
        "Kirkland Signature Steak Strips") but raw_name remains the OCR text
        (e.g. "KS STEAKSTRIP"), the mapping key should be based on raw_name.
        """
        await db.execute(
            "INSERT INTO receipts (store_name, total) VALUES (?, ?)",
            ("Costco", 15.99),
        )
        # raw_name = OCR text, clean_name = AI-interpreted display name
        await db.execute(
            """INSERT INTO line_items (receipt_id, raw_name, clean_name, price, category, category_source)
               VALUES (1, 'KS STEAKSTRIP', 'Kirkland Signature Steak Strips', 15.99, 'Other', 'ai')""",
        )
        await db.commit()

        async with db.execute("SELECT id FROM line_items LIMIT 1") as cur:
            item_id = (await cur.fetchone())["id"]

        # Simulate user editing clean_name to a different friendly name
        await db.execute(
            "UPDATE line_items SET clean_name = ? WHERE id = ?",
            ("KS Steak Strips", item_id),
        )
        await db.commit()

        # Now apply a manual category correction
        await apply_manual_correction(db, item_id, "Meat & Seafood")

        # The mapping key must be based on the original raw_name "KS STEAKSTRIP"
        raw_key = normalize_key("KS STEAKSTRIP")
        assert raw_key == "kssteakstrip"  # spaces stripped
        row = await get_mapping(db, raw_key)
        assert row is not None, "Mapping should be keyed on raw_name, not clean_name"
        assert row["category"] == "Meat & Seafood"

        # There should be NO mapping keyed on the friendly name
        friendly_key = normalize_key("Kirkland Signature Steak Strips")
        friendly_row = await get_mapping(db, friendly_key)
        assert friendly_row is None, "No mapping should exist for the friendly/display name"

    @pytest.mark.asyncio
    async def test_no_duplicate_mappings_for_abbreviated_and_expanded_names(self, db):
        """
        Bug regression: two mappings should NOT be created when the same item
        appears with both its raw OCR abbreviation and an expanded name.
        """
        # First encounter: raw_name is the true OCR text
        await save_mapping(db, "KS STEAKSTRIP", "Snacks", source="ai",
                           display_name="Kirkland Signature Steak Strips")
        await db.commit()

        # Second encounter: same raw OCR text
        await save_mapping(db, "KS STEAKSTRIP", "Meat & Seafood", source="ai",
                           display_name="Kirkland Signature Steak Strips")
        await db.commit()

        # Should have exactly one mapping, not two
        async with db.execute("SELECT COUNT(*) FROM item_mappings") as cur:
            count = (await cur.fetchone())[0]
        assert count == 1

        row = await get_mapping(db, normalize_key("KS STEAKSTRIP"))
        assert row is not None
        assert row["times_seen"] == 2
