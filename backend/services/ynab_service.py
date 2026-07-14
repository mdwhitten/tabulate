"""
YNAB Integration Service

Optional, opt-in sync of approved receipts into a YNAB budget as transactions.

Design:
  - The access token comes from the YNAB_API_TOKEN env var (never stored in the DB).
  - All other config (enabled flag, budget, account, default category, and the
    optional per-Tabulate-category → YNAB-category mapping) lives in the DB
    (`app_settings` + `ynab_category_map`).
  - On approval a transaction is created (or, on re-sync, updated) as an
    *unapproved, uncleared* transaction with NO import_id, so YNAB auto-matches it
    against the real bank charge when it later imports (imported → user-entered,
    same amount, date ±10 days).
  - Amounts use `receipt.total` (the real card charge). When a receipt spans more
    than one mapped YNAB category the transaction is split; the remainder between
    the line-item sum and the total (tax − discounts) lands in the default category.

All amounts YNAB sends/receives are integer *milliunits* ($1.00 == 1000), negative
for outflows.
"""
import logging
import os
from typing import Optional

import aiosqlite
import httpx

logger = logging.getLogger("tabulate.ynab")

YNAB_API_TOKEN = os.environ.get("YNAB_API_TOKEN", "")
YNAB_API_BASE = "https://api.ynab.com/v1"

# app_settings keys
KEY_ENABLED = "ynab_enabled"
KEY_BUDGET = "ynab_budget_id"
KEY_ACCOUNT = "ynab_account_id"
KEY_DEFAULT_CAT = "ynab_default_category_id"


class YnabError(Exception):
    """Raised when a YNAB API call fails (network, auth, or bad config)."""
    pass


# ── Config storage ────────────────────────────────────────────────────────────

async def _get_setting(db: aiosqlite.Connection, key: str) -> Optional[str]:
    async with db.execute("SELECT value FROM app_settings WHERE key = ?", (key,)) as cur:
        row = await cur.fetchone()
    return row["value"] if row else None


async def _set_setting(db: aiosqlite.Connection, key: str, value: Optional[str]) -> None:
    if value is None:
        await db.execute("DELETE FROM app_settings WHERE key = ?", (key,))
    else:
        await db.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


async def get_config(db: aiosqlite.Connection) -> dict:
    """Return the full YNAB config (never includes the token)."""
    enabled = (await _get_setting(db, KEY_ENABLED)) == "1"
    budget_id = await _get_setting(db, KEY_BUDGET)
    account_id = await _get_setting(db, KEY_ACCOUNT)
    default_category_id = await _get_setting(db, KEY_DEFAULT_CAT)

    async with db.execute(
        "SELECT category_id, ynab_category_id FROM ynab_category_map"
    ) as cur:
        rows = await cur.fetchall()
    mappings = [
        {"category_id": r["category_id"], "ynab_category_id": r["ynab_category_id"]}
        for r in rows
    ]

    return {
        "enabled": enabled,
        "token_present": bool(YNAB_API_TOKEN),
        "budget_id": budget_id,
        "account_id": account_id,
        "default_category_id": default_category_id,
        "configured": bool(budget_id and account_id and default_category_id),
        "mappings": mappings,
    }


async def save_config(db: aiosqlite.Connection, cfg: dict) -> dict:
    """Persist config. `cfg` keys: enabled, budget_id, account_id,
    default_category_id, mappings (list of {category_id, ynab_category_id})."""
    await _set_setting(db, KEY_ENABLED, "1" if cfg.get("enabled") else "0")
    await _set_setting(db, KEY_BUDGET, cfg.get("budget_id") or None)
    await _set_setting(db, KEY_ACCOUNT, cfg.get("account_id") or None)
    await _set_setting(db, KEY_DEFAULT_CAT, cfg.get("default_category_id") or None)

    # Replace the mapping table wholesale — simplest correct semantics.
    await db.execute("DELETE FROM ynab_category_map")
    for m in cfg.get("mappings", []) or []:
        ynab_cat = (m.get("ynab_category_id") or "").strip()
        cat_id = m.get("category_id")
        if not ynab_cat or cat_id is None:
            continue
        await db.execute(
            "INSERT INTO ynab_category_map (category_id, ynab_category_id) VALUES (?, ?) "
            "ON CONFLICT(category_id) DO UPDATE SET ynab_category_id = excluded.ynab_category_id",
            (int(cat_id), ynab_cat),
        )
    await db.commit()
    return await get_config(db)


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _client() -> httpx.AsyncClient:
    if not YNAB_API_TOKEN:
        raise YnabError("YNAB_API_TOKEN not set")
    return httpx.AsyncClient(
        base_url=YNAB_API_BASE,
        headers={"Authorization": f"Bearer {YNAB_API_TOKEN}"},
        timeout=15.0,
    )


async def _request(method: str, path: str, json: Optional[dict] = None) -> dict:
    try:
        async with _client() as client:
            resp = await client.request(method, path, json=json)
    except httpx.HTTPError as e:
        raise YnabError(f"YNAB request failed: {e}") from e

    if resp.status_code >= 400:
        detail = resp.text
        try:
            err = resp.json().get("error", {})
            detail = err.get("detail") or err.get("name") or detail
        except Exception:
            pass
        raise YnabError(f"YNAB API {resp.status_code}: {detail}")

    try:
        return resp.json().get("data", {})
    except Exception as e:
        raise YnabError(f"Invalid YNAB response: {e}") from e


# ── Read endpoints (for the config UI) ────────────────────────────────────────

async def list_budgets() -> list[dict]:
    data = await _request("GET", "/budgets")
    return [
        {"id": b["id"], "name": b["name"]}
        for b in data.get("budgets", [])
    ]


async def list_accounts(budget_id: str) -> list[dict]:
    data = await _request("GET", f"/budgets/{budget_id}/accounts")
    return [
        {"id": a["id"], "name": a["name"], "closed": a.get("closed", False)}
        for a in data.get("accounts", [])
        if not a.get("deleted")
    ]


async def list_categories(budget_id: str) -> list[dict]:
    """Return category groups with their (non-hidden, non-deleted) categories."""
    data = await _request("GET", f"/budgets/{budget_id}/categories")
    groups = []
    for g in data.get("category_groups", []):
        if g.get("deleted") or g.get("hidden"):
            continue
        cats = [
            {"id": c["id"], "name": c["name"]}
            for c in g.get("categories", [])
            if not c.get("deleted") and not c.get("hidden")
        ]
        if cats:
            groups.append({"id": g["id"], "name": g["name"], "categories": cats})
    return groups


# ── Transaction building (pure — unit-testable without HTTP) ───────────────────

def _to_milliunits(dollars: float) -> int:
    """Outflow in milliunits (negative)."""
    return -int(round(dollars * 1000))


def build_transaction_payload(
    receipt: dict,
    line_items: list[dict],
    account_id: str,
    default_category_id: str,
    name_to_ynab: dict,
) -> dict:
    """Build a YNAB SaveTransaction payload from a receipt.

    Groups line items by their mapped YNAB category (unmapped → default),
    reconciles the tax/discount remainder into the default category so the
    parts sum exactly to the real charged total, and produces either a single
    transaction or a split (subtransactions).
    """
    item_total = round(sum((li["price"] or 0) * (li.get("quantity") or 1) for li in line_items), 2)
    total_dollars = receipt.get("total")
    if total_dollars is None:
        total_dollars = item_total
    total_mu = _to_milliunits(total_dollars)

    # Sum dollars per resulting YNAB category.
    group_dollars: dict[str, float] = {}
    for li in line_items:
        line_total = (li["price"] or 0) * (li.get("quantity") or 1)
        ycat = name_to_ynab.get(li.get("category")) or default_category_id
        group_dollars[ycat] = group_dollars.get(ycat, 0.0) + line_total

    group_mu: dict[str, int] = {
        ycat: _to_milliunits(round(d, 2)) for ycat, d in group_dollars.items()
    }

    # Reconcile the remainder (tax − discounts − rounding) into the default category.
    remainder = total_mu - sum(group_mu.values())
    group_mu[default_category_id] = group_mu.get(default_category_id, 0) + remainder

    # Drop zero-amount splits; always keep at least one.
    group_mu = {k: v for k, v in group_mu.items() if v != 0}
    if not group_mu:
        group_mu = {default_category_id: total_mu}

    store = receipt.get("store_name") or None
    payload: dict = {
        "account_id": account_id,
        "date": receipt.get("receipt_date"),
        "amount": total_mu,
        "payee_name": store[:200] if store else None,
        "memo": f"Tabulate receipt #{receipt.get('id')}"[:200],
        "cleared": "uncleared",
        "approved": False,
    }

    if len(group_mu) == 1:
        payload["category_id"] = next(iter(group_mu))
    else:
        payload["category_id"] = None
        payload["subtransactions"] = [
            {"amount": amt, "category_id": ycat} for ycat, amt in group_mu.items()
        ]

    return payload


# ── Sync ──────────────────────────────────────────────────────────────────────

async def _load_name_to_ynab(db: aiosqlite.Connection) -> dict:
    async with db.execute(
        "SELECT c.name AS name, m.ynab_category_id AS ynab_category_id "
        "FROM ynab_category_map m JOIN categories c ON c.id = m.category_id"
    ) as cur:
        rows = await cur.fetchall()
    return {r["name"]: r["ynab_category_id"] for r in rows}


async def _set_sync_status(
    db: aiosqlite.Connection,
    receipt_id: int,
    status: str,
    transaction_id: Optional[str] = None,
    synced: bool = False,
) -> None:
    if transaction_id is not None:
        await db.execute(
            "UPDATE receipts SET ynab_sync_status = ?, ynab_transaction_id = ?, "
            "ynab_synced_at = datetime('now') WHERE id = ?",
            (status, transaction_id, receipt_id),
        )
    elif synced:
        await db.execute(
            "UPDATE receipts SET ynab_sync_status = ?, ynab_synced_at = datetime('now') "
            "WHERE id = ?",
            (status, receipt_id),
        )
    else:
        await db.execute(
            "UPDATE receipts SET ynab_sync_status = ? WHERE id = ?",
            (status, receipt_id),
        )
    await db.commit()


async def sync_receipt(db: aiosqlite.Connection, receipt_id: int) -> dict:
    """Create or update the YNAB transaction for a receipt.

    Returns {"status": "synced"|"skipped"|"failed", ...}. Raises YnabError on a
    hard API failure (the router surfaces it; the approval hook swallows it).
    """
    cfg = await get_config(db)

    if not cfg["enabled"]:
        return {"status": "skipped", "reason": "YNAB integration disabled"}
    if not cfg["token_present"]:
        await _set_sync_status(db, receipt_id, "failed")
        return {"status": "skipped", "reason": "YNAB_API_TOKEN not set"}
    if not cfg["configured"]:
        await _set_sync_status(db, receipt_id, "failed")
        return {"status": "skipped", "reason": "Budget, account, and default category must be configured"}

    async with db.execute(
        "SELECT id, store_name, receipt_date, total, ynab_transaction_id "
        "FROM receipts WHERE id = ?",
        (receipt_id,),
    ) as cur:
        receipt = await cur.fetchone()
    if not receipt:
        raise YnabError(f"Receipt {receipt_id} not found")
    receipt = dict(receipt)

    if not receipt.get("receipt_date"):
        await _set_sync_status(db, receipt_id, "failed")
        return {"status": "skipped", "reason": "Receipt has no date"}

    async with db.execute(
        "SELECT category, price, quantity FROM line_items WHERE receipt_id = ?",
        (receipt_id,),
    ) as cur:
        line_items = [dict(r) for r in await cur.fetchall()]

    if not line_items and receipt.get("total") is None:
        await _set_sync_status(db, receipt_id, "failed")
        return {"status": "skipped", "reason": "Receipt has no total or line items"}

    name_to_ynab = await _load_name_to_ynab(db)
    payload = build_transaction_payload(
        receipt, line_items, cfg["account_id"], cfg["default_category_id"], name_to_ynab
    )

    budget_id = cfg["budget_id"]
    existing_txn = receipt.get("ynab_transaction_id")

    try:
        if existing_txn:
            data = await _request(
                "PUT",
                f"/budgets/{budget_id}/transactions/{existing_txn}",
                json={"transaction": payload},
            )
        else:
            data = await _request(
                "POST",
                f"/budgets/{budget_id}/transactions",
                json={"transaction": payload},
            )
    except YnabError:
        await _set_sync_status(db, receipt_id, "failed")
        raise

    txn = data.get("transaction") or {}
    txn_id = txn.get("id") or (data.get("transaction_ids") or [existing_txn])[0]
    await _set_sync_status(db, receipt_id, "synced", transaction_id=txn_id)

    return {"status": "synced", "transaction_id": txn_id, "split": "subtransactions" in payload}
