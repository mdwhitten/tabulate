"""
Tests for image_service.downscale_for_storage — stored receipt images are
width-capped JPEGs; processing always uses the full-resolution upload.
"""
import io

from PIL import Image

from services.image_service import STORED_MAX_WIDTH, downscale_for_storage


def make_jpeg(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (230, 230, 230)).save(buf, format="JPEG", quality=95)
    return buf.getvalue()


class TestDownscaleForStorage:

    def test_default_cap_is_1200(self):
        assert STORED_MAX_WIDTH == 1200

    def test_wide_image_shrinks_to_max_width_keeping_aspect(self):
        out = downscale_for_storage(make_jpeg(3000, 9000))
        img = Image.open(io.BytesIO(out))
        assert img.format == "JPEG"
        assert img.size == (1200, 3600)

    def test_tall_narrow_receipt_keeps_full_height(self):
        # Capped by width, not long side: a long receipt stays readable.
        out = downscale_for_storage(make_jpeg(1000, 12000))
        assert Image.open(io.BytesIO(out)).size == (1000, 12000)

    def test_small_image_bytes_returned_unchanged(self):
        data = make_jpeg(800, 1600)
        assert downscale_for_storage(data) is data

    def test_explicit_max_width(self):
        out = downscale_for_storage(make_jpeg(1000, 500), max_width=400)
        assert Image.open(io.BytesIO(out)).size == (400, 200)

    def test_rgba_png_converted_to_jpeg(self):
        buf = io.BytesIO()
        Image.new("RGBA", (2400, 1200), (0, 0, 0, 0)).save(buf, format="PNG")
        out = downscale_for_storage(buf.getvalue())
        img = Image.open(io.BytesIO(out))
        assert img.format == "JPEG"
        assert img.size == (1200, 600)

    def test_invalid_bytes_returned_unchanged(self):
        assert downscale_for_storage(b"not an image") == b"not an image"
