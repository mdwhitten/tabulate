"""
Tests for services.receipt_ai — the AI-first receipt extraction.

Covers:
- segment_receipt_image: tall receipts split into overlapping segments,
  short/landscape images stay whole, images are never upscaled
- find_discrepancies: total / item-count reconciliation
- _to_parsed: conversion of Claude's JSON into a ParsedReceipt
- extract_receipt_with_ai: no key, success, corrective follow-up turn,
  failure modes (refusal, max_tokens, API errors) and streamed progress

The Anthropic client is always faked; no network calls are made.
"""
import asyncio
import io
import json
from types import SimpleNamespace
from unittest.mock import patch

import anthropic
import httpx2
import pytest
from PIL import Image, ImageDraw

from services import receipt_ai
from services.receipt_ai import (
    TILE_MAX_HEIGHT,
    TILE_OVERLAP,
    TILE_WIDTH,
    _find_cut_rows,
    _to_parsed,
    build_schema,
    extract_receipt_with_ai,
    find_discrepancies,
    segment_receipt_image,
)

CATEGORIES = ["Produce", "Dairy & Eggs", "Pantry", "Other"]


# ── Helpers ──────────────────────────────────────────────────────────────────

def make_receipt_image(width: int, height: int, line_height: int = 20, gap: int = 20) -> bytes:
    """White image with black 'text line' bars separated by blank gaps."""
    img = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    y = gap
    while y + line_height < height:
        draw.rectangle([width // 10, y, width - width // 10, y + line_height], fill=(0, 0, 0))
        y += line_height + gap
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def item(name, line_total, qty=1, price=None, category="Pantry", display=None):
    return {
        "name": name,
        "display_name": display or name.title(),
        "quantity": qty,
        "price": price if price is not None else round(line_total / qty, 2),
        "line_total": line_total,
        "category": category,
    }


def aldi_like() -> dict:
    """Consistent extraction: 3 lines, 4 units, items 10.00, tax 0.50, savings 1.00."""
    return {
        "store_name": "ALDI",
        "receipt_date": "2026-03-01",
        "subtotal": 10.00,
        "tax": 0.50,
        "discounts": 1.00,
        "total": 9.50,
        "printed_item_count": 3,
        "items": [
            item("BANANAS", 2.00, category="Produce"),
            item("MILK GAL", 3.00, category="Dairy & Eggs"),
            item("PASTA", 5.00, qty=2, category="Pantry"),
        ],
    }


def text_message(data, stop_reason="end_turn", thinking=True):
    """A fake final Message: optional (empty) thinking block first, then text."""
    content = []
    if thinking:
        content.append(SimpleNamespace(type="thinking", thinking="", signature="sig"))
    if data is not None:
        content.append(SimpleNamespace(type="text", text=json.dumps(data)))
    return SimpleNamespace(content=content, stop_reason=stop_reason)


class FakeStream:
    def __init__(self, message, chunk_size=7):
        self._message = message
        text = next((b.text for b in message.content if b.type == "text"), "")
        self._chunks = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]

    async def _text(self):
        for chunk in self._chunks:
            await asyncio.sleep(0)
            yield chunk

    @property
    def text_stream(self):
        return self._text()

    async def get_final_message(self):
        return self._message


class FakeStreamManager:
    def __init__(self, outcome):
        self._outcome = outcome

    async def __aenter__(self):
        if isinstance(self._outcome, BaseException):
            raise self._outcome
        return FakeStream(self._outcome)

    async def __aexit__(self, *exc):
        return False


class FakeClient:
    """Stands in for anthropic.AsyncAnthropic; each stream() call consumes one outcome."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls: list[dict] = []
        self.closed = False
        self.messages = SimpleNamespace(stream=self._stream)

    async def close(self):
        self.closed = True

    def _stream(self, **kwargs):
        # Snapshot the conversation: the caller appends to the same list later.
        self.calls.append({**kwargs, "messages": list(kwargs["messages"])})
        return FakeStreamManager(self.outcomes.pop(0))


def fake_anthropic(client):
    return patch("services.receipt_ai.anthropic.AsyncAnthropic", return_value=client)


def status_error(code=500):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx2.Response(code, request=request)
    return anthropic.APIStatusError("boom", response=response, body=None)


@pytest.fixture
def api_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
    monkeypatch.delenv("CLAUDE_MODEL", raising=False)
    monkeypatch.delenv("CLAUDE_EFFORT", raising=False)


@pytest.fixture
def small_jpeg():
    return make_receipt_image(400, 600)


# ── segment_receipt_image ────────────────────────────────────────────────────

class TestSegmentReceiptImage:

    def test_tall_receipt_split_into_overlapping_segments(self):
        # 1800 × 8000 scales to 900 × 4000 → needs several segments
        segments = segment_receipt_image(make_receipt_image(1800, 8000))
        assert len(segments) >= 3

        sizes = [Image.open(io.BytesIO(s)).size for s in segments]
        for w, h in sizes:
            assert w <= TILE_WIDTH
            assert h <= TILE_MAX_HEIGHT
        assert all(w == TILE_WIDTH for w, _ in sizes)

        # Neighbouring segments share TILE_OVERLAP rows, so the heights add up
        # to more than the scaled image.
        total = sum(h for _, h in sizes)
        assert total == 4000 + TILE_OVERLAP * (len(segments) - 1)

    def test_cuts_land_in_blank_gaps(self):
        img = Image.open(io.BytesIO(make_receipt_image(900, 4000))).convert("L")
        cuts = _find_cut_rows(img, TILE_MAX_HEIGHT - TILE_OVERLAP)
        assert cuts
        pixels = img.load()
        for y in cuts:
            row = [pixels[x, y] for x in range(img.size[0])]
            assert min(row) > 200, f"cut at row {y} goes through printed text"

    def test_short_receipt_is_one_segment(self, small_jpeg):
        segments = segment_receipt_image(small_jpeg)
        assert len(segments) == 1

    def test_never_upscales(self, small_jpeg):
        (seg,) = segment_receipt_image(small_jpeg)
        assert Image.open(io.BytesIO(seg)).size == (400, 600)

    def test_landscape_image_is_one_segment_capped_on_long_edge(self):
        (seg,) = segment_receipt_image(make_receipt_image(2500, 1000))
        w, h = Image.open(io.BytesIO(seg)).size
        assert w == max(TILE_WIDTH, TILE_MAX_HEIGHT)
        assert h == 500

    def test_png_with_alpha_is_converted(self):
        buf = io.BytesIO()
        Image.new("RGBA", (300, 500), (255, 255, 255, 0)).save(buf, format="PNG")
        (seg,) = segment_receipt_image(buf.getvalue())
        assert Image.open(io.BytesIO(seg)).format == "JPEG"


# ── find_discrepancies ───────────────────────────────────────────────────────

class TestFindDiscrepancies:

    def test_consistent_receipt_has_no_problems(self):
        assert find_discrepancies(aldi_like()) == []

    def test_sum_mismatch_reported(self):
        data = aldi_like()
        data["items"].pop(0)        # a missed 2.00 line
        data["printed_item_count"] = None
        problems = find_discrepancies(data)
        assert len(problems) == 1
        assert "8.00" in problems[0] and "10.00" in problems[0]
        assert "-2.00" in problems[0]

    def test_printed_count_mismatch_reported(self):
        data = aldi_like()
        data["printed_item_count"] = 7
        problems = find_discrepancies(data)
        assert problems == ["The receipt prints 7 items, but 3 lines were returned."]

    def test_count_equal_to_quantity_sum_is_ok(self):
        data = aldi_like()
        data["printed_item_count"] = 4   # 1 + 1 + 2 units
        assert find_discrepancies(data) == []

    def test_within_rounding_tolerance(self):
        data = aldi_like()
        data["total"] = 9.51
        assert find_discrepancies(data) == []

    def test_missing_total_reported(self):
        data = aldi_like()
        data["total"] = None
        assert find_discrepancies(data) == ["No total was returned."]

    def test_no_items(self):
        data = aldi_like()
        data["items"] = []
        assert find_discrepancies(data) == ["No line items were returned."]


# ── _to_parsed ───────────────────────────────────────────────────────────────

class TestToParsed:

    def test_basic_fields(self):
        parsed = _to_parsed(aldi_like(), "pdf text")
        assert parsed.store_name == "ALDI"
        assert parsed.receipt_date == "2026-03-01"
        assert parsed.tax == 0.50
        assert parsed.discounts == 1.00
        assert parsed.total == 9.50
        assert parsed.raw_text == "pdf text"
        assert len(parsed.raw_items) == 3

    def test_categories_carried_through(self):
        parsed = _to_parsed(aldi_like(), None)
        assert [i["category"] for i in parsed.raw_items] == ["Produce", "Dairy & Eggs", "Pantry"]
        assert parsed.raw_text == ""

    def test_line_total_authoritative_over_bad_unit_price(self):
        data = aldi_like()
        data["items"] = [item("PASTA", 5.00, qty=2, price=25.00)]   # misread unit price
        (only,) = _to_parsed(data, None).raw_items
        assert only["quantity"] == 2
        assert only["price"] == 2.50

    def test_missing_unit_price_derived(self):
        data = aldi_like()
        bad = item("EGGS", 6.00, qty=3)
        bad["price"] = None
        data["items"] = [bad]
        (only,) = _to_parsed(data, None).raw_items
        assert only["price"] == 2.00

    def test_names_normalised(self):
        data = aldi_like()
        data["items"] = [item("kale bunch", 1.99, display="  ")]
        (only,) = _to_parsed(data, None).raw_items
        assert only["raw_name"] == "KALE BUNCH"
        assert only["clean_name"] == "Kale Bunch"   # blank display_name falls back

    def test_junk_rows_skipped(self):
        data = aldi_like()
        data["items"] = [
            item("", 1.00),                  # no name
            item("FREE SAMPLE", 0.00),       # zero amount
            item("COUPON", -1.00),           # negative
            item("TYPO", 25000.00),          # absurd amount
            {**item("NO TOTAL", 1.00), "line_total": None},
            item("REAL ITEM", 3.49),
        ]
        names = [i["raw_name"] for i in _to_parsed(data, None).raw_items]
        assert names == ["REAL ITEM"]

    def test_quantity_never_below_one(self):
        data = aldi_like()
        data["items"] = [item("APPLES", 2.00, qty=1, price=2.00)]
        data["items"][0]["quantity"] = 0
        (only,) = _to_parsed(data, None).raw_items
        assert only["quantity"] == 1


# ── build_schema ─────────────────────────────────────────────────────────────

def test_schema_constrains_category_to_enabled_list():
    schema = build_schema(CATEGORIES)
    cat = schema["properties"]["items"]["items"]["properties"]["category"]
    assert cat["enum"] == CATEGORIES
    assert schema["additionalProperties"] is False


# ── extract_receipt_with_ai ──────────────────────────────────────────────────

class TestExtractReceiptWithAi:

    async def test_no_api_key_returns_none_without_calling(self, monkeypatch, small_jpeg):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        with patch("services.receipt_ai.anthropic.AsyncAnthropic") as ctor:
            assert await extract_receipt_with_ai(small_jpeg, CATEGORIES) is None
        ctor.assert_not_called()

    async def test_success_single_call(self, api_key, small_jpeg):
        client = FakeClient([text_message(aldi_like())])
        with fake_anthropic(client):
            parsed = await extract_receipt_with_ai(small_jpeg, CATEGORIES, text_hint="TEXT LAYER")

        assert parsed is not None
        assert parsed.store_name == "ALDI"
        assert parsed.total == 9.50
        assert [i["category"] for i in parsed.raw_items] == ["Produce", "Dairy & Eggs", "Pantry"]
        assert parsed.unresolved_problems == []
        assert len(client.calls) == 1
        assert client.closed

        call = client.calls[0]
        assert call["model"] == receipt_ai.DEFAULT_MODEL
        assert call["output_config"]["effort"] == receipt_ai.DEFAULT_EFFORT
        assert call["output_config"]["format"]["type"] == "json_schema"
        # No sampling parameters (rejected by current API versions)
        for param in ("temperature", "top_p", "top_k"):
            assert param not in call
        (user,) = call["messages"]
        kinds = [b["type"] for b in user["content"]]
        assert kinds == ["image", "text"]
        assert user["content"][0]["source"]["media_type"] == "image/jpeg"
        assert "TEXT LAYER" in user["content"][-1]["text"]

    async def test_model_and_effort_from_env(self, api_key, monkeypatch, small_jpeg):
        monkeypatch.setenv("CLAUDE_MODEL", "claude-sonnet-5-5")
        monkeypatch.setenv("CLAUDE_EFFORT", "high")
        client = FakeClient([text_message(aldi_like())])
        with fake_anthropic(client):
            await extract_receipt_with_ai(small_jpeg, CATEGORIES)
        assert client.calls[0]["model"] == "claude-sonnet-5-5"
        assert client.calls[0]["output_config"]["effort"] == "high"

    async def test_tall_receipt_sends_one_image_per_segment(self, api_key):
        client = FakeClient([text_message(aldi_like())])
        with fake_anthropic(client):
            await extract_receipt_with_ai(make_receipt_image(900, 4000), CATEGORIES)
        content = client.calls[0]["messages"][0]["content"]
        n_images = sum(1 for b in content if b["type"] == "image")
        assert n_images >= 3
        assert f"{n_images} image segments" in content[-1]["text"]

    async def test_discrepancy_triggers_followup_and_keeps_better_result(self, api_key, small_jpeg):
        first = aldi_like()
        first["items"].pop(0)                  # missed a line
        first_msg = text_message(first)
        client = FakeClient([first_msg, text_message(aldi_like())])
        with fake_anthropic(client):
            parsed = await extract_receipt_with_ai(small_jpeg, CATEGORIES)

        assert len(client.calls) == 2
        followup = client.calls[1]["messages"]
        assert [m["role"] for m in followup] == ["user", "assistant", "user"]
        # The assistant turn replays the full first response (thinking included)
        assert followup[1]["content"] is first_msg.content
        assert "sum to 8.00" in followup[2]["content"]
        # The corrected extraction wins
        assert len(parsed.raw_items) == 3
        assert parsed.unresolved_problems == []

    async def test_worse_followup_is_discarded(self, api_key, small_jpeg):
        first = aldi_like()
        first["total"] = 12.00                 # one problem
        worse = aldi_like()
        worse["total"] = None
        worse["printed_item_count"] = 9        # two problems
        client = FakeClient([text_message(first), text_message(worse)])
        with fake_anthropic(client):
            parsed = await extract_receipt_with_ai(small_jpeg, CATEGORIES)
        assert parsed.total == 12.00
        assert len(parsed.unresolved_problems) == 1

    async def test_failed_followup_keeps_first_result(self, api_key, small_jpeg):
        first = aldi_like()
        first["total"] = 12.00
        client = FakeClient([text_message(first), status_error(529)])
        with fake_anthropic(client):
            parsed = await extract_receipt_with_ai(small_jpeg, CATEGORIES)
        assert parsed is not None
        assert parsed.total == 12.00

    @pytest.mark.parametrize("outcome", [
        text_message(None, stop_reason="refusal"),
        text_message({"items": []}, stop_reason="max_tokens"),
        text_message(None),                                  # thinking only, no text
        SimpleNamespace(content=[SimpleNamespace(type="text", text="{not json")],
                        stop_reason="end_turn"),
        status_error(500),
        status_error(400),
        anthropic.APIConnectionError(
            request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")),
    ], ids=["refusal", "max_tokens", "no_text", "bad_json", "http_500", "http_400", "connection"])
    async def test_failures_return_none(self, api_key, small_jpeg, outcome):
        client = FakeClient([outcome])
        with fake_anthropic(client):
            assert await extract_receipt_with_ai(small_jpeg, CATEGORIES) is None
        assert client.closed

    async def test_no_usable_items_returns_none(self, api_key, small_jpeg):
        data = aldi_like()
        data["items"] = [item("COUPON", -1.00)]
        data["printed_item_count"] = None
        data["total"] = -1.00
        data["tax"] = 0
        data["discounts"] = 0
        client = FakeClient([text_message(data)])
        with fake_anthropic(client):
            assert await extract_receipt_with_ai(small_jpeg, CATEGORIES) is None

    async def test_on_progress_reports_increasing_item_counts(self, api_key, small_jpeg):
        events = []
        client = FakeClient([text_message(aldi_like())])
        with fake_anthropic(client):
            await extract_receipt_with_ai(
                small_jpeg, CATEGORIES,
                on_progress=lambda stage, **d: events.append((stage, d)),
            )
        counts = [d["items"] for stage, d in events if stage == "reading"]
        assert counts == [1, 2, 3]
        assert all(d["method"] == "ai" for stage, d in events if stage == "reading")

    async def test_progress_counts_markers_split_across_deltas(self, api_key, small_jpeg):
        # A chunk size of 3 splits every '"category"' key across deltas.
        events = []
        client = FakeClient([text_message(aldi_like())])
        orig = FakeStream.__init__

        def small_chunks(self, message, chunk_size=3):
            orig(self, message, chunk_size)

        with fake_anthropic(client), patch.object(FakeStream, "__init__", small_chunks):
            await extract_receipt_with_ai(
                small_jpeg, CATEGORIES,
                on_progress=lambda stage, **d: events.append(d.get("items")),
            )
        assert events == [1, 2, 3]

    async def test_on_progress_reports_recheck(self, api_key, small_jpeg):
        first = aldi_like()
        first["items"].pop(0)
        events = []
        client = FakeClient([text_message(first), text_message(aldi_like())])
        with fake_anthropic(client):
            await extract_receipt_with_ai(
                small_jpeg, CATEGORIES,
                on_progress=lambda stage, **d: events.append((stage, d)),
            )
        stages = [s for s, _ in events]
        assert ("rechecking", {"problems": 1}) in events
        recheck = stages.index("rechecking")
        assert "reading" in stages[:recheck] and "reading" in stages[recheck + 1:]

    async def test_failing_progress_callback_does_not_break_extraction(self, api_key, small_jpeg):
        calls = []

        def boom(stage, **detail):
            calls.append(stage)
            raise RuntimeError("UI went away")

        first = aldi_like()
        first["total"] = 12.00
        client = FakeClient([text_message(first), text_message(aldi_like())])
        with fake_anthropic(client):
            parsed = await extract_receipt_with_ai(small_jpeg, CATEGORIES, on_progress=boom)
        assert parsed is not None
        assert parsed.total == 9.50
        assert "reading" in calls and "rechecking" in calls

    async def test_unreadable_image_returns_none(self, api_key):
        with patch("services.receipt_ai.anthropic.AsyncAnthropic") as ctor:
            assert await extract_receipt_with_ai(b"not an image", CATEGORIES) is None
        ctor.assert_not_called()


# ── Real SDK streaming path (mock HTTP transport, no network) ────────────────

def _sse_body(data: dict) -> bytes:
    """A Messages API SSE stream: an empty thinking block, then the JSON as text deltas."""
    text = json.dumps(data)
    events = [
        {"type": "message_start", "message": {
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
            "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 1}}},
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "signature_delta", "signature": "sig123"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        *[{"type": "content_block_delta", "index": 1,
           "delta": {"type": "text_delta", "text": text[i:i + 9]}} for i in range(0, len(text), 9)],
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
         "usage": {"output_tokens": 50}},
        {"type": "message_stop"},
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


async def test_real_sdk_stream_and_followup_replay(api_key, small_jpeg):
    first = aldi_like()
    first["items"].pop(0)
    bodies = [_sse_body(first), _sse_body(aldi_like())]
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx2.Response(200, headers={"content-type": "text/event-stream"},
                               content=bodies[len(requests) - 1])

    real_client = anthropic.AsyncAnthropic

    def make_client(**kwargs):
        return real_client(http_client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
                           **kwargs)

    events = []
    with patch("services.receipt_ai.anthropic.AsyncAnthropic", side_effect=make_client):
        parsed = await extract_receipt_with_ai(
            small_jpeg, CATEGORIES, on_progress=lambda stage, **d: events.append((stage, d)))

    assert len(parsed.raw_items) == 3
    assert [d.get("items") for s, d in events if s == "reading"] == [1, 2, 1, 2, 3]
    assert ("rechecking", {"problems": 1}) in events

    first_req, second_req = requests
    assert first_req["stream"] is True
    assert set(first_req) == {"model", "max_tokens", "messages", "output_config", "stream"}
    # The follow-up replays the first response's blocks exactly, thinking first.
    assert [m["role"] for m in second_req["messages"]] == ["user", "assistant", "user"]
    replay = second_req["messages"][1]["content"]
    assert replay[0] == {"type": "thinking", "thinking": "", "signature": "sig123"}
    assert replay[1]["type"] == "text" and set(replay[1]) == {"type", "text"}
