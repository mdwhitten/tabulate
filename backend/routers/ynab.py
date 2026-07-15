"""
YNAB Router

Optional YNAB integration: connection status, configuration (budget / account /
default category / per-category mapping), YNAB dropdown data proxies, and manual
receipt sync.

GET  /api/ynab/status                          — connection + config summary
GET  /api/ynab/config                          — full config (incl. mappings)
PUT  /api/ynab/config                           — save config
GET  /api/ynab/budgets                          — list YNAB budgets
GET  /api/ynab/budgets/{budget_id}/accounts     — list accounts in a budget
GET  /api/ynab/budgets/{budget_id}/categories   — list category groups + categories
POST /api/ynab/receipts/{receipt_id}/sync       — create/update the YNAB transaction
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
import aiosqlite

from db.database import get_db
from services import ynab_service
from services.ynab_service import YnabError

router = APIRouter()


class MappingItem(BaseModel):
    category_id: int
    ynab_category_id: str


class YnabConfigBody(BaseModel):
    enabled: bool = False
    budget_id: Optional[str] = None
    account_id: Optional[str] = None
    default_category_id: Optional[str] = None
    mappings: list[MappingItem] = []


@router.get("/status")
async def status(db: aiosqlite.Connection = Depends(get_db)):
    cfg = await ynab_service.get_config(db)
    return {
        "enabled": cfg["enabled"],
        "token_present": cfg["token_present"],
        "budget_id": cfg["budget_id"],
        "account_id": cfg["account_id"],
        "default_category_id": cfg["default_category_id"],
        "configured": cfg["configured"],
    }


@router.get("/config")
async def get_config(db: aiosqlite.Connection = Depends(get_db)):
    return await ynab_service.get_config(db)


@router.put("/config")
async def put_config(
    body: YnabConfigBody,
    db: aiosqlite.Connection = Depends(get_db),
):
    cfg = {
        "enabled": body.enabled,
        "budget_id": body.budget_id,
        "account_id": body.account_id,
        "default_category_id": body.default_category_id,
        "mappings": [m.model_dump() for m in body.mappings],
    }
    return await ynab_service.save_config(db, cfg)


@router.get("/budgets")
async def budgets():
    try:
        return await ynab_service.list_budgets()
    except YnabError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/budgets/{budget_id}/accounts")
async def accounts(budget_id: str):
    try:
        return await ynab_service.list_accounts(budget_id)
    except YnabError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/budgets/{budget_id}/categories")
async def categories(budget_id: str):
    try:
        return await ynab_service.list_categories(budget_id)
    except YnabError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/receipts/{receipt_id}/sync")
async def sync_receipt(
    receipt_id: int,
    db: aiosqlite.Connection = Depends(get_db),
):
    async with db.execute("SELECT id FROM receipts WHERE id = ?", (receipt_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="Receipt not found")
    try:
        return await ynab_service.sync_receipt(db, receipt_id)
    except YnabError as e:
        raise HTTPException(status_code=502, detail=str(e))
