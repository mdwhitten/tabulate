# Changelog

All notable changes to Tabulate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
