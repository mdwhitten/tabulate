"""
YNAB Integration Service

Optional, opt-in sync of approved receipts into a YNAB budget as transactions.

Design:
  - The access token comes from the YNAB_API_TOKEN env var (never stored in the DB).
  - All other config (enabled flag, budget, account, default category, and the
    optional per-Tabulate-category → YNAB-category mapping) lives in the DB
    (`app_settings` + `ynab_category_map`).
  - On approval a transaction is created as an *unapproved, uncleared* transaction
    with NO import_id, so YNAB auto-matches it against the real bank charge when it
    later imports (imported → user-entered, same amount, date ±10 days).
  - On re-sync of an edited receipt: a single-category transaction is updated in
    place (preserving any YNAB match). A split transaction cannot be updated via the
    API (YNAB ignores date/amount/category changes and can't alter subtransactions),
    so it is deleted and recreated.
  - Amounts use `receipt.total` (the real card charge). When a receipt spans more
    than one mapped YNAB category the transaction is split; the remainder between
    the line-item sum and the total (tax − discounts) lands in the default category.

Uses the official `ynab` SDK, which is synchronous — calls run in worker threads
via asyncio.to_thread. All amounts are integer *milliunits* ($1.00 == 1000),
negative for outflows.
"""
import asyncio
import datetime
import logging
import math
import os
from typing import Optional

import aiosqlite
import ynab
from ynab.rest import ApiException

logger = logging.getLogger("tabulate.ynab")

YNAB_API_TOKEN = os.environ.get("YNAB_API_TOKEN", "")

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


# ── YNAB SDK client + call wrapper ────────────────────────────────────────────
#
# The official `ynab` SDK is synchronous (urllib3), so every call runs in a worker
# thread via asyncio.to_thread to avoid blocking the event loop. `_call` maps the
# SDK's ApiException (and any transport error) into our YnabError. Note the SDK
# calls a budget a "plan".

def _client() -> ynab.ApiClient:
    if not YNAB_API_TOKEN:
        raise YnabError("YNAB_API_TOKEN not set")
    return ynab.ApiClient(ynab.Configuration(access_token=YNAB_API_TOKEN))


async def _call(fn, *args):
    """Run a synchronous SDK function in a thread, mapping errors to YnabError."""
    try:
        return await asyncio.to_thread(fn, *args)
    except YnabError:
        raise
    except ApiException as e:
        detail = getattr(e, "reason", None) or str(e)
        raise YnabError(f"YNAB API {getattr(e, 'status', '') or ''}: {detail}".strip()) from e
    except Exception as e:  # network / unexpected
        raise YnabError(f"YNAB request failed: {e}") from e


# ── Read endpoints (for the config UI) ────────────────────────────────────────

def _sync_list_budgets() -> list[dict]:
    with _client() as c:
        plans = ynab.PlansApi(c).get_plans().data.plans
    return [{"id": str(p.id), "name": p.name} for p in plans]


async def list_budgets() -> list[dict]:
    return await _call(_sync_list_budgets)


def _sync_list_accounts(budget_id: str) -> list[dict]:
    with _client() as c:
        accounts = ynab.AccountsApi(c).get_accounts(budget_id).data.accounts
    return [
        {"id": str(a.id), "name": a.name, "closed": bool(a.closed)}
        for a in accounts if not a.deleted
    ]


async def list_accounts(budget_id: str) -> list[dict]:
    return await _call(_sync_list_accounts, budget_id)


def _sync_list_categories(budget_id: str) -> list[dict]:
    with _client() as c:
        groups = ynab.CategoriesApi(c).get_categories(budget_id).data.category_groups
    out = []
    for g in groups:
        if g.deleted or g.hidden:
            continue
        cats = [
            {"id": str(cat.id), "name": cat.name}
            for cat in g.categories if not cat.deleted and not cat.hidden
        ]
        if cats:
            out.append({"id": str(g.id), "name": g.name, "categories": cats})
    return out


async def list_categories(budget_id: str) -> list[dict]:
    return await _call(_sync_list_categories, budget_id)


# ── Transaction API wrappers ──────────────────────────────────────────────────

def _sub_transactions(payload: dict) -> Optional[list]:
    subs = payload.get("subtransactions")
    if not subs:
        return None
    return [
        ynab.SaveSubTransaction(amount=s["amount"], category_id=s["category_id"])
        for s in subs
    ]


def _txn_kwargs(payload: dict) -> dict:
    # Note: the SDK field is `var_date` with alias `date`; it must be populated via
    # the alias ("date" key), not the field name.
    return {
        "account_id": payload["account_id"],
        "date": datetime.date.fromisoformat(payload["date"]),
        "amount": payload["amount"],
        "payee_name": payload.get("payee_name"),
        "memo": payload.get("memo"),
        "category_id": payload.get("category_id"),
        "cleared": ynab.TransactionClearedStatus(payload.get("cleared", "uncleared")),
        "approved": bool(payload.get("approved", False)),
        "subtransactions": _sub_transactions(payload),
    }


def _new_transaction(payload: dict) -> "ynab.NewTransaction":
    return ynab.NewTransaction(**_txn_kwargs(payload))


def _existing_transaction(payload: dict) -> "ynab.ExistingTransaction":
    return ynab.ExistingTransaction(**_txn_kwargs(payload))


def _sync_create_transaction(budget_id: str, payload: dict) -> str:
    with _client() as c:
        resp = ynab.TransactionsApi(c).create_transaction(
            budget_id, ynab.PostTransactionsWrapper(transaction=_new_transaction(payload))
        )
    txn = resp.data.transaction
    if txn is not None:
        return str(txn.id)
    ids = resp.data.transaction_ids or []
    return str(ids[0]) if ids else ""


async def _create_transaction(budget_id: str, payload: dict) -> str:
    return await _call(_sync_create_transaction, budget_id, payload)


def _sync_update_transaction(budget_id: str, txn_id: str, payload: dict) -> str:
    with _client() as c:
        resp = ynab.TransactionsApi(c).update_transaction(
            budget_id, txn_id,
            ynab.PutTransactionWrapper(transaction=_existing_transaction(payload)),
        )
    txn = resp.data.transaction
    return str(txn.id) if txn is not None else txn_id


async def _update_transaction(budget_id: str, txn_id: str, payload: dict) -> str:
    return await _call(_sync_update_transaction, budget_id, txn_id, payload)


def _sync_delete_transaction(budget_id: str, txn_id: str) -> None:
    with _client() as c:
        ynab.TransactionsApi(c).delete_transaction(budget_id, txn_id)


async def _delete_transaction(budget_id: str, txn_id: str) -> None:
    await _call(_sync_delete_transaction, budget_id, txn_id)


def _sync_get_transaction(budget_id: str, txn_id: str) -> Optional[dict]:
    with _client() as c:
        try:
            txn = ynab.TransactionsApi(c).get_transaction_by_id(budget_id, txn_id).data.transaction
        except ApiException as e:
            if getattr(e, "status", None) == 404:
                return None
            raise
    return {"id": str(txn.id), "is_split": bool(txn.subtransactions)}


async def _get_transaction(budget_id: str, txn_id: str) -> Optional[dict]:
    return await _call(_sync_get_transaction, budget_id, txn_id)


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
    distributes the tax/discount/reconciliation remainder proportionally across
    those categories so the parts sum exactly to the real charged total, and
    produces either a single transaction or a split (subtransactions).
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

    # Distribute the remainder (tax − discounts − rounding) proportionally across the
    # categories by each category's line-item share, so tax and reconciliation amounts
    # land with the goods they belong to rather than all in the default category. With
    # a single category the whole remainder folds into it. Uses the largest-remainder
    # method so the parts still sum exactly to the total.
    remainder = total_mu - sum(group_mu.values())
    if remainder != 0:
        subtotal = sum(group_dollars.values())
        if group_dollars and subtotal > 0:
            ycats = list(group_dollars.keys())
            exact = [remainder * group_dollars[y] / subtotal for y in ycats]
            alloc = [math.floor(x) for x in exact]
            leftover = remainder - sum(alloc)  # whole +1 milliunits still to hand out
            for i in sorted(range(len(ycats)), key=lambda i: exact[i] - alloc[i], reverse=True)[:leftover]:
                alloc[i] += 1
            for y, a in zip(ycats, alloc):
                group_mu[y] += a
        else:
            # No line-item subtotal to distribute against — fall back to default.
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
    new_is_split = "subtransactions" in payload

    try:
        if not existing_txn:
            txn_id = await _create_transaction(budget_id, payload)
        else:
            existing = await _get_transaction(budget_id, existing_txn)
            if existing is None:
                # Transaction no longer exists in YNAB — create a fresh one.
                txn_id = await _create_transaction(budget_id, payload)
            elif new_is_split or existing["is_split"]:
                # YNAB ignores edits to a split transaction's date/amount/category
                # and cannot alter its subtransactions, so delete and recreate to
                # reflect the current receipt. Clear the stored id first so a failed
                # create doesn't leave a dangling reference to the deleted txn.
                await _delete_transaction(budget_id, existing_txn)
                await db.execute(
                    "UPDATE receipts SET ynab_transaction_id = NULL WHERE id = ?",
                    (receipt_id,),
                )
                await db.commit()
                txn_id = await _create_transaction(budget_id, payload)
            else:
                # Single-category transaction — update in place (preserves any match).
                txn_id = await _update_transaction(budget_id, existing_txn, payload)
    except YnabError:
        await _set_sync_status(db, receipt_id, "failed")
        raise

    await _set_sync_status(db, receipt_id, "synced", transaction_id=txn_id)
    return {"status": "synced", "transaction_id": txn_id, "split": new_is_split}
