"""
Items Router

PATCH /api/items/{id}/category  — manually correct a line item's category
GET   /api/items/mappings       — list all learned mappings
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import aiosqlite

from db.database import get_db
from models.schemas import ItemMapping, PaginatedMappings
from services.categorize_service import apply_manual_correction, get_categories

router = APIRouter()


class CategoryUpdate(BaseModel):
    category: str


@router.patch("/{item_id}/category")
async def update_item_category(
    item_id: int,
    body: CategoryUpdate,
    db: aiosqlite.Connection = Depends(get_db),
):
    valid = await get_categories(db)
    if body.category not in valid:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid category. Must be one of: {', '.join(valid)}"
        )

    async with db.execute("SELECT id FROM line_items WHERE id = ?", (item_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Item not found")

    await apply_manual_correction(db, item_id, body.category)
    return {"status": "ok", "item_id": item_id, "category": body.category}


@router.patch("/mappings/{mapping_id}/category")
async def update_mapping_category(
    mapping_id: int,
    body: CategoryUpdate,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Directly update a learned mapping's category (from LearnedItems page)."""
    valid = await get_categories(db)
    if body.category not in valid:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid category. Must be one of: {', '.join(valid)}"
        )

    async with db.execute(
        "SELECT id, normalized_key FROM item_mappings WHERE id = ?", (mapping_id,)
    ) as cur:
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Mapping not found")

    await db.execute(
        "UPDATE item_mappings SET category = ?, source = 'manual', last_seen = datetime('now') WHERE id = ?",
        (body.category, mapping_id),
    )
    await db.commit()
    return {"status": "ok", "mapping_id": mapping_id, "category": body.category}


@router.get("/mappings", response_model=PaginatedMappings)
async def list_mappings(
    db: aiosqlite.Connection = Depends(get_db),
    limit: int = 50,
    offset: int = 0,
    search: str = "",
    category: str = "",
):
    where_clauses = []
    params: list = []

    if search:
        where_clauses.append(
            "(display_name LIKE ? OR normalized_key LIKE ? OR category LIKE ?)"
        )
        q = f"%{search}%"
        params.extend([q, q, q])

    if category:
        where_clauses.append("category = ?")
        params.append(category)

    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    async with db.execute(
        f"SELECT COUNT(*) FROM item_mappings{where_sql}", params
    ) as cur:
        total = (await cur.fetchone())[0]

    async with db.execute(
        f"""SELECT * FROM item_mappings{where_sql}
            ORDER BY times_seen DESC, last_seen DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    return PaginatedMappings(
        total=total,
        items=[
            ItemMapping(
                id=r["id"],
                normalized_key=r["normalized_key"],
                display_name=r["display_name"],
                category=r["category"],
                source=r["source"],
                times_seen=r["times_seen"],
                last_seen=r["last_seen"],
                created_at=r["created_at"],
            )
            for r in rows
        ],
    )


@router.get("/categories")
async def list_categories(db: aiosqlite.Connection = Depends(get_db)):
    """Return all category names (built-in + custom)."""
    return await get_categories(db)
