from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


# ── Store ──────────────────────────────────────────────
class StoreBase(BaseModel):
    name: str

class Store(StoreBase):
    id: int
    created_at: str

    class Config:
        from_attributes = True


# ── Line Item ──────────────────────────────────────────
class LineItemBase(BaseModel):
    raw_name: str
    clean_name: Optional[str] = None
    price: float
    quantity: float = 1.0
    category: Optional[str] = None
    category_source: str = "ai"
    ai_confidence: Optional[float] = None

class LineItemCreate(LineItemBase):
    receipt_id: int

class LineItemUpdate(BaseModel):
    category: str
    # Updating category always counts as manual correction

class LineItem(LineItemBase):
    id: int
    receipt_id: int
    corrected: bool = False

    class Config:
        from_attributes = True


# ── Receipt ────────────────────────────────────────────
class ReceiptBase(BaseModel):
    store_name: str
    receipt_date: Optional[str] = None
    subtotal: Optional[float] = None
    tax: Optional[float] = None
    discounts: float = 0.0
    total: Optional[float] = None

class ReceiptCreate(ReceiptBase):
    ocr_raw: Optional[str] = None
    image_path: Optional[str] = None

class ReceiptSave(BaseModel):
    """Sent by frontend after user reviews and corrects items."""
    receipt_id: int
    items: List[LineItemUpdate]  # corrected categories keyed by item id
    # We use a dict for corrections: item_id -> new_category
    corrections: dict = Field(default_factory=dict)

class Receipt(ReceiptBase):
    id: int
    scanned_at: str
    ocr_raw: Optional[str] = None
    image_path: Optional[str] = None
    thumbnail_path: Optional[str] = None
    total_verified: bool = False
    status: str = "pending"
    items: List[LineItem] = []

    class Config:
        from_attributes = True

class ReceiptSummary(BaseModel):
    id: int
    store_name: str
    receipt_date: Optional[str]
    scanned_at: str
    total: Optional[float]
    item_count: int
    total_verified: bool
    status: str


# ── Item Mapping ───────────────────────────────────────
class ItemMappingBase(BaseModel):
    normalized_key: str
    display_name: str
    category: str
    source: str = "manual"

class ItemMappingCreate(ItemMappingBase):
    pass

class ItemMapping(ItemMappingBase):
    id: int
    times_seen: int
    last_seen: str
    created_at: str

    class Config:
        from_attributes = True

class PaginatedMappings(BaseModel):
    items: List[ItemMapping]
    total: int


# ── Trends ─────────────────────────────────────────────
class MonthlyCategoryTotal(BaseModel):
    year: int
    month: int
    category: str
    total: float

class MonthSummary(BaseModel):
    year: int
    month: int
    month_label: str       # e.g. "Feb 2026"
    total: float
    by_category: dict[str, float]

class TrendsResponse(BaseModel):
    months: List[MonthSummary]
    categories: List[str]

class CategoryItemDetail(BaseModel):
    clean_name: str
    raw_name: str
    price: float
    quantity: float
    store_name: Optional[str] = None
    receipt_date: Optional[str] = None


# ── Upload / Processing ────────────────────────────────
class ProcessingResult(BaseModel):
    receipt_id: int
    store_name: str
    receipt_date: Optional[str]
    ocr_raw: str
    subtotal: Optional[float]
    tax: Optional[float]
    discounts: float
    total: Optional[float]
    total_verified: bool
    verification_message: str
    thumbnail_path: Optional[str] = None
    categorization_failed: bool = False
    items: List[LineItem]
