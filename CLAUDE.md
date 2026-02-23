# Tabulate — Developer Context

Self-hosted grocery receipt tracker. React 19 + TypeScript + Vite + Tailwind CSS 4 frontend, FastAPI + SQLite backend.

## Stack

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS 4 (no build step for TW)
- **State**: TanStack React Query v5 — all server state goes through hooks
- **Backend**: FastAPI + Python 3.12 + SQLite (aiosqlite)
- **OCR**: Tesseract (text) → Claude Vision claude-haiku-4-5 (enrichment)
- **Container**: Docker Compose — nginx (serves Vite build) + uvicorn (backend)

## Project Structure

```
src/
  api/          # Fetch wrappers — one file per resource (receipts, categories, trends, mappings)
  hooks/        # TanStack Query hooks — one file per resource
  components/   # Shared UI; layout/ contains AppShell, Sidebar, Topbar
  pages/        # One file per page: Dashboard, AllReceipts, ReviewReceipt, Trends, Categories, LearnedItems
  types.ts      # Shared TypeScript interfaces (Receipt, LineItem, Category, ItemMapping, etc.)
  mockData.ts   # Mock data used during dev/testing
  App.tsx       # Root: page routing state, ReviewLoader, UploadModal, topbar wiring
  main.tsx      # Entry: QueryClientProvider wrapping App
backend/        # FastAPI app
  routers/      # receipts, categories, items, trends
  services/     # ocr_service, image_service, categorize_service
  models/schemas.py
  db/database.py  # SQLite schema + seed
docker/
  Dockerfile.nginx   # Multi-stage: node:20-alpine build → nginx:alpine serve
  nginx.conf         # Proxy /api → backend, SPA fallback, cache headers
docker-compose.yml
vite.config.ts  # Dev proxy: /api → http://localhost:8000
```

## Running

```bash
# Full stack (production-like)
docker compose up --build

# Dev (hot reload)
# Terminal 1 — backend
docker compose up backend

# Terminal 2 — frontend (Vite HMR at http://localhost:5173)
npm install
npm run dev
```

## Routing

The app uses simple React state (`page` string in `App.tsx`) — no React Router. Navigation is `setPage(...)`. The `Page` type is in `types.ts`.

## Key Patterns

### ProcessingResult vs Receipt duality
- Fresh upload → `ProcessingResult` (has `receipt_id`, `verification_message`)
- Opened from list → `Receipt` (has `id`, no `verification_message`)
- `ReviewLoader` in `App.tsx` normalizes both into a `Receipt` for `ReviewReceipt`

### Topbar Save button
The Save button lives in `App.tsx` (topbar) but save logic lives in `ReviewReceipt`. They communicate via a `CustomEvent`:
```ts
// Topbar fires:
window.dispatchEvent(new CustomEvent('tabulate:save-receipt'))

// ReviewReceipt listens:
window.addEventListener('tabulate:save-receipt', handler)
// Uses useRef pattern to keep handler fresh without re-registering:
const handleSaveRef = useRef<(() => Promise<void>) | null>(null)
useEffect(() => { handleSaveRef.current = handleSave }, [handleSave])
```

### Query key factories
Each hooks file exports a `*Keys` object (e.g. `receiptKeys`, `categoryKeys`) used for targeted cache invalidation.

## API Shape Notes

| Schema | Key fields |
|---|---|
| `ProcessingResult` | `receipt_id`, `verification_message`, `items[]`, `thumbnail_path` |
| `Receipt` | `id`, `status`, `items[]`, `thumbnail_path` — NO `verification_message` |
| `ReceiptSummary` | `id`, `item_count` — NO `items[]` |
| `SaveReceiptBody` | `items[]`, `status`, `store_name?` |
| `ItemMapping` | `source` field (NOT `category_source`) |

## Build Notes

- TypeScript: `./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build` (don't use `npm run build` in Docker — tsc not in PATH)
- Docker build uses `node:20-alpine` (node:22 had OOM issues with npm)
- Docker build uses **yarn** instead of npm — npm fails silently under QEMU emulation / Alpine
- `.dockerignore` excludes `node_modules`, `dist`, `.git`, `.env`

## Backend Notes

- Backend auto-reloads on Python file changes (uvicorn `--reload` + `./backend:/app` volume mount)
- Frontend changes require `docker compose build nginx && docker compose up nginx` to rebuild
- Dev frontend changes are instant via Vite HMR at `localhost:5173`
- SQLite `PRAGMA foreign_keys = ON` is set in `get_db()` — required for ON DELETE CASCADE
- Two-pass OCR: Tesseract extracts text → `parse_receipt_with_vision()` enriches with Claude Vision

## Releasing

When asked to prepare a release (e.g. "release v1.3.0"), make all of the following changes:

1. **Bump `package.json`** — update the `version` field to the new semver (without the `v` prefix)
2. **Update `CHANGELOG.md`** — add a new `## [X.Y.Z] - YYYY-MM-DD` section at the top (below the header) with the changes for this release, following the Keep a Changelog format (Added / Changed / Fixed / Removed subsections as applicable)
3. **Commit** with the message `vX.Y.Z` and **open a PR** targeting `main` with the title `vX.Y.Z`

CI will validate the PR title is valid semver, CHANGELOG.md has a matching entry, and package.json version matches. On merge, the `release.yml` workflow automatically creates a GitHub release + tag from the changelog, and `docker.yml` builds and pushes the Docker images.

## Environment

```
ANTHROPIC_API_KEY=sk-ant-...   # Required for Claude Vision
DB_PATH=/data/tabulate.db      # Optional, defaults shown
IMAGE_DIR=/data/images         # Optional, defaults shown
```
