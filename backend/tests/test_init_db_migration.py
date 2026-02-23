"""
Simulate the production crash and verify the fix.

Reproduces the exact scenario from the error log: the item_mappings table
contains both "ground beef" (with space) AND "groundbeef" (seed data).
The old migration crashed with UNIQUE constraint failed.  The fix uses
UPDATE OR IGNORE + DELETE to handle the conflict gracefully.
"""
import pytest
import aiosqlite
import sqlite3

# ── The migration logic, extracted from database.py ──────────────────────────

async def run_migration(db: aiosqlite.Connection):
    """Runs the same space-collapsing migration as init_db()."""
    await db.execute(
        "UPDATE OR IGNORE item_mappings SET normalized_key = REPLACE(normalized_key, ' ', '') "
        "WHERE normalized_key LIKE '% %'"
    )
    await db.execute(
        "DELETE FROM item_mappings WHERE normalized_key LIKE '% %'"
    )
    await db.commit()


async def run_old_migration(db: aiosqlite.Connection):
    """The old (broken) migration that crashed in production."""
    await db.execute(
        "UPDATE item_mappings SET normalized_key = REPLACE(normalized_key, ' ', '') "
        "WHERE normalized_key LIKE '% %'"
    )
    await db.commit()


# ── Helpers ──────────────────────────────────────────────────────────────────

async def get_all_mappings(db):
    """Return all item_mappings as a list of dicts."""
    async with db.execute(
        "SELECT normalized_key, display_name, category, times_seen FROM item_mappings ORDER BY normalized_key"
    ) as cur:
        rows = await cur.fetchall()
    return [
        {"key": r[0], "display_name": r[1], "category": r[2], "times_seen": r[3]}
        for r in rows
    ]


async def insert_mapping(db, key, display_name, category, times_seen=1):
    await db.execute(
        "INSERT INTO item_mappings (normalized_key, display_name, category, times_seen) VALUES (?, ?, ?, ?)",
        (key, display_name, category, times_seen),
    )


# ── Tests ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_old_migration_crashes_with_duplicate_keys(db):
    """Reproduce the exact production crash: space-containing key collides with
    existing space-free seed data."""
    # Simulate the production state: seed data has the space-free key,
    # and a user-created mapping has the space-containing variant.
    await insert_mapping(db, "groundbeef", "Ground Beef", "Meat & Seafood", times_seen=1)
    await insert_mapping(db, "ground beef", "Ground Beef", "Meat & Seafood", times_seen=5)
    await db.commit()

    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE constraint failed"):
        await run_old_migration(db)


@pytest.mark.asyncio
async def test_fix_handles_duplicate_keys(db):
    """The fixed migration should succeed even when space-containing key
    collides with existing space-free seed data."""
    # Seed data (space-free)
    await insert_mapping(db, "groundbeef", "Ground Beef", "Meat & Seafood", times_seen=1)
    await insert_mapping(db, "icecream", "Ice Cream", "Frozen", times_seen=1)
    # User data (space-containing duplicates)
    await insert_mapping(db, "ground beef", "Ground Beef", "Meat & Seafood", times_seen=5)
    await insert_mapping(db, "ice cream", "Ice Cream", "Frozen", times_seen=3)
    await db.commit()

    # Should NOT raise
    await run_migration(db)

    mappings = await get_all_mappings(db)
    keys = [m["key"] for m in mappings]

    # No spaces should remain in any key
    for key in keys:
        assert " " not in key, f"Key still contains space: {key!r}"

    # The seed versions should still be there
    assert "groundbeef" in keys
    assert "icecream" in keys


@pytest.mark.asyncio
async def test_fix_collapses_keys_without_conflict(db):
    """Keys with spaces that DON'T conflict should be collapsed normally."""
    await insert_mapping(db, "olive oil", "Olive Oil", "Pantry", times_seen=2)
    await insert_mapping(db, "peanut butter", "Peanut Butter", "Pantry", times_seen=4)
    await db.commit()

    await run_migration(db)

    mappings = await get_all_mappings(db)
    keys = [m["key"] for m in mappings]

    assert "oliveoil" in keys
    assert "peanutbutter" in keys
    assert "olive oil" not in keys
    assert "peanut butter" not in keys

    # Verify data is preserved (display_name, times_seen)
    olive = next(m for m in mappings if m["key"] == "oliveoil")
    assert olive["display_name"] == "Olive Oil"
    assert olive["times_seen"] == 2


@pytest.mark.asyncio
async def test_fix_is_idempotent(db):
    """Running the migration multiple times should be safe."""
    await insert_mapping(db, "groundbeef", "Ground Beef", "Meat & Seafood", times_seen=1)
    await insert_mapping(db, "ground beef", "Ground Beef", "Meat & Seafood", times_seen=5)
    await insert_mapping(db, "olive oil", "Olive Oil", "Pantry", times_seen=2)
    await db.commit()

    # Run migration 3 times
    await run_migration(db)
    await run_migration(db)
    await run_migration(db)

    mappings = await get_all_mappings(db)
    keys = [m["key"] for m in mappings]

    for key in keys:
        assert " " not in key

    # No duplicate keys
    assert len(keys) == len(set(keys)), f"Duplicate keys found: {keys}"


@pytest.mark.asyncio
async def test_fix_no_spaces_is_noop(db):
    """When no keys have spaces, migration is a no-op."""
    mappings_before = await get_all_mappings(db)

    await run_migration(db)

    mappings_after = await get_all_mappings(db)
    assert mappings_before == mappings_after
