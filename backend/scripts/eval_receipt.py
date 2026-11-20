#!/usr/bin/env python3
"""
Evaluate the real Claude receipt extraction on a receipt file.

Runs the production code path — routers.receipts._prepare_image (PDF
rendering, EXIF orientation), services.receipt_ai.extract_receipt_with_ai
with the built-in category list, then ocr_service.verify_total — and reports
what came back against optional expectations.

Usage (from the repo root or backend/):

    ANTHROPIC_API_KEY=... python backend/scripts/eval_receipt.py receipt.pdf \\
        --expect-total 228.21 --expect-items 76 [--model M] [--effort E] [--runs N]

Exits 0 when every run succeeds and meets the expectations, 1 otherwise,
2 on usage errors. Each run makes real (billed) API calls.
"""
from __future__ import annotations

import argparse
import asyncio
import mimetypes
import os
import sys
import tempfile
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

TOTAL_TOLERANCE = 0.02


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Evaluate Claude receipt extraction on a receipt image or PDF.",
    )
    p.add_argument("receipt", type=Path, help="receipt image (JPEG/PNG/HEIC/...) or PDF")
    p.add_argument("--expect-total", type=float, help="expected receipt total, e.g. 228.21")
    p.add_argument("--expect-items", type=int, help="expected number of line items")
    p.add_argument("--model", help="override CLAUDE_MODEL for this run")
    p.add_argument("--effort", choices=["low", "medium", "high", "xhigh", "max"],
                   help="override CLAUDE_EFFORT for this run")
    p.add_argument("--runs", type=int, default=1, help="number of extraction runs (default 1)")
    p.add_argument("--no-items", action="store_true", help="don't print the item table")
    args = p.parse_args(argv)
    if args.runs < 1:
        p.error("--runs must be at least 1")
    if not args.receipt.is_file():
        p.error(f"no such file: {args.receipt}")
    return args


def fmt_money(value) -> str:
    return "—" if value is None else f"{float(value):.2f}"


def print_items(parsed) -> None:
    rows = [
        (
            item["raw_name"],
            f"{item['quantity']:g}",
            f"{item['price']:.2f}",
            f"{item['price'] * item['quantity']:.2f}",
            item.get("category") or "",
        )
        for item in parsed.raw_items
    ]
    headers = ("name", "qty", "price", "line", "category")
    name_w = min(36, max([len(headers[0])] + [len(r[0]) for r in rows]))
    widths = [name_w] + [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers) if i]
    print("  " + "  ".join(h.ljust(w) if i in (0, 4) else h.rjust(w)
                           for i, (h, w) in enumerate(zip(headers, widths))))
    for r in rows:
        cells = [r[0][:name_w].ljust(name_w), r[1].rjust(widths[1]), r[2].rjust(widths[2]),
                 r[3].rjust(widths[3]), r[4]]
        print("  " + "  ".join(cells))


async def run_once(n: int, args, image: bytes, pdf_text, categories) -> bool:
    from services.ocr_service import verify_total
    from services.receipt_ai import extract_receipt_with_ai

    events: list[tuple[str, dict]] = []
    started = time.monotonic()
    parsed = await extract_receipt_with_ai(
        image, categories, text_hint=pdf_text,
        on_progress=lambda stage, **d: events.append((stage, d)),
    )
    elapsed = time.monotonic() - started

    print(f"\n── Run {n}/{args.runs} " + "─" * 40)
    print(f"wall time       {elapsed:.1f}s")
    if parsed is None:
        print("result          FAILED — extraction returned nothing (see log above)")
        return False

    rechecked = any(stage == "rechecking" for stage, _ in events)
    verified, verify_msg = verify_total(parsed)
    items = len(parsed.raw_items)

    print(f"store / date    {parsed.store_name or '—'} / {parsed.receipt_date or '—'}")
    print(f"items           {items}")
    print(f"subtotal        {fmt_money(parsed.subtotal)}   (sum of extracted items)")
    print(f"tax             {fmt_money(parsed.tax)}")
    print(f"discounts       {fmt_money(parsed.discounts)}")
    print(f"total           {fmt_money(parsed.total)}")
    print(f"verify_total    {'OK' if verified else 'MISMATCH'} — {verify_msg}")
    print(f"re-check turn   {'yes' if rechecked else 'no'}")
    problems = getattr(parsed, "unresolved_problems", []) or []
    if problems:
        print("unresolved      " + "\n                ".join(problems))
    else:
        print("unresolved      none")

    ok = True
    checks = []
    if args.expect_total is not None:
        good = parsed.total is not None and abs(parsed.total - args.expect_total) <= TOTAL_TOLERANCE
        checks.append(f"total {fmt_money(parsed.total)} vs {args.expect_total:.2f}: "
                      f"{'PASS' if good else 'FAIL'}")
        ok &= good
    if args.expect_items is not None:
        good = items == args.expect_items
        checks.append(f"items {items} vs {args.expect_items}: {'PASS' if good else 'FAIL'}")
        ok &= good
    for line in checks:
        print(f"expectation     {line}")

    if not args.no_items and (args.runs == 1 or n == 1):
        print()
        print_items(parsed)
    return ok


async def main_async(args) -> int:
    import logging

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    # Keep the SDK's HTTP chatter out of the report.
    for noisy in ("httpx", "httpx2", "httpcore", "httpcore2", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # _prepare_image lives in the router module, which creates IMAGE_DIR on import.
    os.environ["IMAGE_DIR"] = tempfile.mkdtemp(prefix="tabulate-eval-")
    from routers.receipts import _prepare_image
    from services.categorize_service import _BUILTIN_CATEGORIES
    from services.receipt_ai import get_effort, get_model, segment_receipt_image

    raw = args.receipt.read_bytes()
    content_type = mimetypes.guess_type(args.receipt.name)[0]
    image, pdf_text = await asyncio.to_thread(_prepare_image, raw, content_type, None)
    segments = await asyncio.to_thread(segment_receipt_image, image)

    print(f"file            {args.receipt} ({len(raw) // 1024} KB, {content_type or 'unknown type'})")
    print(f"model           {get_model()}")
    print(f"effort          {get_effort()}")
    print(f"segments        {len(segments)}")
    print(f"pdf text layer  {'yes' if pdf_text else 'no'}")

    results = []
    for n in range(1, args.runs + 1):
        results.append(await run_once(n, args, image, pdf_text, list(_BUILTIN_CATEGORIES)))

    passed = sum(results)
    print(f"\n{passed}/{args.runs} run(s) passed")
    return 0 if passed == args.runs else 1


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set; it is required for the Claude extraction.",
              file=sys.stderr)
        return 2
    if args.model:
        os.environ["CLAUDE_MODEL"] = args.model
    if args.effort:
        os.environ["CLAUDE_EFFORT"] = args.effort
    try:
        return asyncio.run(main_async(args))
    except Exception as e:   # e.g. an unreadable PDF (HTTPException from _prepare_image)
        detail = getattr(e, "detail", None) or str(e)
        print(f"error: {detail}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
