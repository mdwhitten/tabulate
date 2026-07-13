"""
image_service.py — Receipt image utilities

generate_thumbnail(image_bytes, out_path)
    Saves a compressed JPEG thumbnail (max 800px long-side, q=82).
    Returns thumbnail_path on success, None on failure.

detect_receipt_edges(image_bytes)
    Attempts to find the four corners of a receipt in the image.
    Returns a list of four [x, y] points (as fractions 0–1 of image W/H),
    ordered TL → TR → BR → BL.  Returns None if detection fails.
"""

import io
import logging
import os
import math

logger = logging.getLogger("tabulate.image")

try:
    from PIL import Image, ImageFilter
    import numpy as np
    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False


# ── Thumbnail ──────────────────────────────────────────────────────────────────

THUMB_MAX = 1000   # px on long side
THUMB_Q   = 82     # JPEG quality


def _open_corrected(image_bytes: bytes) -> "Image.Image":
    """Open an image and apply EXIF orientation so pixel data matches display orientation."""
    from PIL import ImageOps
    img = Image.open(io.BytesIO(image_bytes))
    img = ImageOps.exif_transpose(img)
    return img


def generate_thumbnail(image_bytes: bytes, out_path: str) -> str | None:
    """
    Create a compressed JPEG thumbnail and save it to out_path.
    Returns out_path on success, None if Pillow is unavailable or image is invalid.
    """
    if not _AVAILABLE:
        return None
    try:
        img = _open_corrected(image_bytes)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        w, h = img.size
        long_side = max(w, h)
        if long_side > THUMB_MAX:
            scale = THUMB_MAX / long_side
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        img.save(out_path, format="JPEG", quality=THUMB_Q, optimize=True)
        logger.debug("Thumbnail saved %d KB → %s", os.path.getsize(out_path)//1024, out_path)
        return out_path
    except Exception as e:
        logger.error("Thumbnail failed: %s", e)
        return None


# ── Edge Detection ─────────────────────────────────────────────────────────────

def detect_receipt_edges(image_bytes: bytes) -> list[list[float]] | None:
    """
    Detect the four corners of a receipt in an image.

    Strategy:
    1. Convert to greyscale, apply Gaussian blur to reduce noise.
    2. Sobel edge map (pure numpy, no scipy needed).
    3. Threshold the edge map to get a binary mask.
    4. Dilate the mask slightly so thin receipt borders connect.
    5. Find the largest connected rectangular region via horizontal/vertical
       run-length analysis, looking for the dominant inner rectangle
       (the receipt body against a contrasting background).
    6. Reject if the found box covers > 92% of the image (nothing useful found).

    Returns four [x_frac, y_frac] points ordered TL → TR → BR → BL,
    where coordinates are fractions of the image dimensions (0.0–1.0).
    Returns None if detection fails or Pillow/numpy are unavailable.
    """
    if not _AVAILABLE:
        return None
    try:
        img = _open_corrected(image_bytes)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")

        orig_w, orig_h = img.size

        # Work at a reduced size for speed (keep aspect ratio)
        work_max = 800
        scale = min(work_max / orig_w, work_max / orig_h, 1.0)
        work_w = int(orig_w * scale)
        work_h = int(orig_h * scale)
        small = img.resize((work_w, work_h), Image.LANCZOS)

        # Greyscale + Gaussian blur to suppress noise
        grey = small.convert("L")
        blurred = grey.filter(ImageFilter.GaussianBlur(radius=3))
        arr = np.array(blurred, dtype=np.float32)

        # Sobel edge detection — pure numpy, no scipy required
        edges = _sobel_edges_numpy(arr)

        # Normalise and threshold at 15% of max edge strength
        edge_max = edges.max()
        if edge_max < 1e-6:
            return None
        thresh = (edges / edge_max > 0.15).astype(np.uint8)

        # Morphological dilation — close small gaps in the receipt border
        thresh = _dilate(thresh, radius=3)

        # Find the dominant rectangle
        corners = _find_receipt_corners(thresh, work_w, work_h)
        if corners is None:
            return None

        # Map back to fractions of the original image
        result = [[pt[0] / work_w, pt[1] / work_h] for pt in corners]
        logger.debug("Detected corners (fractions): %s", result)
        return result

    except Exception as e:
        logger.warning("Edge detection failed: %s", e)
        return None


def _sobel_edges_numpy(arr: "np.ndarray") -> "np.ndarray":
    """
    Pure-numpy Sobel edge magnitude — no scipy, no cv2.
    Uses vectorised slicing for speed.
    """
    import numpy as np
    # Pad by 1 to avoid border effects
    p = np.pad(arr, 1, mode='edge')
    gx = (
        -p[:-2, :-2] + p[:-2, 2:] +
        -2.0 * p[1:-1, :-2] + 2.0 * p[1:-1, 2:] +
        -p[2:, :-2] + p[2:, 2:]
    )
    gy = (
        -p[:-2, :-2] - 2.0 * p[:-2, 1:-1] - p[:-2, 2:] +
        p[2:, :-2] + 2.0 * p[2:, 1:-1] + p[2:, 2:]
    )
    return np.sqrt(gx * gx + gy * gy)


def _dilate(mask: "np.ndarray", radius: int) -> "np.ndarray":
    """
    Simple binary dilation using a box kernel — closes small gaps in edges.
    """
    import numpy as np
    result = mask.copy()
    for _ in range(radius):
        padded = np.pad(result, 1, mode='constant')
        result = np.maximum.reduce([
            padded[:-2, 1:-1],  # up
            padded[2:,  1:-1],  # down
            padded[1:-1, :-2],  # left
            padded[1:-1, 2:],   # right
            padded[1:-1, 1:-1], # center
        ])
    return result


def _find_receipt_corners(
    thresh: "np.ndarray", w: int, h: int
) -> list[list[float]] | None:
    """
    Given a binary edge image, locate the receipt as the largest high-contrast
    rectangle inside the frame.

    Approach:
    - Project edge density onto each axis to find the region with the densest
      vertical and horizontal edges, which corresponds to the receipt borders.
    - Use a "peak-gap" method: find the outermost rows/columns where edge
      density drops sharply (the gap between receipt and background).
    - Apply a small inward pad to avoid cutting off receipt text at the border.
    - Reject if the resulting box is > 92% of the image in both dimensions.
    """
    import numpy as np

    # Horizontal scan: count edge pixels per row (tells us top/bottom of receipt)
    row_density = thresh.sum(axis=1).astype(np.float32)
    # Vertical scan: count edge pixels per column (tells us left/right of receipt)
    col_density = thresh.sum(axis=0).astype(np.float32)

    # Smooth with a wider kernel to merge nearby edge clusters
    k = max(3, min(w, h) // 15)
    kernel = np.ones(k, dtype=np.float32) / k
    row_s = np.convolve(row_density, kernel, mode='same')
    col_s = np.convolve(col_density, kernel, mode='same')

    # Find a threshold that separates "inside receipt" from "background"
    # Use the 60th percentile so sparse background edges don't dominate
    row_thr = np.percentile(row_s, 60)
    col_thr = np.percentile(col_s, 60)

    rows_in = np.where(row_s > row_thr)[0]
    cols_in = np.where(col_s > col_thr)[0]

    if not len(rows_in) or not len(cols_in):
        return None

    y_min, y_max = int(rows_in[0]), int(rows_in[-1])
    x_min, x_max = int(cols_in[0]), int(cols_in[-1])

    # Small inward pad so we don't clip the receipt edge
    pad = max(2, int(min(w, h) * 0.01))
    y_min = max(0, y_min - pad)
    y_max = min(h - 1, y_max + pad)
    x_min = max(0, x_min - pad)
    x_max = min(w - 1, x_max + pad)

    # Reject if the box covers essentially the whole image
    if (x_max - x_min) > w * 0.92 and (y_max - y_min) > h * 0.92:
        logger.debug("Box too large (%dx%d vs %dx%d), rejecting", x_max-x_min, y_max-y_min, w, h)
        return None

    return [[x_min, y_min], [x_max, y_min], [x_max, y_max], [x_min, y_max]]
