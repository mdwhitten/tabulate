from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import logging
import os
import time

from db.database import init_db
from routers import receipts, items, categories, trends

# ── Logging setup ─────────────────────────────────────────────────────────────
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
# Quiet noisy libraries unless we're in DEBUG
if LOG_LEVEL != "DEBUG":
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

logger = logging.getLogger("tabulate")

app = FastAPI(
    title="Tabulate — Grocery Receipt Tracker",
    description="Personal grocery receipt tracking with AI categorization",
    version="0.1.0",
)

_cors_origins = os.environ.get("CORS_ORIGINS", "").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins.split(",") if _cors_origins else ["*"],
    allow_credentials=bool(_cors_origins),  # only send credentials when origins are explicit
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(receipts.router, prefix="/api/receipts", tags=["receipts"])
app.include_router(items.router,    prefix="/api/items",    tags=["items"])
app.include_router(categories.router, prefix="/api/categories", tags=["categories"])
app.include_router(trends.router,   prefix="/api/trends",   tags=["trends"])

# Serve frontend static files
FRONTEND_DIR = "/app/frontend"
if os.path.exists(FRONTEND_DIR):
    app.mount("/assets", StaticFiles(directory=f"{FRONTEND_DIR}/assets"), name="assets")

    @app.get("/", include_in_schema=False)
    async def serve_frontend():
        return FileResponse(f"{FRONTEND_DIR}/index.html")

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    elapsed = (time.time() - start) * 1000
    if LOG_LEVEL == "DEBUG" or response.status_code >= 400:
        logger.log(
            logging.WARNING if response.status_code >= 400 else logging.DEBUG,
            "%s %s → %s (%.0fms)",
            request.method, request.url.path, response.status_code, elapsed,
        )
    return response

@app.on_event("startup")
async def on_startup():
    logger.info("Starting Tabulate v0.1.0  LOG_LEVEL=%s  DB=%s",
                LOG_LEVEL, os.environ.get("DB_PATH", "(default)"))
    await init_db()

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}


@app.get("/api/diagnose")
async def diagnose():
    """Check that all dependencies are working inside the container."""
    import subprocess, os as _os
    results = {}

    # Tesseract binary
    try:
        r = subprocess.run(["tesseract", "--version"], capture_output=True, text=True, timeout=5)
        results["tesseract"] = {"ok": r.returncode == 0, "version": r.stdout.split("\n")[0].strip()}
    except FileNotFoundError:
        results["tesseract"] = {"ok": False, "error": "tesseract binary not found in PATH"}
    except Exception as e:
        results["tesseract"] = {"ok": False, "error": str(e)}

    # pytesseract
    try:
        import pytesseract
        results["pytesseract"] = {"ok": True}
    except ImportError as e:
        results["pytesseract"] = {"ok": False, "error": str(e)}

    # Pillow
    try:
        from PIL import Image
        results["pillow"] = {"ok": True}
    except ImportError as e:
        results["pillow"] = {"ok": False, "error": str(e)}

    # HEIC/HEIF support
    try:
        from pillow_heif import register_heif_opener
        results["heic_support"] = {"ok": True}
    except ImportError:
        results["heic_support"] = {"ok": False, "error": "pillow-heif not installed — HEIC files unsupported"}

    # Data dir
    results["data_dir"] = {
        "ok": _os.path.isdir("/data"),
        "writable": _os.access("/data", _os.W_OK),
        "images_dir": _os.environ.get("IMAGE_DIR", "/data/images"),
    }

    # Anthropic key (never expose key material — only report presence)
    key = _os.environ.get("ANTHROPIC_API_KEY", "")
    results["anthropic_key"] = {
        "ok": bool(key and key.startswith("sk-")),
        "set": bool(key),
    }

    return {"all_ok": all(v.get("ok") for v in results.values()), "checks": results}
