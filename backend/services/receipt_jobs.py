"""
receipt_jobs.py — in-process background runner for receipt processing.

An upload is accepted (bytes on disk, a `processing` receipt row) before any
slow work starts. The slow work — Claude / Tesseract extraction — then runs
here as a background task that is not tied to the HTTP request, so a client
that disconnects or navigates away doesn't lose the receipt.

What this module owns:
  - a concurrency cap (PROCESSING_CONCURRENCY, default 2) so a batch of
    uploads doesn't fire a dozen Claude calls and hold a dozen full-resolution
    images in memory at once
  - the live progress snapshot of each running job (for polling)
  - fan-out of progress events to any stream subscribers
  - the terminal event of recently finished jobs

The DB is the source of truth for *which* receipts still need processing
(status = 'processing'); everything here is rebuilt from it on startup, so a
single uvicorn process is assumed but a restart loses nothing.
"""
import asyncio
import logging
import os
from collections import OrderedDict
from typing import Awaitable, Callable, Optional

logger = logging.getLogger("tabulate.jobs")

ProgressFn = Callable[..., None]
# The work for one receipt: reports progress, returns the terminal event
# ({"type": "result", "data": ...} or {"type": "error", "status", "detail"}).
Work = Callable[[ProgressFn], Awaitable[dict]]

_RECENT_RESULTS = 200


def _concurrency() -> int:
    try:
        return max(1, int(os.environ.get("PROCESSING_CONCURRENCY", "").strip() or 2))
    except ValueError:
        logger.warning("Ignoring invalid PROCESSING_CONCURRENCY=%r", os.environ.get("PROCESSING_CONCURRENCY"))
        return 2


def merge_progress(snapshot: dict, stage: str, detail: dict) -> dict:
    """Fold one progress event into a job's snapshot.

    A poller only sees the latest snapshot, never every event, so the snapshot
    must stay meaningful on its own: while Claude re-reads a receipt whose
    totals didn't reconcile, the stage stays `rechecking` (the re-read's own
    `reading` events only update the item count), and falling back to OCR
    drops the item count of the abandoned AI pass.
    """
    out = dict(snapshot)
    if stage == "reading" and detail.get("method") == "ocr" and out.get("method") != "ocr":
        out.pop("items", None)
    if not (stage == "reading" and out.get("stage") == "rechecking"):
        out["stage"] = stage
    out.update(detail)
    return out


class ReceiptJobs:
    def __init__(self) -> None:
        self._tasks: dict[int, asyncio.Task] = {}
        self._snapshots: dict[int, dict] = {}
        self._subscribers: dict[int, list[asyncio.Queue]] = {}
        self._results: "OrderedDict[int, dict]" = OrderedDict()
        self._semaphore: Optional[asyncio.Semaphore] = None
        self._semaphore_loop: Optional[asyncio.AbstractEventLoop] = None

    # ── Submitting ────────────────────────────────────────────────────────────

    def _sem(self) -> asyncio.Semaphore:
        # One semaphore per event loop (tests run each case on a fresh loop).
        loop = asyncio.get_running_loop()
        if self._semaphore is None or self._semaphore_loop is not loop:
            self._semaphore = asyncio.Semaphore(_concurrency())
            self._semaphore_loop = loop
        return self._semaphore

    def submit(self, receipt_id: int, work: Work) -> asyncio.Task:
        """Start (or queue, when at the concurrency cap) the work for a receipt."""
        self._results.pop(receipt_id, None)
        self._snapshots[receipt_id] = {"stage": "queued"}
        task = asyncio.create_task(self._run(receipt_id, work))
        # Strong reference: the event loop only keeps weak references to tasks.
        self._tasks[receipt_id] = task
        return task

    async def _run(self, receipt_id: int, work: Work) -> None:
        def progress(stage: str, **detail) -> None:
            self._snapshots[receipt_id] = merge_progress(
                self._snapshots.get(receipt_id, {}), stage, detail)
            self._publish(receipt_id, {"type": "progress", "stage": stage, **detail})

        terminal: Optional[dict] = None
        try:
            async with self._sem():
                terminal = await work(progress)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Receipt %s: processing crashed", receipt_id)
            terminal = {"type": "error", "status": 500, "detail": "Receipt processing failed"}
        finally:
            if self._tasks.get(receipt_id) is asyncio.current_task():
                del self._tasks[receipt_id]
                self._snapshots.pop(receipt_id, None)
            if terminal is not None:
                self._results[receipt_id] = terminal
                while len(self._results) > _RECENT_RESULTS:
                    self._results.popitem(last=False)
                self._publish(receipt_id, terminal)
            # End every subscriber's stream, finished or cancelled.
            for queue in self._subscribers.pop(receipt_id, []):
                queue.put_nowait(None)

    def _publish(self, receipt_id: int, event: dict) -> None:
        for queue in self._subscribers.get(receipt_id, []):
            queue.put_nowait(event)

    # ── Observing ─────────────────────────────────────────────────────────────

    def is_running(self, receipt_id: int) -> bool:
        return receipt_id in self._tasks

    def snapshot(self, receipt_id: int) -> Optional[dict]:
        """Latest progress of a queued/running job ({"stage": ..., ...}), else None."""
        snap = self._snapshots.get(receipt_id)
        return dict(snap) if snap is not None else None

    def result(self, receipt_id: int) -> Optional[dict]:
        """Terminal event of a recently finished job, if still remembered."""
        return self._results.get(receipt_id)

    def subscribe(self, receipt_id: int) -> asyncio.Queue:
        """Queue of this job's events from now on, ending with None.

        Call it straight after submit() (before awaiting anything) to see every
        event. For a job that isn't running the queue ends immediately.
        """
        queue: asyncio.Queue = asyncio.Queue()
        if receipt_id in self._tasks:
            self._subscribers.setdefault(receipt_id, []).append(queue)
        else:
            queue.put_nowait(None)
        return queue

    def unsubscribe(self, receipt_id: int, queue: asyncio.Queue) -> None:
        subs = self._subscribers.get(receipt_id)
        if subs and queue in subs:
            subs.remove(queue)

    async def wait(self, receipt_id: int) -> Optional[dict]:
        """Wait for a job to finish and return its terminal event."""
        task = self._tasks.get(receipt_id)
        if task is not None:
            # shield: a caller that gives up waiting must not cancel the work.
            await asyncio.shield(task)
        return self._results.get(receipt_id)

    # ── Stopping ──────────────────────────────────────────────────────────────

    async def cancel(self, receipt_id: int) -> None:
        """Stop a receipt's job (used when the receipt is deleted mid-processing)."""
        task = self._tasks.get(receipt_id)
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    async def shutdown(self) -> None:
        """Cancel everything in flight. Receipts stay `processing` in the DB and
        are picked up again on the next start."""
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def reset(self) -> None:
        """Stop everything and forget finished jobs (test isolation)."""
        await self.shutdown()
        self._tasks.clear()
        self._snapshots.clear()
        self._subscribers.clear()
        self._results.clear()


jobs = ReceiptJobs()
