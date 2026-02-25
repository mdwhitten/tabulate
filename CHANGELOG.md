# Changelog

All notable changes to Tabulate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-02-25

### Fixed
- SQL injection vector in image serving helper — column name now validated against a whitelist
- SQL fragment interpolation in receipt save endpoint replaced with parameterized query
- Wildcard CORS no longer sends credentials; added `CORS_ORIGINS` env var for explicit origin lists
- API key prefix no longer leaked in `/api/diagnose` response — only reports presence
- File upload now validates Content-Type against allowed image types and enforces 20 MB size cap server-side
- Backend port in Docker Compose bound to `127.0.0.1` so it's not exposed to the network
- Crop endpoint body changed from unvalidated `dict` to a Pydantic model with typed `corners` field
- Image file serving now verifies resolved paths are contained within `IMAGE_DIR` to prevent path traversal

## [1.3.0] - 2025-02-25

### Added
- Category item drill-down in trends view — tap a category to see its individual items
- Mobile overflow menu (•••) on receipt review topbar with Rescan, Save, and Delete actions
- Green approve icon button in mobile topbar for quick one-tap approval

### Changed
- Topbar height increased for easier tapping on mobile (h-12 → h-14)
- Back button enlarged with visible border outline for better mobile tap target
- Receipt review footer streamlined — Cancel/Close removed (back button handles navigation), Rescan/Delete hidden on mobile (moved to topbar overflow), Save/Approve stretch full-width on small screens
- All item mappings (both AI and manual corrections) are now deferred until receipt approval — cancelling or deleting an unreviewed receipt no longer leaves orphaned mappings behind

### Fixed
- Receipt date field not tappable on mobile when empty
- Date field now stays visibly editable while receipt is unverified
- Bottom padding added so content doesn't butt against the tab bar in embedded mode
- Category source badge (AI/Manual/Learned) now updates to "Manual" immediately when the user overrides a category, instead of waiting until save

## [1.2.6] - 2026-02-23

### Fixed
- Learned item categorization no longer matches wrong category from short generic seed mappings (e.g. "milk" seed matching "Taste of Thai Coconut Milk")
- Swipe-to-delete on learned items table now reveals red across the full row width instead of being cramped into a narrow strip

## [1.2.5] - 2026-02-23

### Fixed
- Scan button no longer extends outside the bottom tab bar in embedded mode
- Status column on mobile receipts list now shows a compact icon-only badge instead of overflowing offscreen
- Swipe-to-delete on learned items table no longer shows fragmented red strips across cells on tablet — only the delete action column reveals the indicator
- Disabled categories are excluded from AI categorization prompts, learned mapping lookups, and the category picker dropdown

## [1.2.4] - 2026-02-23

### Fixed
- Backend startup crash when item_mappings table contains both space-containing and space-free normalized keys (e.g. "ground beef" and "groundbeef"), causing a UNIQUE constraint failure

## [1.2.3] - 2026-02-23

### Fixed
- Item mapping lookup now ignores spaces so OCR variants like "KS Steakstrip" and "KSSteakstrip" match the same rule

### Removed
- Home Assistant theme awareness (accent color and dark mode detection from parent HA iframe) — caused visual regressions

## [1.2.2] - 2026-02-23

### Added
- Home Assistant theme awareness — accent color and dark/light mode are read from the parent HA iframe
- Delete functionality for learned item mapping rules
- Auto-release and PR validation CI workflows
- Notify HA add-on repo on upstream release

### Fixed
- Duplicate item mappings caused by friendly names leaking into raw_name key
- Scan button alignment and Avg column header alignment

## [1.2.1] - 2026-02-23

### Fixed
- Changing a learned item's category now updates the mappings table instead of misrouting to line items
- Category filter chips on the Learned Items page now display custom category icons and colors

## [1.2.0] - 2026-02-22

### Added
- Duplicate receipt detection matching on total and date before upload
- Styled DuplicateWarningModal replacing browser `window.confirm`
- Backend test suite for categorization service (38 tests)
- CI workflow running backend and frontend tests on push and PR

### Fixed
- AI categorization no longer overrides manual or learned category mappings

## [1.1.0] - 2026-02-22

### Added
- Category picker redesigned as a popover with search, matching the emoji picker style
- Distinct color palette for custom categories so they don't all default to the same color
- Mobile modal editor now opens on approved receipts for category editing

### Fixed
- Docker build switched from npm to yarn to fix silent install failures on Alpine/QEMU
- Removed autoFocus from emoji picker search input to prevent keyboard pop-up on mobile

## [1.0.0] - 2026-02-22

### Added
- React 19 + TypeScript + Vite + Tailwind CSS 4 frontend
- FastAPI + SQLite backend with two-pass OCR (Tesseract + Claude Vision)
- Receipt upload with progress stepper and scan button
- Receipt review page with line item editing, category assignment, and total verification
- Save/Approve split workflow for receipt processing
- Swipe-to-delete for line items on mobile
- Mobile bottom-sheet modal for editing line items
- Bottom tab bar navigation for Home Assistant add-on / embedded mode
- Receipt crop flow (pre-upload and re-crop)
- Dashboard with monthly spending summary
- Trends page with stacked bar chart and per-category breakdown
- Average amount column in trends breakdown table
- Categories management page with emoji icon picker
- Learned items page with pagination
- All Receipts list with search, status filters, and sorting by receipt date
- URL routing with browser history support
- Docker Compose setup with nginx (frontend) + uvicorn (backend)
- Home Assistant ingress compatibility
- Structured Python logging throughout backend

### Fixed
- Category matching prefers most specific learned mapping
- Custom category colors render correctly in charts
- Stacked bar chart uses clipPath for uniform corner rounding
- Y-axis scaling uses finer steps to fill chart area
- Status badges no longer wrap to two lines on mobile
- Scan button alignment and popup menu cutoff on mobile
- Desktop table padding restored to appropriate values
- Categories under $5 hidden in per-category bar chart
