"""
Categorization Service

Two-stage approach:
  1. Check the learned item_mappings table first (fast, zero API cost)
  2. For unknown items, call Claude API in a single batched request
     and persist the results back to the DB for next time.

Categories are fully dynamic — fetched from the `categories` table so
user-created custom categories work exactly like built-ins.
"""
import json
import logging
import os
import re
from typing import Optional

import anthropic
import aiosqlite

logger = logging.getLogger("tabulate.categorize")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")


class CategorizationError(Exception):
    """Raised when Claude API categorization fails (network, auth, parse error)."""
    pass

# Fallback list used only when DB is unavailable (e.g. during cold startup)
_BUILTIN_CATEGORIES = [
    "Produce", "Meat & Seafood", "Dairy & Eggs", "Snacks",
    "Beverages", "Pantry", "Frozen", "Household", "Other",
]


async def get_categories(db: aiosqlite.Connection) -> list[str]:
    """Return enabled category names ordered by sort_order."""
    async with db.execute(
        "SELECT name FROM categories WHERE is_disabled = 0 ORDER BY sort_order, name"
    ) as cur:
        rows = await cur.fetchall()
    return [r["name"] for r in rows] if rows else _BUILTIN_CATEGORIES


async def _build_system_prompt(db: aiosqlite.Connection) -> str:
    cats = await get_categories(db)
    return f"""You are a grocery receipt item categorizer.
Your job is to assign each grocery item to exactly one of these categories:
{', '.join(cats)}

Rules:
- Use only the listed category names, spelled exactly as shown.
- Base your decision on the item name and store context.
- When unsure, prefer a specific category over "Other".
- Return ONLY a JSON array. No prose, no markdown fences.

Input format: JSON array of objects with "id" and "name" fields, plus optional "store".
Output format: JSON array of objects with "id", "category", and "confidence" (0.0–1.0).
"""


def normalize_key(name: str) -> str:
    """Produce a stable lookup key from a raw item name.

    Spaces are stripped so that OCR variants like "KS Steakstrip" and
    "KSSteakstrip" collapse to the same key ("kssteakstrip").

    Items with no letters (e.g. "1/2 & 1/2") fall back to keeping
    digits so the key isn't empty.
    """
    key = name.lower()
    key = re.sub(r'\d+(\.\d+)?\s*(oz|lb|kg|g|ml|l|ct|pk|pack|count|fl oz)\b', '', key)
    key = re.sub(r'\b\d+\b', '', key)           # remove standalone numbers
    letters_only = re.sub(r'[^a-z]', '', key)   # keep only letters (no spaces)
    if letters_only:
        return letters_only
    # Fallback for symbol-heavy names like "1/2 & 1/2" — keep digits
    # but only when the original contains non-alphanumeric symbols
    if re.search(r'[^a-z0-9\s]', name.lower()):
        return re.sub(r'[^a-z0-9]', '', name.lower())
    return ''


def find_best_match(key: str, mappings: dict[str, str]) -> Optional[str]:
    """
    Try to match a normalized key against learned mappings.
    First exact, then longest substring match (most specific wins).

    Substring matches require the shorter key to be at least 50% the length
    of the longer key.  This prevents short generic seeds (e.g. "milk",
    4 chars) from false-matching long specific items (e.g.
    "tasteofthaicoconutmilk", 22 chars) while still allowing reasonable
    fuzzy matches (e.g. "coconutmilk" matching "organiccoconutmilk").
    """
    if not key:
        return None
    if key in mappings:
        return mappings[key]
    # Try partial matches — collect all and pick the longest (most specific)
    best_key = ""
    best_category = None
    for learned_key, category in mappings.items():
        if not learned_key:
            continue
        if learned_key in key or key in learned_key:
            shorter = min(len(learned_key), len(key))
            longer = max(len(learned_key), len(key))
            if shorter / longer < 0.5:
                continue  # too dissimilar in length — skip
            if len(learned_key) > len(best_key):
                best_key = learned_key
                best_category = category
    return best_category


async def load_mappings(db: aiosqlite.Connection) -> dict[str, str]:
    """Load learned item→category mappings, excluding disabled categories."""
    async with db.execute(
        """SELECT m.normalized_key, m.category
           FROM item_mappings m
           JOIN categories c ON c.name = m.category
           WHERE c.is_disabled = 0"""
    ) as cursor:
        rows = await cursor.fetchall()
    return {row["normalized_key"]: row["category"] for row in rows}


async def save_mapping(
    db: aiosqlite.Connection,
    raw_name: str,
    category: str,
    source: str = "ai",
    display_name: str | None = None,
):
    """Upsert a learned mapping back to the DB.

    Source priority: manual > ai.  An 'ai' upsert will never downgrade a
    'manual' mapping — only a 'manual' upsert can overwrite another manual.
    """
    key = normalize_key(raw_name)
    display = display_name or raw_name.strip().title()
    await db.execute(
        """
        INSERT INTO item_mappings (normalized_key, display_name, category, source, times_seen)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(normalized_key) DO UPDATE SET
            category   = CASE
                           WHEN excluded.source = 'manual' THEN excluded.category
                           WHEN item_mappings.source = 'manual' THEN item_mappings.category
                           ELSE excluded.category
                         END,
            source     = CASE
                           WHEN excluded.source = 'manual' THEN 'manual'
                           WHEN item_mappings.source = 'manual' THEN 'manual'
                           ELSE excluded.source
                         END,
            times_seen = times_seen + 1,
            last_seen  = datetime('now')
        """,
        (key, display, category, source),
    )


async def categorize_items(
    items: list[dict],   # [{id, raw_name, clean_name}, ...]
    store_name: str,
    db: aiosqlite.Connection,
) -> tuple[list[dict], bool]:
    """
    Categorize a list of items.
    Returns (results, categorization_failed) where results is a list of dicts
    with added 'category', 'category_source', 'ai_confidence', and
    categorization_failed is True when the Claude API call failed.
    """
    mappings = await load_mappings(db)
    results = []
    unknown = []
    categorization_failed = False

    # Stage 1 — learned mappings (always key on raw_name so the lookup is
    # stable regardless of how clean_name / display_name changes over time)
    for item in items:
        key = normalize_key(item["raw_name"])
        matched_cat = find_best_match(key, mappings)
        if matched_cat:
            results.append({
                **item,
                "category": matched_cat,
                "category_source": "learned",
                "ai_confidence": 1.0,
            })
        else:
            unknown.append(item)

    # Stage 2 — Claude API for unknown items
    if unknown:
        try:
            ai_results = await _call_claude(unknown, store_name, db)
        except CategorizationError:
            categorization_failed = True
            ai_results = [{"id": i["id"], "category": "Other", "confidence": 0.0} for i in unknown]

        for item, ai in zip(unknown, ai_results):
            category = ai.get("category", "Other")
            confidence = float(ai.get("confidence", 0.7))

            results.append({
                **item,
                "category": category,
                "category_source": "ai",
                "ai_confidence": confidence,
            })

    # NOTE: AI mappings are NOT persisted here — they are saved when the
    # receipt is approved (see persist_ai_mappings).  This prevents orphaned
    # mappings when the user cancels/deletes an unreviewed receipt.

    # Restore original order
    order = {item["id"]: i for i, item in enumerate(items)}
    results.sort(key=lambda r: order.get(r["id"], 0))
    return results, categorization_failed


async def _call_claude(items: list[dict], store_name: str, db: aiosqlite.Connection) -> list[dict]:
    """
    Send a batch of unknown items to Claude for categorization.
    Returns list of {id, category, confidence} in the same order.
    The system prompt is built dynamically so custom categories are included.
    """
    if not ANTHROPIC_API_KEY:
        logger.warning("ANTHROPIC_API_KEY not set — skipping AI categorization")
        raise CategorizationError("ANTHROPIC_API_KEY not set")

    system_prompt = await _build_system_prompt(db)
    payload = [
        {"id": item["id"], "name": item.get("clean_name") or item["raw_name"], "store": store_name}
        for item in items
    ]

    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    try:
        message = await client.messages.create(
            model="claude-haiku-4-5",
            max_tokens=1024,
            system=system_prompt,
            messages=[{"role": "user", "content": json.dumps(payload)}],
        )
        raw = message.content[0].text.strip()
        raw = re.sub(r'^```[a-z]*\n?', '', raw)
        raw = re.sub(r'\n?```$', '', raw)
        return json.loads(raw)
    except CategorizationError:
        raise
    except Exception as e:
        logger.error("Claude API error: %s", e)
        raise CategorizationError(str(e)) from e


async def apply_manual_correction(
    db: aiosqlite.Connection,
    item_id: int,
    new_category: str,
):
    """
    User corrected a category. Validate it exists in DB, then update and strengthen mapping.
    """
    # Validate category exists (covers both built-in and custom)
    async with db.execute(
        "SELECT id FROM categories WHERE name = ?", (new_category,)
    ) as cur:
        if not await cur.fetchone():
            raise ValueError(f"Unknown category: {new_category!r}")

    async with db.execute(
        "SELECT raw_name, clean_name FROM line_items WHERE id = ?", (item_id,)
    ) as cur:
        row = await cur.fetchone()
    if not row:
        return

    await db.execute(
        "UPDATE line_items SET category = ?, category_source = 'manual', corrected = 1 WHERE id = ?",
        (new_category, item_id),
    )
    # NOTE: the learned mapping is NOT saved here.  All mappings (manual and
    # AI) are persisted together when the receipt is approved via
    # persist_approved_mappings().  This keeps the DB clean if the user
    # later deletes the receipt without approving.
    await db.commit()


async def persist_approved_mappings(
    db: aiosqlite.Connection,
    receipt_id: int,
):
    """
    Persist learned mappings for ALL items on an approved receipt.

    Called only at approval time so that no mappings leak into the DB
    for receipts the user cancels or deletes.  Each item's
    ``category_source`` determines the mapping source priority:
    ``manual`` corrections get ``source='manual'`` (highest priority),
    everything else gets ``source='ai'``.
    """
    async with db.execute(
        """SELECT raw_name, clean_name, category, category_source
           FROM line_items
           WHERE receipt_id = ?""",
        (receipt_id,),
    ) as cur:
        rows = await cur.fetchall()

    for row in rows:
        source = "manual" if row["category_source"] == "manual" else "ai"
        display = (row["clean_name"] or row["raw_name"]).strip().title()
        await save_mapping(db, row["raw_name"], row["category"], source=source, display_name=display)
