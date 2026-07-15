# Changelog

All notable changes to Tabulate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0] - 2026-07-15

### Added
- Receipt review view now has **prev/next arrows** (with an "n/m" position) to step through receipts without returning to the list. Navigation follows the current filtered list — e.g. filtered to Pending, the arrows move between pending receipts.
- Receipt review view has an **"Auto-categorized only"** filter that shows just the items still AI-categorized, hiding learned/manual/corrected items so you only review what needs checking. It clears automatically once every item has been reviewed.

### Changed
- The receipts list filter (search + status) now persists when you open a receipt and go back, instead of resetting to "All".

## [2.1.0] - 2026-07-15

### Changed
- YNAB sync now distributes a receipt's tax/discount/reconciliation remainder proportionally across the transaction's categories (by each category's line-item share) instead of assigning it all to the default category. With a single category the whole remainder folds into it. Split amounts still sum exactly to the receipt total.

## [2.0.0] - 2026-07-15

### Added
- **YNAB integration** — optionally sync approved receipts to YNAB as transactions. Disabled by default and gated on a `YNAB_API_TOKEN` env var; when off or on error it never blocks or fails a receipt save.
  - New **Settings** page: connection status, enable toggle, budget/account/default-category selectors (searchable dropdowns), and an optional per-category mapping from Tabulate categories to YNAB categories.
  - On approval (and via a manual "Sync to YNAB" / re-sync button on verified receipts), a transaction is created for the receipt total. When a receipt spans multiple mapped categories the transaction is split, with the tax/discount remainder reconciled into the default category so the parts sum to the real charge.
  - Editing and saving an already-verified receipt re-syncs it automatically, so YNAB stays current without a manual re-sync.
  - Transactions are created unapproved and uncleared with no `import_id`, so YNAB automatically matches them to the bank feed when the real charge imports later.
- Added `.env.example` and documented `YNAB_API_TOKEN`, `LOG_LEVEL`, and `CORS_ORIGINS` in the README.

### Changed
- The YNAB integration now uses the official `ynab` Python SDK instead of hand-rolled HTTP calls.

### Fixed
- Re-syncing an edited receipt now reflects the changes. The YNAB API can't update a split transaction (date/amount/category edits are ignored and subtransactions can't be changed), so split transactions are deleted and recreated; single-category transactions are updated in place, preserving any existing YNAB match.
- Manual total entry: typing a multi-digit total (e.g. "300") no longer commits the first digit and clears the field — the value is now committed on blur/Enter.
- The receipt store-name field now shows a clear hover/focus affordance (and a correctly-aligned pencil icon) so it reads as editable.

## [1.6.0] - 2026-07-13

### Added
- The pristine pre-crop image is now retained, so a crop is always reversible. "Edit Crop" re-crops from the original and offers "Reset — Use Full Image" to undo a bad crop entirely.

### Changed
- Multi-upload now steps through the crop dialog for each receipt (auto-detected corners pre-filled) instead of silently auto-cropping — wrinkled/curled receipts often need a manual nudge, and nothing is committed without a look.
- Uploads send the original alongside the client-corrected scan; re-crops go through a new `/replace-image` endpoint that swaps the displayed image while preserving the original (the current image is copied to the original on the first destructive re-crop).

### Fixed
- Bad auto-crops were unrecoverable because only the cropped image was stored — the original is now kept, so crops can always be redone.
- More robust paper detection: a custom `approxPolyDP` quad detector with a confidence gate that rejects implausible detections (e.g. grabbing the whole table or a tiny speck) rather than seeding a garbage crop.

## [1.5.1] - 2026-07-13

### Fixed
- Release pipeline: switched the Docker build cache from the GitHub Actions cache (`type=gha`) to a per-image registry cache (`type=registry`, a `:buildcache` tag in ghcr) to fix intermittent `error writing layer blob: failed to reserve cache` failures during release builds

## [1.5.0] - 2026-07-13

### Added
- Multi-upload — select several receipt images/PDFs at once, or snap photos one after another, and process the whole batch in parallel
- Review queue — after a multi-upload, review receipts one at a time; Approve or Skip advances to the next, and the last returns to the receipts list (others stay pending)
- On-device document scanning — automatic paper-edge detection and true perspective correction now run in the browser (vendored OpenCV.js + jscanify), so a clean, deskewed image is uploaded for OCR and Claude Vision; falls back to the server detector or the original image when the scanner can't load
- README screenshots

### Changed
- Image uploads are perspective-corrected client-side instead of relying on the server-side numpy edge detector (the server detector is retained as a fallback)

### Fixed
- Trends `/stores` breakdown tests used hardcoded Feb 2026 dates and failed once outside the endpoint's 3-month window — now use dates relative to today
- Removed the unused `_fallback_corners` helper in the image service

## [1.4.1] - 2026-05-09

### Changed
- Replaced `pymupdf` with `pdf2image` + `pypdf` for PDF support — pymupdf has no musllinux aarch64 wheels and was adding ~50 minutes to Docker builds under QEMU emulation by compiling MuPDF from source. The new libraries install in seconds on every architecture (pdf2image uses the system `poppler` binary, pypdf is pure Python). PDF rendering DPI, text extraction, and multi-page stitching behavior are unchanged.

## [1.4.0] - 2026-03-22

### Added
- PDF receipt upload support — single and multi-page PDFs are converted to JPEG via `pymupdf` for thumbnails and Vision enrichment
- Direct text extraction from text-based PDFs, skipping Tesseract OCR for faster processing
- Frontend skips crop stage for PDF uploads since digital documents don't need perspective correction

### Fixed
- Trends router tests used hardcoded Feb 2026 dates causing failures in later months — now use dynamic dates relative to today

## [1.3.1] - 2026-02-25

### Added
- Edit button on verified receipts — unlocks date, store name, and categories for correction while keeping items, prices, and totals locked
- Categorization failure detection with retry banner on receipt review
- GitHub Actions workflow for Playwright E2E tests with artifact upload
- E2E test coverage for editing approved receipts (click Edit, change fields, save) on desktop and mobile
- Mobile E2E test suites for navigation (hamburger menu), All Receipts (hidden columns, compact badges), Trends (bottom sheet category drill-down), and Learned Items (swipe-to-delete)
- Playwright `mobile-chrome` (Pixel 5) project for mobile viewport E2E testing
- Desktop-only skip guards on sidebar navigation and inline expansion tests that fail at mobile viewport

### Changed
- Verified receipts are now fully read-only by default (categories included); editing requires explicitly tapping Edit

### Fixed
- Price corrections could modify line items belonging to a different receipt — query now scoped to `receipt_id`
- Receipt date field accepted arbitrary strings (e.g. `"not-a-date"`) that broke trend queries — now validated as ISO `YYYY-MM-DD`
- Empty/whitespace-only store name was stored as `""` instead of being treated as null
- New items accepted nonexistent or disabled categories — now validated against the categories table
- Negative manual total accepted and stored — now rejected with 422
- SQL injection vector in image serving helper — column name now validated against a whitelist
- SQL fragment interpolation in receipt save endpoint replaced with parameterized query
- Wildcard CORS no longer sends credentials; added `CORS_ORIGINS` env var for explicit origin lists
- API key prefix no longer leaked in `/api/diagnose` response — only reports presence
- File upload now validates Content-Type against allowed image types and enforces 20 MB size cap server-side
- Backend port in Docker Compose bound to `127.0.0.1` so it's not exposed to the network
- Crop endpoint body changed from unvalidated `dict` to a Pydantic model with typed `corners` field
- Image file serving now verifies resolved paths are contained within `IMAGE_DIR` to prevent path traversal
- Trends expanded-item column layout misaligned and scroll lock bug on mobile
- Empty footer bar visible on mobile for verified receipts with no actions

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
