"""
Test that AI categorization does NOT overwrite manual/learned mappings.

Creates an in-memory SQLite DB, seeds it, then exercises the categorization
service with a sequence that would trigger the bug before the fix.
"""
import asyncio
import aiosqlite
import sys
import os

# Make backend importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "backend"))

from services.categorize_service import (
    normalize_key,
    save_mapping,
    load_mappings,
    apply_manual_correction,
)

# Minimal schema needed for the test
SCHEMA = """
CREATE TABLE categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER NOT NULL DEFAULT 100
);
INSERT INTO categories (name, sort_order) VALUES
    ('Produce', 10), ('Dairy & Eggs', 30), ('Pantry', 60),
    ('Beverages', 50), ('Other', 90);

CREATE TABLE item_mappings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    normalized_key  TEXT NOT NULL UNIQUE,
    display_name    TEXT NOT NULL,
    category        TEXT NOT NULL,
    source          TEXT DEFAULT 'manual',
    times_seen      INTEGER DEFAULT 1,
    last_seen       TEXT DEFAULT (datetime('now')),
    created_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE line_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id      INTEGER NOT NULL,
    raw_name        TEXT NOT NULL,
    clean_name      TEXT,
    price           REAL NOT NULL,
    quantity        REAL DEFAULT 1,
    category        TEXT,
    category_source TEXT DEFAULT 'ai',
    ai_confidence   REAL,
    corrected       INTEGER DEFAULT 0
);
"""

passed = 0
failed = 0

def check(name: str, actual, expected):
    global passed, failed
    if actual == expected:
        passed += 1
        print(f"  PASS: {name}")
    else:
        failed += 1
        print(f"  FAIL: {name}")
        print(f"        expected: {expected!r}")
        print(f"        actual:   {actual!r}")


async def get_mapping(db, key):
    async with db.execute(
        "SELECT category, source FROM item_mappings WHERE normalized_key = ?", (key,)
    ) as cur:
        row = await cur.fetchone()
    return (row["category"], row["source"]) if row else None


async def test_ai_does_not_overwrite_manual():
    """An AI upsert must not downgrade a manual mapping."""
    print("\n--- test_ai_does_not_overwrite_manual ---")

    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(SCHEMA)

        # Step 1: save a manual mapping for "coconut milk"
        await save_mapping(db, "Coconut Milk", "Dairy & Eggs", source="manual")
        await db.commit()

        result = await get_mapping(db, "coconut milk")
        check("manual mapping saved", result, ("Dairy & Eggs", "manual"))

        # Step 2: AI tries to overwrite it with "Pantry"
        await save_mapping(db, "Coconut Milk", "Pantry", source="ai")
        await db.commit()

        result = await get_mapping(db, "coconut milk")
        check("AI did NOT overwrite manual category", result[0], "Dairy & Eggs")
        check("source is still manual", result[1], "manual")


async def test_ai_can_overwrite_ai():
    """An AI upsert CAN overwrite another AI mapping (latest classification wins)."""
    print("\n--- test_ai_can_overwrite_ai ---")

    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(SCHEMA)

        await save_mapping(db, "Kombucha", "Beverages", source="ai")
        await db.commit()

        result = await get_mapping(db, "kombucha")
        check("initial AI mapping", result, ("Beverages", "ai"))

        # Second AI call reclassifies
        await save_mapping(db, "Kombucha", "Other", source="ai")
        await db.commit()

        result = await get_mapping(db, "kombucha")
        check("AI can update AI mapping", result, ("Other", "ai"))


async def test_manual_can_overwrite_manual():
    """A manual correction can overwrite a previous manual correction."""
    print("\n--- test_manual_can_overwrite_manual ---")

    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(SCHEMA)

        await save_mapping(db, "Oat Milk", "Dairy & Eggs", source="manual")
        await db.commit()

        result = await get_mapping(db, "oat milk")
        check("first manual", result, ("Dairy & Eggs", "manual"))

        await save_mapping(db, "Oat Milk", "Beverages", source="manual")
        await db.commit()

        result = await get_mapping(db, "oat milk")
        check("manual can update manual", result, ("Beverages", "manual"))


async def test_manual_can_overwrite_ai():
    """A manual correction should overwrite an AI mapping."""
    print("\n--- test_manual_can_overwrite_ai ---")

    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(SCHEMA)

        await save_mapping(db, "Trail Mix", "Pantry", source="ai")
        await db.commit()

        result = await get_mapping(db, "trail mix")
        check("initial AI mapping", result, ("Pantry", "ai"))

        await save_mapping(db, "Trail Mix", "Snacks", source="manual")
        await db.commit()

        result = await get_mapping(db, "trail mix")
        check("manual overwrites AI", result[0], "Snacks")
        check("source upgraded to manual", result[1], "manual")


async def test_batch_upsert_preserves_manual():
    """Simulate the batch upsert from categorize_items Stage 2."""
    print("\n--- test_batch_upsert_preserves_manual ---")

    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(SCHEMA)

        # Pre-existing manual mapping
        await save_mapping(db, "Almond Butter", "Pantry", source="manual")
        await db.commit()

        # Simulate batch upsert with AI results (source always 'ai')
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

        result = await get_mapping(db, "almond butter")
        check("batch upsert preserved manual category", result[0], "Pantry")
        check("batch upsert preserved manual source", result[1], "manual")

        result = await get_mapping(db, "sparkling water")
        check("new AI mapping inserted", result, ("Beverages", "ai"))


async def test_apply_manual_correction_keys_on_raw_name():
    """apply_manual_correction should key the mapping on raw_name."""
    print("\n--- test_apply_manual_correction_keys_on_raw_name ---")

    async with aiosqlite.connect(":memory:") as db:
        db.row_factory = aiosqlite.Row
        await db.executescript(SCHEMA)

        # Insert a line item with different raw_name and clean_name
        await db.execute(
            """INSERT INTO line_items (receipt_id, raw_name, clean_name, price, category, category_source)
               VALUES (1, 'CNUT MLK 32OZ', 'Coconut Milk', 4.99, 'Other', 'ai')"""
        )
        await db.commit()

        # Get the item id
        async with db.execute("SELECT id FROM line_items LIMIT 1") as cur:
            item_id = (await cur.fetchone())["id"]

        # Apply manual correction
        await apply_manual_correction(db, item_id, "Dairy & Eggs")

        # The mapping key should be based on raw_name
        raw_key = normalize_key("CNUT MLK 32OZ")
        result = await get_mapping(db, raw_key)
        check("mapping exists keyed on raw_name", result is not None, True)
        if result:
            check("mapping category correct", result[0], "Dairy & Eggs")
            check("mapping source is manual", result[1], "manual")

        # Verify the line item was updated too
        async with db.execute(
            "SELECT category, category_source, corrected FROM line_items WHERE id = ?",
            (item_id,),
        ) as cur:
            row = await cur.fetchone()
        check("line_item category updated", row["category"], "Dairy & Eggs")
        check("line_item source is manual", row["category_source"], "manual")
        check("line_item marked corrected", row["corrected"], 1)


async def test_normalize_key_consistency():
    """Verify normalize_key produces consistent results for OCR variants."""
    print("\n--- test_normalize_key_consistency ---")

    check("basic lowercase", normalize_key("Coconut Milk"), "coconut milk")
    check("with weight", normalize_key("COCONUT MILK 32OZ"), "coconut milk")
    check("with quantity", normalize_key("2x Coconut Milk"), "x coconut milk")
    check("with price chars", normalize_key("Coconut Milk $4.99"), "coconut milk")
    check("with count", normalize_key("Eggs 12ct"), "eggs")


async def main():
    await test_ai_does_not_overwrite_manual()
    await test_ai_can_overwrite_ai()
    await test_manual_can_overwrite_manual()
    await test_manual_can_overwrite_ai()
    await test_batch_upsert_preserves_manual()
    await test_apply_manual_correction_keys_on_raw_name()
    await test_normalize_key_consistency()

    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed")
    if failed:
        print("SOME TESTS FAILED")
        sys.exit(1)
    else:
        print("ALL TESTS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
