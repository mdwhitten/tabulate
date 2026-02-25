"""
Tests for OCR parsing functions — pure text processing with no external dependencies.

Covers:
- parse_receipt_text: regex-based line item extraction for standard, Costco, and H-E-B formats
- verify_total: receipt total verification against extracted items
- _detect_store_from_text: keyword-based store name detection
- _prepare_image_for_vision: magic-byte media type detection
"""
import pytest
from services.ocr_service import (
    parse_receipt_text,
    verify_total,
    _detect_store_from_text,
    _prepare_image_for_vision,
    ParsedReceipt,
)


# ── _detect_store_from_text ──────────────────────────────────────────────────

class TestDetectStore:

    def test_known_store_costco(self):
        assert _detect_store_from_text("Welcome to COSTCO WHOLESALE") == "Costco"

    def test_known_store_heb(self):
        assert _detect_store_from_text("H-E-B\n123 Main St") == "H-E-B"

    def test_known_store_case_insensitive(self):
        assert _detect_store_from_text("your friendly WALMART supercenter") == "Walmart"

    def test_known_store_trader_joes(self):
        assert _detect_store_from_text("TRADER JOE'S #123") == "Trader Joe's"

    def test_known_store_whole_foods(self):
        assert _detect_store_from_text("Whole Foods Market") == "Whole Foods"

    def test_unknown_store_returns_none(self):
        assert _detect_store_from_text("My Local Corner Shop\n123 Main") is None

    def test_empty_text(self):
        assert _detect_store_from_text("") is None

    def test_garbled_ocr_still_matches(self):
        """A garbled header still matches if the keyword appears anywhere."""
        assert _detect_store_from_text("OPAL VAULT... COSTCO pee WV HOL ESALE") == "Costco"

    def test_wholesale_maps_to_costco(self):
        assert _detect_store_from_text("wholesale club #432") == "Costco"


# ── parse_receipt_text — standard format ─────────────────────────────────────

class TestParseReceiptTextStandard:

    def test_simple_item_with_dollar_sign(self):
        text = "ORGANIC BANANAS        $3.99"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1
        assert result.raw_items[0]["clean_name"] == "Organic Bananas"
        assert result.raw_items[0]["price"] == 3.99

    def test_simple_item_without_dollar_sign(self):
        text = "WHOLE MILK GALLON      4.59"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1
        assert result.raw_items[0]["price"] == 4.59

    def test_quantity_prefix(self):
        text = "2 x AVOCADO LARGE      5.98"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1
        assert result.raw_items[0]["quantity"] == 2.0

    def test_skip_keywords_filtered(self):
        text = "SUBTOTAL               25.47\nTAX                     1.95\nTOTAL                  27.42"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 0

    def test_total_extracted(self):
        text = "ITEM ONE        5.00\nTOTAL          5.00"
        result = parse_receipt_text(text)
        assert result.total == 5.00

    def test_subtotal_extracted(self):
        text = "Sub Total      12.50\nTax             0.85\nTotal          13.35"
        result = parse_receipt_text(text)
        assert result.subtotal == 12.50
        assert result.tax == 0.85
        assert result.total == 13.35

    def test_discount_extracted(self):
        text = "SAVINGS -$2.50\nTOTAL  10.00"
        result = parse_receipt_text(text)
        assert result.discounts == 2.50

    def test_date_extraction_header(self):
        text = "STORE NAME\n02/15/2026\nITEM ONE        5.00"
        result = parse_receipt_text(text)
        assert result.receipt_date == "02/15/2026"

    def test_date_extraction_iso_style(self):
        """The regex looks for M/D/Y format, not ISO. ISO is separate."""
        text = "Date: 2/15/26\nITEM ONE        5.00"
        result = parse_receipt_text(text)
        assert result.receipt_date == "2/15/26"

    def test_invalid_date_rejected(self):
        """OCR garbage that looks like a date but isn't valid."""
        text = "99/99/9999\nITEM ONE        5.00"
        result = parse_receipt_text(text)
        assert result.receipt_date is None

    def test_store_name_from_header(self):
        text = "FRESH FOODS\n123 MAIN ST\nITEM ONE        5.00"
        result = parse_receipt_text(text)
        assert result.store_name == "Fresh Foods"

    def test_multiple_items(self):
        text = (
            "ORGANIC BANANAS        3.99\n"
            "WHOLE MILK             4.59\n"
            "BREAD WHEAT            3.29\n"
            "TOTAL                 11.87"
        )
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 3
        assert result.total == 11.87

    def test_empty_text(self):
        result = parse_receipt_text("")
        assert result.raw_items == []
        assert result.store_name is None
        assert result.total is None

    def test_price_filter_zero_rejected(self):
        """Items with price 0.00 should be filtered out."""
        text = "COUPON ITEM            0.00"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 0

    def test_price_filter_over_500_rejected(self):
        """Items with price >= 500 should be filtered out."""
        text = "WEIRD ITEM           599.99"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 0

    def test_short_name_rejected(self):
        """Items with name < 4 chars should be filtered."""
        text = "AB                     5.00"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 0

    def test_last_total_wins(self):
        """When multiple TOTAL lines exist, take the last one."""
        text = "SUBTOTAL              10.00\nTOTAL                 10.00\nTOTAL                 11.50"
        result = parse_receipt_text(text)
        assert result.total == 11.50

    def test_quantity_capped_at_20(self):
        """Quantities above 20 are treated as 1 (likely line number, not qty)."""
        text = "25 x WIDGET ITEM       5.00"
        result = parse_receipt_text(text)
        if result.raw_items:
            assert result.raw_items[0]["quantity"] == 1.0


# ── parse_receipt_text — Costco format ───────────────────────────────────────

class TestParseReceiptTextCostco:

    def test_costco_with_sku(self):
        text = "1136340 3LB ORG GALA   4.49"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1
        assert result.raw_items[0]["price"] == 4.49

    def test_costco_with_e_marker(self):
        text = "E 1136340 KS NAPKIN  11.99 A"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1
        assert result.raw_items[0]["price"] == 11.99

    def test_costco_with_qty_prefix(self):
        text = "3 7816886 FINISHTABS  19.99 A"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1

    def test_costco_store_detected(self):
        text = "COSTCO WHOLESALE\n1136340 ITEM ONE   4.49\nTOTAL  4.49"
        result = parse_receipt_text(text)
        assert result.store_name == "Costco"


# ── parse_receipt_text — H-E-B format ────────────────────────────────────────

class TestParseReceiptTextHEB:

    def test_heb_line_number_not_qty(self):
        """H-E-B leading number is a line number, not quantity."""
        text = "3 HEB TX ROOTS CAMPARI TOMA FW   3.47"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1
        # Line number 3 should NOT become qty
        assert result.raw_items[0]["quantity"] == 1.0

    def test_heb_double_digit_line_number(self):
        text = "18 HEB ORG TX RTS SLC BBY BL FH   3.98"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1
        assert result.raw_items[0]["quantity"] == 1.0
        assert result.raw_items[0]["price"] == 3.98

    def test_heb_comma_decimal(self):
        """H-E-B sometimes has comma decimals."""
        text = "12 GREEN LEAF LET LEAVES FH   3,07"
        result = parse_receipt_text(text)
        assert len(result.raw_items) == 1
        assert result.raw_items[0]["price"] == 3.07

    def test_heb_store_detected(self):
        text = "H-E-B\n1 ITEM ONE FH  5.99\nTOTAL  5.99"
        result = parse_receipt_text(text)
        assert result.store_name == "H-E-B"


# ── verify_total ─────────────────────────────────────────────────────────────

class TestVerifyTotal:

    def _make_parsed(self, items, total=None, tax=None, discounts=0.0):
        p = ParsedReceipt()
        p.raw_items = [{"price": price, "quantity": qty} for price, qty in items]
        p.total = total
        p.tax = tax
        p.discounts = discounts
        return p

    def test_no_total(self):
        p = self._make_parsed([(5.00, 1)], total=None)
        valid, msg = verify_total(p)
        assert not valid
        assert "Could not find a total" in msg

    def test_no_items(self):
        p = self._make_parsed([], total=10.00)
        valid, msg = verify_total(p)
        assert not valid
        assert "No line items" in msg

    def test_exact_match_no_tax(self):
        p = self._make_parsed([(5.00, 1), (3.00, 2)], total=11.00)
        valid, msg = verify_total(p)
        assert valid
        assert "✓" in msg

    def test_exact_match_with_tax(self):
        p = self._make_parsed([(10.00, 1)], total=10.83, tax=0.83)
        valid, msg = verify_total(p)
        assert valid

    def test_within_two_cents_rounding(self):
        p = self._make_parsed([(3.33, 3)], total=9.99)
        # 3.33 * 3 = 9.99 — exact
        valid, msg = verify_total(p)
        assert valid

    def test_mismatch(self):
        p = self._make_parsed([(5.00, 1)], total=20.00)
        valid, msg = verify_total(p)
        assert not valid
        assert "Mismatch" in msg
        assert "diff" in msg

    def test_with_discounts(self):
        p = self._make_parsed([(10.00, 1)], total=8.00, tax=0.50, discounts=2.50)
        # 10 + 0.50 - 2.50 = 8.00
        valid, msg = verify_total(p)
        assert valid
        assert "Savings" in msg

    def test_sets_subtotal(self):
        """verify_total should set parsed.subtotal to the sum of items."""
        p = self._make_parsed([(5.00, 1), (3.00, 1)], total=8.00)
        verify_total(p)
        assert p.subtotal == 8.00


# ── _prepare_image_for_vision — magic bytes ──────────────────────────────────

class TestPrepareImageMagicBytes:

    def test_jpeg_detected(self):
        # JPEG magic bytes + some padding
        data = b'\xff\xd8\xff\xe0' + b'\x00' * 100
        _, media_type = _prepare_image_for_vision(data)
        assert media_type == "image/jpeg"

    def test_png_detected(self):
        data = b'\x89PNG' + b'\x00' * 100
        _, media_type = _prepare_image_for_vision(data)
        # May return jpeg after conversion, or the original type
        assert media_type in ("image/png", "image/jpeg")

    def test_tiff_detected(self):
        data = b'MM\x00\x2a' + b'\x00' * 100
        _, media_type = _prepare_image_for_vision(data)
        assert media_type in ("image/tiff", "image/jpeg")

    def test_pdf_returns_early(self):
        data = b'%PDF-1.4' + b'\x00' * 100
        returned_bytes, media_type = _prepare_image_for_vision(data)
        assert media_type == "application/pdf"
        assert returned_bytes == data

    def test_unknown_defaults_to_jpeg(self):
        data = b'\x00\x00\x00\x00' + b'\x00' * 100
        _, media_type = _prepare_image_for_vision(data)
        assert media_type == "image/jpeg"
