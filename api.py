# api.py
import os
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client
from datetime import datetime, timezone

# -----------------------
# ENV
# -----------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.environ.get(
    "SUPABASE_SERVICE_ROLE_KEY",
    os.environ.get("SUPABASE_ANON_KEY", "")
).strip()

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("SUPABASE_URL / SUPABASE_*_KEY not set")

API_BEARER_TOKEN = os.environ.get("API_BEARER_TOKEN", "").strip()

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

app = FastAPI(title="E2T Demo API")

# CORS: open for now; lock down later to your Netlify domain(s)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------
# Helpers
# -----------------------
def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def auth(authorization: Optional[str] = Header(None)):
    """
    Optional bearer auth.
    If API_BEARER_TOKEN is set in Heroku, require:
      Authorization: Bearer <token>
    If not set, endpoint is open.
    """
    if not API_BEARER_TOKEN:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1]
    if token != API_BEARER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid bearer token")

def fetch_table_sorted(
    name: str,
    order_col: Optional[str] = None,
    desc: bool = True,
    limit: Optional[int] = None,
    extra_select: str = "*",
):
    q = sb.table(name).select(extra_select)
    if order_col:
        q = q.order(order_col, desc=desc)  # NULLs last by default when desc=True
    if limit is not None:
        q = q.limit(limit)
    return q.execute().data or []

# -----------------------
# Routes
# -----------------------
@app.get("/health")
def health():
    return {"ok": True, "ts": _now_iso()}

@app.get("/data/latest")
def data_latest(
    _=Depends(auth),
    limit: int = Query(5000, ge=1, le=10000),
):
    """
    Demo dashboard:
    Returns the one table the frontend needs:
      - e2t_demo_live (sorted by pct_change DESC)
    """
    demo_live = (
                    sb.table("e2t_demo_live")
                    .select(
                        "account_id,customer_name,temp_name,country,plan,equity,open_pnl,pct_change,"
                        "pct_display,created_at,last_closed_at,time_taken_hours,source,group_name,updated_at")
                    .order("pct_display", desc=True)
                    .order("time_taken_hours", desc=False)
                    .limit(limit)
                    .execute()
                    .data
                ) or []

    return {
        "ts": _now_iso(),
        "demo_live": demo_live,
        "count": len(demo_live),
    }
