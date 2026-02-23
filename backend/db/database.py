import logging
import aiosqlite
import os

logger = logging.getLogger("tabulate.db")
DB_PATH = os.environ.get("DB_PATH", "/data/tabulate.db")

async def get_db() -> aiosqlite.Connection:
    """Dependency: yields an open DB connection."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute("PRAGMA foreign_keys = ON")
        yield db

async def init_db():
    """Create all tables if they don't exist, and run any pending migrations."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(SCHEMA)
        # ── Migrations: add columns introduced after initial schema ──────────
        # SQLite doesn't support ALTER TABLE IF NOT EXISTS column, so we
        # check PRAGMA table_info first and only ALTER if the column is missing.
        async with db.execute("PRAGMA table_info(receipts)") as cur:
            cols = {row[1] async for row in cur}
        if "thumbnail_path" not in cols:
            await db.execute(
                "ALTER TABLE receipts ADD COLUMN thumbnail_path TEXT"
            )
            logger.info("Migration: added receipts.thumbnail_path")
        # categories.is_disabled (added after initial schema)
        async with db.execute("PRAGMA table_info(categories)") as cur:
            cat_cols = {row[1] async for row in cur}
        if "is_disabled" not in cat_cols:
            await db.execute(
                "ALTER TABLE categories ADD COLUMN is_disabled INTEGER NOT NULL DEFAULT 0"
            )
            logger.info("Migration: added categories.is_disabled")
        # Collapse spaces in normalized_key so OCR variants match
        # (e.g. "ground beef" → "groundbeef", "ice cream" → "icecream").
        # Runs on every startup but only touches rows that still contain spaces.
        # Use UPDATE OR IGNORE to skip rows whose collapsed key already exists,
        # then delete any remaining space-containing duplicates.
        await db.execute(
            "UPDATE OR IGNORE item_mappings SET normalized_key = REPLACE(normalized_key, ' ', '') "
            "WHERE normalized_key LIKE '% %'"
        )
        await db.execute(
            "DELETE FROM item_mappings WHERE normalized_key LIKE '% %'"
        )
        await db.commit()
    logger.info("Initialized at %s", DB_PATH)


SCHEMA = """
-- ── User-defined (and built-in) categories ────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    color       TEXT NOT NULL DEFAULT '#8a7d6b',  -- hex color for UI
    icon        TEXT NOT NULL DEFAULT '🏷️',
    is_builtin  INTEGER NOT NULL DEFAULT 0,        -- 1 = shipped with app
    is_disabled INTEGER NOT NULL DEFAULT 0,        -- 1 = hidden from category picker / AI
    sort_order  INTEGER NOT NULL DEFAULT 100,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- Seed the built-in categories (INSERT OR IGNORE so re-runs are safe)
INSERT OR IGNORE INTO categories (name, color, icon, is_builtin, sort_order) VALUES
    ('Produce',        '#2d7a4f', '🥦', 1, 10),
    ('Meat & Seafood', '#c4622d', '🥩', 1, 20),
    ('Dairy & Eggs',   '#2d5fa0', '🥛', 1, 30),
    ('Snacks',         '#d4a017', '🍿', 1, 40),
    ('Beverages',      '#6b4fa0', '🧃', 1, 50),
    ('Pantry',         '#8a7d6b', '🥫', 1, 60),
    ('Frozen',         '#4a90a4', '🧊', 1, 70),
    ('Household',      '#a06b4f', '🧹', 1, 80),
    ('Other',          '#b0a090', '📦', 1, 90);

-- Stores visited
CREATE TABLE IF NOT EXISTS stores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT DEFAULT (datetime('now'))
);

-- Scanned receipts
CREATE TABLE IF NOT EXISTS receipts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        INTEGER REFERENCES stores(id),
    store_name      TEXT NOT NULL,         -- denormalized for convenience
    receipt_date    TEXT,                  -- ISO date from receipt
    scanned_at      TEXT DEFAULT (datetime('now')),
    image_path      TEXT,                  -- path to stored image file
    thumbnail_path  TEXT,                  -- path to compressed thumbnail (generated on upload)
    ocr_raw         TEXT,                  -- raw OCR output
    subtotal        REAL,
    tax             REAL,
    discounts       REAL DEFAULT 0,
    total           REAL,
    total_verified  INTEGER DEFAULT 0,     -- 1 if math checks out
    status          TEXT DEFAULT 'pending' -- pending | review | verified
);

-- Individual line items on a receipt
CREATE TABLE IF NOT EXISTS line_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id      INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    raw_name        TEXT NOT NULL,         -- exactly as OCR read it
    clean_name      TEXT,                  -- normalized name
    price           REAL NOT NULL,
    quantity        REAL DEFAULT 1,
    category        TEXT,
    category_source TEXT DEFAULT 'ai',     -- 'ai' | 'learned' | 'manual'
    ai_confidence   REAL,                  -- 0.0–1.0 from Claude
    corrected       INTEGER DEFAULT 0      -- 1 if user manually changed category
);

-- Learned item→category mappings (the "memory" of the system)
CREATE TABLE IF NOT EXISTS item_mappings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    normalized_key  TEXT NOT NULL UNIQUE,  -- lowercased, stripped key
    display_name    TEXT NOT NULL,
    category        TEXT NOT NULL,
    source          TEXT DEFAULT 'manual', -- 'manual' | 'ai'
    times_seen      INTEGER DEFAULT 1,
    last_seen       TEXT DEFAULT (datetime('now')),
    created_at      TEXT DEFAULT (datetime('now'))
);

-- Pre-seed common items so the system isn't totally empty on first run
-- Keys are space-free (letters only) so OCR variants like "ground beef" /
-- "groundbeef" collapse to the same lookup key.
INSERT OR IGNORE INTO item_mappings (normalized_key, display_name, category, source, times_seen) VALUES
    ('milk',         'Milk',          'Dairy & Eggs',   'manual', 1),
    ('eggs',         'Eggs',          'Dairy & Eggs',   'manual', 1),
    ('butter',       'Butter',        'Dairy & Eggs',   'manual', 1),
    ('cheese',       'Cheese',        'Dairy & Eggs',   'manual', 1),
    ('yogurt',       'Yogurt',        'Dairy & Eggs',   'manual', 1),
    ('bananas',      'Bananas',       'Produce',        'manual', 1),
    ('apples',       'Apples',        'Produce',        'manual', 1),
    ('bread',        'Bread',         'Pantry',         'manual', 1),
    ('chicken',      'Chicken',       'Meat & Seafood', 'manual', 1),
    ('groundbeef',   'Ground Beef',   'Meat & Seafood', 'manual', 1),
    ('salmon',       'Salmon',        'Meat & Seafood', 'manual', 1),
    ('pasta',        'Pasta',         'Pantry',         'manual', 1),
    ('rice',         'Rice',          'Pantry',         'manual', 1),
    ('orangejuice',  'Orange Juice',  'Beverages',      'manual', 1),
    ('soda',         'Soda',          'Beverages',      'manual', 1),
    ('water',        'Water',         'Beverages',      'manual', 1),
    ('chips',        'Chips',         'Snacks',         'manual', 1),
    ('crackers',     'Crackers',      'Snacks',         'manual', 1),
    ('icecream',     'Ice Cream',     'Frozen',         'manual', 1),
    ('frozenpizza',  'Frozen Pizza',  'Frozen',         'manual', 1),
    ('soap',         'Soap',          'Household',      'manual', 1),
    ('laundry',      'Laundry',       'Household',      'manual', 1),
    ('papertowels',  'Paper Towels',  'Household',      'manual', 1);

-- Monthly summaries cache (rebuilt on demand)
CREATE TABLE IF NOT EXISTS monthly_summary (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL,
    category    TEXT NOT NULL,
    total       REAL NOT NULL,
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(year, month, category)
);
"""
