# Changelog

All notable changes to Tabulate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
