"""
Shared fixtures for backend tests.

Every test gets a fresh in-memory SQLite database with the minimum schema
needed.  Tables mirror the production schema in db/database.py but skip
seed data so tests start from a clean slate (unless a fixture adds rows).
"""
import pytest
import aiosqlite

# ── Minimal schema (matches production but no seed rows) ─────────────────────

SCHEMA = """
CREATE TABLE categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    color       TEXT NOT NULL DEFAULT '#8a7d6b',
    icon        TEXT NOT NULL DEFAULT '🏷️',
    is_builtin  INTEGER NOT NULL DEFAULT 0,
    is_disabled INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    created_at  TEXT DEFAULT (datetime('now'))
);

INSERT INTO categories (name, color, icon, is_builtin, sort_order) VALUES
    ('Produce',        '#2d7a4f', '🥦', 1, 10),
    ('Meat & Seafood', '#c4622d', '🥩', 1, 20),
    ('Dairy & Eggs',   '#2d5fa0', '🥛', 1, 30),
    ('Snacks',         '#d4a017', '🍿', 1, 40),
    ('Beverages',      '#6b4fa0', '🧃', 1, 50),
    ('Pantry',         '#8a7d6b', '🥫', 1, 60),
    ('Frozen',         '#4a90a4', '🧊', 1, 70),
    ('Household',      '#a06b4f', '🧹', 1, 80),
    ('Other',          '#b0a090', '📦', 1, 90);

CREATE TABLE stores (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE receipts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        INTEGER REFERENCES stores(id),
    store_name      TEXT NOT NULL,
    receipt_date    TEXT,
    scanned_at      TEXT DEFAULT (datetime('now')),
    image_path      TEXT,
    thumbnail_path  TEXT,
    ocr_raw         TEXT,
    subtotal        REAL,
    tax             REAL,
    discounts       REAL DEFAULT 0,
    total           REAL,
    total_verified  INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'pending'
);

CREATE TABLE line_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id      INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    raw_name        TEXT NOT NULL,
    clean_name      TEXT,
    price           REAL NOT NULL,
    quantity        REAL DEFAULT 1,
    category        TEXT,
    category_source TEXT DEFAULT 'ai',
    ai_confidence   REAL,
    corrected       INTEGER DEFAULT 0
);

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

CREATE TABLE monthly_summary (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    year        INTEGER NOT NULL,
    month       INTEGER NOT NULL,
    category    TEXT NOT NULL,
    total       REAL NOT NULL,
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(year, month, category)
);
"""


@pytest.fixture
async def db():
    """Yield a fresh in-memory SQLite connection with the full schema."""
    async with aiosqlite.connect(":memory:") as conn:
        conn.row_factory = aiosqlite.Row
        await conn.execute("PRAGMA foreign_keys = ON")
        await conn.executescript(SCHEMA)
        yield conn
