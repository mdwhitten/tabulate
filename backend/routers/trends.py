"""
Trends Router

GET /api/trends/monthly                       — spending by category for last N months
GET /api/trends/monthly/{year}/{month}        — single month detail
GET /api/trends/monthly/{year}/{month}/items  — line items for a category in a month
GET /api/trends/stores                        — spending by store
"""
from datetime import datetime, date
from calendar import month_abbr

from fastapi import APIRouter, Depends, Query
import aiosqlite

from db.database import get_db
from models.schemas import TrendsResponse, MonthSummary, CategoryItemDetail
from services.categorize_service import get_categories

router = APIRouter()


async def _get_monthly_totals(db: aiosqlite.Connection, months: int = 6) -> list[dict]:
    """
    Aggregate line item spending by (year, month, category) for the last N months.
    Uses the monthly_summary cache when available, rebuilds on miss.
    """
    async with db.execute(
        """
        SELECT
            CAST(strftime('%Y', COALESCE(r.receipt_date, r.scanned_at)) AS INTEGER) AS year,
            CAST(strftime('%m', COALESCE(r.receipt_date, r.scanned_at)) AS INTEGER) AS month,
            li.category,
            ROUND(SUM(li.price * li.quantity), 2) AS total
        FROM line_items li
        JOIN receipts r ON r.id = li.receipt_id
        WHERE r.status = 'verified'
          AND li.category IS NOT NULL
          AND COALESCE(r.receipt_date, r.scanned_at) >= date('now', ? || ' months')
        GROUP BY year, month, li.category
        ORDER BY year, month
        """,
        (f"-{months}",),
    ) as cur:
        rows = await cur.fetchall()

    return [dict(r) for r in rows]


@router.get("/monthly", response_model=TrendsResponse)
async def monthly_trends(
    months: int = Query(default=6, ge=1, le=24),
    db: aiosqlite.Connection = Depends(get_db),
):
    rows = await _get_monthly_totals(db, months)
    all_categories = await get_categories(db)

    month_map: dict[tuple, dict] = {}
    for row in rows:
        key = (row["year"], row["month"])
        if key not in month_map:
            month_map[key] = {}
        month_map[key][row["category"]] = row["total"]

    summaries = []
    for (year, month), by_cat in sorted(month_map.items()):
        filled = {cat: by_cat.get(cat, 0.0) for cat in all_categories}
        total = round(sum(filled.values()), 2)
        summaries.append(MonthSummary(
            year=year, month=month,
            month_label=f"{month_abbr[month]} {year}",
            total=total, by_category=filled,
        ))

    return TrendsResponse(months=summaries, categories=all_categories)


@router.get("/monthly/{year}/{month}")
async def single_month(
    year: int,
    month: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Detailed breakdown for a single month including per-store totals."""
    async with db.execute(
        """
        SELECT li.category,
               r.store_name,
               COUNT(li.id) as item_count,
               ROUND(SUM(li.price * li.quantity), 2) AS total
        FROM line_items li
        JOIN receipts r ON r.id = li.receipt_id
        WHERE r.status = 'verified'
          AND CAST(strftime('%Y', COALESCE(r.receipt_date, r.scanned_at)) AS INTEGER) = ?
          AND CAST(strftime('%m', COALESCE(r.receipt_date, r.scanned_at)) AS INTEGER) = ?
        GROUP BY li.category, r.store_name
        ORDER BY total DESC
        """,
        (year, month),
    ) as cur:
        rows = await cur.fetchall()

    return {
        "year": year,
        "month": month,
        "month_label": f"{month_abbr[month]} {year}",
        "breakdown": [dict(r) for r in rows],
    }


@router.get("/monthly/{year}/{month}/items", response_model=list[CategoryItemDetail])
async def category_items(
    year: int,
    month: int,
    category: str = Query(...),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Return individual line items for a specific category in a given month."""
    async with db.execute(
        """
        SELECT
            li.clean_name,
            li.raw_name,
            li.price,
            li.quantity,
            r.store_name,
            COALESCE(r.receipt_date, r.scanned_at) AS receipt_date
        FROM line_items li
        JOIN receipts r ON r.id = li.receipt_id
        WHERE r.status = 'verified'
          AND li.category = ?
          AND CAST(strftime('%Y', COALESCE(r.receipt_date, r.scanned_at)) AS INTEGER) = ?
          AND CAST(strftime('%m', COALESCE(r.receipt_date, r.scanned_at)) AS INTEGER) = ?
        ORDER BY li.price * li.quantity DESC
        """,
        (category, year, month),
    ) as cur:
        rows = await cur.fetchall()

    return [dict(r) for r in rows]


@router.get("/stores")
async def store_breakdown(
    months: int = Query(default=3, ge=1, le=12),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Spending by store for the last N months."""
    async with db.execute(
        """
        SELECT r.store_name,
               COUNT(DISTINCT r.id) as receipt_count,
               ROUND(SUM(r.total), 2) as total_spent,
               ROUND(AVG(r.total), 2) as avg_trip
        FROM receipts r
        WHERE r.status = 'verified'
          AND r.total IS NOT NULL
          AND COALESCE(r.receipt_date, r.scanned_at) >= date('now', ? || ' months')
        GROUP BY r.store_name
        ORDER BY total_spent DESC
        """,
        (f"-{months}",),
    ) as cur:
        rows = await cur.fetchall()

    return [dict(r) for r in rows]


@router.get("/summary")
async def dashboard_summary(db: aiosqlite.Connection = Depends(get_db)):
    """Quick stats for the dashboard header cards."""
    now = datetime.now()

    # Verified receipts this month → spending total + verified count
    async with db.execute(
        """
        SELECT
            ROUND(SUM(r.total), 2) as month_total,
            COUNT(DISTINCT r.id)   as verified_count
        FROM receipts r
        WHERE r.status = 'verified'
          AND strftime('%Y-%m', COALESCE(r.receipt_date, r.scanned_at)) = strftime('%Y-%m', 'now')
        """
    ) as cur:
        row = await cur.fetchone()

    # All-time total scanned (any status) — this is what "Receipts Scanned" should show
    async with db.execute("SELECT COUNT(*) as cnt FROM receipts") as cur:
        scanned_row = await cur.fetchone()

    async with db.execute("SELECT COUNT(*) as cnt FROM item_mappings") as cur:
        mappings_row = await cur.fetchone()

    async with db.execute(
        """
        SELECT ROUND(AVG(r.total), 2) as avg_trip
        FROM receipts r
        WHERE r.status = 'verified'
          AND r.total IS NOT NULL
          AND COALESCE(r.receipt_date, r.scanned_at) >= date('now', '-3 months')
        """
    ) as cur:
        avg_row = await cur.fetchone()

    return {
        "month_total": row["month_total"] or 0,
        "receipt_count": scanned_row["cnt"] or 0,   # all-time scanned (any status)
        "items_learned": mappings_row["cnt"] or 0,
        "avg_trip": avg_row["avg_trip"] or 0,
    }
