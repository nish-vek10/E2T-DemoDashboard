# worker.py
# --------------------------------------------------------------------
# E2T background worker (Heroku)
#
# What changed (and why):
#  1) **No postgrest/httpx**: We call Supabase PostgREST directly with
#     the `requests` library. This avoids async/coroutine crashes and
#     the 'Client.headers' confusion from previous versions.
#  2) **Clear scheduling**:
#     - Weekly baseline is seeded **at Monday 12:00 (UTC)**.
#     - If E2T_RUN_NOW=true, we **always** run an immediate `run_update()`
#       on start (so you see progress right away), even if the baseline
#       is scheduled for later that day.
#     - After that, we sleep until the *earliest of*:
#         next 2-hour tick (00, 02, 04, …)  OR  Monday 12:00 baseline time.
#     - On each wake: if it’s time to seed the weekly baseline → do it;
#       otherwise → do a 2h update.
#  3) Network hardening: all DB calls have retry/backoff.
#
# Environment:
#  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)
#  CRM_TABLE (defaults to 'lv_tpaccount')
#  SIRIX_TOKEN (required) and SIRIX_API_URL
#  E2T_TEST_MODE (false/true)
#  E2T_RUN_NOW (false/true)  <-- set true to run immediately after boot
#  E2T_RATE_DELAY_SEC (throttle between Sirix calls)
#  E2T_TZ_LABEL (string, for logs only; logic runs in UTC)
# --------------------------------------------------------------------

import os
import sys
import time
import math
import json
import requests
import pandas as pd
from typing import Optional, Tuple, Dict, Any, List
from datetime import datetime, timedelta, timezone
import random  # jitter for backoff

# -------------------------
# Netlify build hook helper (optional, controlled by env flags)
# -------------------------
def trigger_netlify_build(reason: str):
    """
    Ping Netlify Build Hook to trigger a redeploy when our data updates.
    Safe: completely optional (gated by env vars) and fully wrapped in try/except.
    """
    url = os.environ.get("NETLIFY_BUILD_HOOK_URL", "").strip()
    enabled = os.environ.get("E2T_NOTIFY_NETLIFY", "false").lower() == "true"
    if not enabled or not url:
        return
    try:
        payload = {"trigger_title": f"E2T worker: {reason} @ {now_iso_utc()}"}
        r = requests.post(url, json=payload, timeout=10)
        if 200 <= r.status_code < 300:
            print(f"[NETLIFY] Build hook OK ({reason}).")
        else:
            print(f"[NETLIFY] Build hook non-200 ({r.status_code}) ({reason}).")
    except Exception as e:
        print(f"[NETLIFY] Build hook failed ({reason}): {e}")


# -------------------------
# Environment configuration
# -------------------------
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_ANON_KEY", "")).strip()
if not SUPABASE_URL or not SUPABASE_KEY:
    print("[FATAL] SUPABASE_URL / SUPABASE_*_KEY not set.", file=sys.stderr)
    sys.exit(1)

# Base REST endpoint and default headers for PostgREST
BASE_REST = f"{SUPABASE_URL}/rest/v1"
PG_HEADERS_BASE = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept": "application/json",
    "Content-Type": "application/json",
    # Optional: use the public schema unless you configured differently
    "Accept-Profile": "public",
    "Content-Profile": "public",
}

CRM_TABLE = os.environ.get("CRM_TABLE", "lv_tpaccount").strip()

API_URL = os.environ.get("SIRIX_API_URL", "https://restapi-real3.sirixtrader.com/api/UserStatus/GetUserTransactions").strip()
SIRIX_TOKEN = os.environ.get("SIRIX_TOKEN", "").strip()

TEST_MODE = os.environ.get("E2T_TEST_MODE", "false").lower() == "true"
RUN_NOW_ON_START = os.environ.get("E2T_RUN_NOW", "true").lower() == "true"
E2T_ENABLE_BASELINE_SEED = os.environ.get("E2T_ENABLE_BASELINE_SEED", "false").lower() == "true"
RATE_DELAY_SEC = float(os.environ.get("E2T_RATE_DELAY_SEC", "0.2"))
E2T_TZ_LABEL = os.environ.get("E2T_TZ_LABEL", "UTC")

# Destination tables
TABLE_LIVE = "e2t_demo_live"
START_EQUITY = float(os.environ.get("E2T_START_EQUITY", "50000"))

# CRM column names (all lowercase in Supabase)
CRM_COL_ACCOUNT_ID = "lv_name"
CRM_COL_CUSTOMER   = "lv_accountidname"
CRM_COL_TEMP_NAME  = "lv_tempname"


# --------------------------------------------------------------------
# PostgREST helpers (requests-based, sync, retry-hardened)
# --------------------------------------------------------------------
def _retryable(err_text: str) -> bool:
    """Heuristic: which network-ish errors should we retry?"""
    signals = (
        "RemoteProtocolError", "ConnectionResetError", "ServerDisconnected",
        "ReadTimeout", "WriteError", "PoolTimeout", "Timed out",
        "Connection reset", "EOF", "temporarily unavailable",
    )
    et = err_text or ""
    return any(s in et for s in signals)


def pg_select(
    table: str,
    select: str,
    *,
    filters: Dict[str, str] | None = None,
    order: str | None = None,
    desc: bool = False,
    limit: int | None = None,
    offset: int | None = None
) -> List[Dict[str, Any]]:
    """
    Generic SELECT from PostgREST.
    - `filters` must use PostgREST syntax values (e.g., {"account_id": "eq.123"})
      We assemble the querystring like: ?select=...&account_id=eq.123
    - `order` becomes 'order=col.asc/desc'
    - `limit`/`offset` paginate the result
    Returns a list[dict].
    """
    params: Dict[str, Any] = {"select": select}
    if order:
        params["order"] = f"{order}.{'desc' if desc else 'asc'}"
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    if filters:
        params.update(filters)

    backoff = 0.5
    for attempt in range(1, 7):
        try:
            r = requests.get(f"{BASE_REST}/{table}", headers=PG_HEADERS_BASE, params=params, timeout=30)
            if r.status_code in (200, 206):  # 206 = partial content (range)
                return r.json() or []
            if r.status_code == 406:  # Not Acceptable can mean "no rows" with certain selects
                return []
            r.raise_for_status()
        except Exception as e:
            msg = str(e)
            if attempt == 6 or not _retryable(msg):
                print(f"[ERROR] pg_select {table}: {msg[:200]}")
                raise
            time.sleep(backoff * (1.0 + random.random() * 0.3))
            backoff = min(backoff * 2, 10.0)
    return []


def pg_select_all(table: str, select: str, *, filters: Dict[str, str] | None = None, order: str | None = None, desc: bool = False, page_size: int = 1000) -> List[Dict[str, Any]]:
    """Fetch **all** rows by paging with limit/offset until empty."""
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        chunk = pg_select(table, select, filters=filters, order=order, desc=desc, limit=page_size, offset=offset)
        if not chunk:
            break
        out.extend(chunk)
        if len(chunk) < page_size:
            break
        offset += page_size
    return out


def pg_upsert(table: str, row: dict, on_conflict: str = "account_id") -> None:
    """
    UPSERT via PostgREST:
      - POST with Prefer: resolution=merge-duplicates
      - on_conflict=col_name(s)
    """
    params = {"on_conflict": on_conflict}
    headers = {**PG_HEADERS_BASE, "Prefer": "resolution=merge-duplicates"}
    backoff = 0.5
    for attempt in range(1, 7):
        try:
            r = requests.post(f"{BASE_REST}/{table}", headers=headers, params=params, json=row, timeout=30)
            if r.status_code in (200, 201, 204):
                return
            r.raise_for_status()
        except Exception as e:
            msg = str(e)
            if attempt == 6 or not _retryable(msg):
                print(f"[ERROR] pg_upsert {table}: {msg[:200]} | row={str(row)[:180]}")
                return
            time.sleep(backoff * (1.0 + random.random() * 0.3))
            backoff = min(backoff * 2, 10.0)


def pg_delete(table: str, filters: Dict[str, str]) -> None:
    """DELETE rows matching the given PostgREST filters, e.g. {'account_id': 'eq.123'}"""
    params: Dict[str, str] = {}
    params.update(filters)
    backoff = 0.5
    for attempt in range(1, 7):
        try:
            r = requests.delete(f"{BASE_REST}/{table}", headers=PG_HEADERS_BASE, params=params, timeout=30)
            if r.status_code in (200, 204):
                return
            r.raise_for_status()
        except Exception as e:
            msg = str(e)
            if attempt == 6 or not _retryable(msg):
                print(f"[ERROR] pg_delete {table}: {msg[:200]} | filters={filters}")
                return
            time.sleep(backoff * (1.0 + random.random() * 0.3))
            backoff = min(backoff * 2, 10.0)


# --------------------------------------------------------------------
# Time helpers (UTC always)
# --------------------------------------------------------------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)

def now_iso_utc() -> str:
    return now_utc().isoformat()

def get_monday_noon(dt_utc: datetime) -> datetime:
    """Return the Monday 12:00 (UTC) for the week containing dt_utc."""
    monday = dt_utc - timedelta(days=dt_utc.weekday())
    return monday.replace(hour=12, minute=0, second=0, microsecond=0)

def need_new_week(baseline_at_dt: Optional[datetime], now_dt: datetime) -> bool:
    """True if baseline is missing or older than this week's Monday noon."""
    if baseline_at_dt is None:
        return True
    monday_noon = get_monday_noon(now_dt)
    return baseline_at_dt < monday_noon

def next_2h_tick_wallclock(now_dt: datetime) -> datetime:
    """Round forward to the next 2-hour wallclock (00, 02, 04, ... UTC)."""
    next_hour = ((now_dt.hour // 2) + 1) * 2
    day = now_dt.date()
    if next_hour >= 24:
        next_hour -= 24
        day = day + timedelta(days=1)
    return datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc).replace(hour=next_hour)

def format_period(created_dt: Optional[datetime], closed_dt: Optional[datetime]) -> str:
    # Requirement: if no closed positions (or missing dates) show zeros
    if not created_dt or not closed_dt or closed_dt < created_dt:
        return "00D-00H-00M"

    delta = closed_dt - created_dt
    total_minutes = int(delta.total_seconds() // 60)

    days = total_minutes // (24 * 60)
    rem = total_minutes % (24 * 60)
    hours = rem // 60
    minutes = rem % 60

    return f"{days:02d}D-{hours:02d}H-{minutes:02d}M"


# --------------------------------------------------------------------
# Date parsing helpers (Sirix can return different keys/formats)
# --------------------------------------------------------------------
CUTOFF_CREATED_AT = datetime(2025, 11, 1, 0, 0, 0, tzinfo=timezone.utc)

def parse_dt_any(v: Any) -> Optional[datetime]:
    """
    Try to parse Sirix datetime strings robustly.
    Accepts ISO strings with/without Z, sometimes "2025-11-01T12:34:56".
    Returns timezone-aware UTC datetime when possible.
    """
    if not v:
        return None
    try:
        s = str(v).strip()
        if not s:
            return None
        # normalize Z
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        # make tz-aware (assume UTC if tz missing)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None

def pick_first_dt(obj: Dict[str, Any], keys: List[str]) -> Optional[datetime]:
    for k in keys:
        if k in obj:
            dt = parse_dt_any(obj.get(k))
            if dt is not None:
                return dt
    return None


# --------------------------------------------------------------------
# CRM loader with pagination
# --------------------------------------------------------------------
def fetch_crm_chunk(offset: int, limit: int) -> List[Dict[str, Any]]:
    """
    Fetch a CRM chunk [offset, offset+limit).
    Try server-side NOT ILIKE '%purchases%' on CRM_COL_TEMP_NAME; if that fails,
    fetch unfiltered and filter client-side.
    """
    cols = f"{CRM_COL_ACCOUNT_ID},{CRM_COL_CUSTOMER},{CRM_COL_TEMP_NAME}"
    try:
        # PostgREST filter syntax example: <col>=not.ilike.*purchases*
        data = pg_select(
            CRM_TABLE,
            cols,
            filters={CRM_COL_TEMP_NAME: "not.ilike.*purchases*"},
            limit=limit,
            offset=offset,
        )
        return data
    except Exception:
        data = pg_select(CRM_TABLE, cols, limit=limit, offset=offset)
        return [r for r in data if "purchases" not in str(r.get(CRM_COL_TEMP_NAME, "")).lower()]

def load_crm_filtered_df(page_size: int = 1000, hard_limit: Optional[int] = None) -> pd.DataFrame:
    """
    Load ALL CRM rows via pagination, filtering out 'Purchases' rows (case-insensitive),
    returning a dataframe with lowercase CRM columns.
    """
    rows: List[Dict[str, Any]] = []
    offset = 0
    total_loaded = 0
    while True:
        chunk = fetch_crm_chunk(offset, page_size)
        if not chunk:
            break
        rows.extend(chunk)
        total_loaded += len(chunk)
        print(f"[CRM] Loaded chunk: {len(chunk)} rows (total {total_loaded})")
        offset += page_size
        if hard_limit is not None and total_loaded >= hard_limit:
            rows = rows[:hard_limit]
            break

    if not rows:
        print(f"[WARN] CRM table '{CRM_TABLE}' returned 0 rows after filter.")
        return pd.DataFrame(columns=[CRM_COL_ACCOUNT_ID, CRM_COL_CUSTOMER, CRM_COL_TEMP_NAME])

    df = pd.DataFrame(rows)
    for c in [CRM_COL_ACCOUNT_ID, CRM_COL_CUSTOMER, CRM_COL_TEMP_NAME]:
        if c not in df.columns:
            df[c] = None
    df = df.reset_index(drop=True)
    print(f"[CRM] Loaded {len(df):,} rows after server-side Purchases filter (with pagination).")
    return df


# --------------------------------------------------------------------
# Sirix fetch (unchanged logic)
# --------------------------------------------------------------------
def fetch_sirix_data(user_id: Any) -> Optional[Dict[str, Any]]:
    try:
        if user_id is None or (isinstance(user_id, float) and math.isnan(user_id)):
            return None
        clean_user_id = str(int(float(user_id))).strip()

        headers = {
            "Authorization": f"Bearer {SIRIX_TOKEN}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        payload = {
            "UserID": clean_user_id,
            "GetOpenPositions": False,
            "GetPendingPositions": False,
            "GetClosePositions": True,
            "GetMonetaryTransactions": True,
        }

        resp = requests.post(API_URL, headers=headers, json=payload, timeout=20)
        if resp.status_code != 200:
            print(f"[!] API {resp.status_code} for {clean_user_id}")
            return None
        data = resp.json() or {}

        country = (data.get("UserData") or {}).get("UserDetails", {}).get("Country")
        bal = (data.get("UserData") or {}).get("AccountBalance") or {}
        balance = bal.get("Balance")
        equity = bal.get("Equity")
        open_pnl = bal.get("OpenPnL")

        group_info = (data.get("UserData") or {}).get("GroupInfo") or {}
        group_name = group_info.get("GroupName")
        is_purchase_group = "purchase" in str(group_name or "").lower()

        txns = data.get("MonetaryTransactions") or []

        # ---- created_at: Prefer account creation time from UserDetails ----
        user_details = (data.get("UserData") or {}).get("UserDetails") or {}
        created_at_dt = pick_first_dt(user_details, ["CreationTime", "CreatedAt", "CreateDate", "Time"])

        # Fallback: earliest monetary transaction time (if CreationTime missing)
        if created_at_dt is None:
            for t in txns:
                dt = pick_first_dt(t, ["CreateDate", "CreatedAt", "Date", "TransactionDate", "Time"])
                if dt is not None:
                    created_at_dt = dt if created_at_dt is None else min(created_at_dt, dt)

        # ---- last_closed_at: latest close position time ----
        close_positions = data.get("ClosePositions") or data.get("ClosedPositions") or []
        last_closed_dt = None
        for p in close_positions:
            dt = pick_first_dt(p, ["CloseTime", "CloseDate", "CloseDatetime", "CloseAt", "Date", "Time"])
            if dt is not None:
                last_closed_dt = dt if last_closed_dt is None else max(last_closed_dt, dt)

        zero_balance_amount = None
        for t in txns:
            c = str(t.get("Comment", "")).lower()
            if "zero balance" in c:
                try:
                    zero_balance_amount = abs(float(t.get("Amount") or 0))
                except Exception:
                    zero_balance_amount = None
                break

        blown_up = any("zero balance" in str(t.get("Comment", "")).lower() for t in txns)

        plan = None
        for t in txns:
            if str(t.get("Comment", "")).lower().startswith("initial balance"):
                plan = t.get("Amount")
                break

        return {
            "Country": country,
            "Plan": plan,
            "Balance": balance,
            "Equity": equity,
            "OpenPnL": open_pnl,
            "BlownUp": blown_up,
            "GroupName": group_name,
            "IsPurchaseGroup": is_purchase_group,
            "ZeroBalanceAmount": zero_balance_amount,
            "CreatedAt": created_at_dt.isoformat() if created_at_dt else None,
            "LastClosedAt": last_closed_dt.isoformat() if last_closed_dt else None,
        }
    except Exception as e:
        print(f"[!] fetch_sirix_data exception for UserID={user_id}: {e}")
        return None


# --------------------------------------------------------------------
# DB helpers (table ops)
# --------------------------------------------------------------------
def upsert_row(table: str, row: dict, on_conflict: str = "account_id") -> None:
    """UPSERT one row with retry/backoff (via pg_upsert)."""
    pg_upsert(table, row, on_conflict=on_conflict)

def delete_if_exists(table: str, account_id: str) -> None:
    """DELETE by account_id."""
    pg_delete(table, {"account_id": f"eq.{account_id}"})

def norm_account_id(v: Any) -> Optional[str]:
    """Normalize any id to a consistent string like '121477'."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = str(v).strip()
    try:
        # Handles '121477', '121477.0', '  121477  '
        return str(int(float(s)))
    except Exception:
        return s

def run_update() -> None:
    """
    Demo update with progress logs.
    - Loads CRM list
    - Fetches Sirix for each account
    - Upserts into e2t_demo_live
    """
    cycle_started = now_utc()
    print("\n" + "=" * 70)
    print(f"[CYCLE] START {cycle_started.isoformat()}  |  START_EQUITY={START_EQUITY}  |  RATE_DELAY_SEC={RATE_DELAY_SEC}")
    print("=" * 70)

    df = load_crm_filtered_df()
    total = len(df)
    if total == 0:
        print("[CYCLE] No CRM rows to process. (table empty or filtered)")
        return

    processed = 0
    skipped = 0
    sirix_missing = 0
    upsert_ok = 0
    errors = 0

    start_ts = time.time()

    # heartbeat every N rows (so logs show activity on big datasets)
    HEARTBEAT_EVERY = 50

    for i, row in df.iterrows():
        raw_id = row.get(CRM_COL_ACCOUNT_ID)
        aid = norm_account_id(raw_id)

        if not aid:
            skipped += 1
            if skipped <= 5:
                print(f"[SKIP] Invalid account id: raw={raw_id!r}")
            continue

        cname = row.get(CRM_COL_CUSTOMER)
        tname = row.get(CRM_COL_TEMP_NAME)

        # short progress line
        print(f"[{i+1}/{total}] Fetch Sirix | UserID raw={raw_id} norm={aid} | name={str(cname)[:24]!r}")

        sirix = fetch_sirix_data(aid)

        country = None
        balance = None

        equity = None
        open_pnl = None
        group_name = None
        source = "missing"

        if sirix:
            country = sirix.get("Country")
            balance = sirix.get("Balance")

            group_name = sirix.get("GroupName")
            open_pnl = sirix.get("OpenPnL")

            eq = sirix.get("Equity")
            zb = sirix.get("ZeroBalanceAmount")

            created_at = sirix.get("CreatedAt")
            last_closed_at = sirix.get("LastClosedAt")

            try:
                eq_val = float(eq) if eq is not None else None
            except Exception:
                eq_val = None

            if eq_val is not None and eq_val > 0:
                equity = eq_val
                source = "equity"
            elif zb is not None:
                try:
                    zb_val = float(zb)
                except Exception:
                    zb_val = None
                if zb_val is not None and zb_val > 0:
                    equity = zb_val
                    source = "zero_balance_txn"
        else:
            sirix_missing += 1

        pct_change = None
        if equity is not None and START_EQUITY > 0:
            pct_change = ((equity - START_EQUITY) / START_EQUITY) * 100.0

        pct_display = None
        if pct_change is not None:
            pct_display = min(float(pct_change), 100.0)

        created_dt = parse_dt_any(created_at)
        closed_dt = parse_dt_any(last_closed_at)

        # If we can't determine creation time, skip (and remove any stale row)
        if created_dt is None:
            print(f"[FILTER] Skip id={aid} missing CreationTime; deleting stale row if exists")
            delete_if_exists(TABLE_LIVE, aid)
            continue

        # Cutoff enforcement (and cleanup stale rows)
        if created_dt < CUTOFF_CREATED_AT:
            print(f"[FILTER] Skip id={aid} created_at={created_dt.isoformat()} (before cutoff) -> delete stale row")
            delete_if_exists(TABLE_LIVE, aid)
            continue

        # time_taken_hours: 0 if no closed positions yet
        time_taken_hours = 0.0
        if closed_dt and closed_dt >= created_dt:
            time_taken_hours = (closed_dt - created_dt).total_seconds() / 3600.0

        # period: always a string like 02D-12H-34M (or zeros)
        period = format_period(created_dt, closed_dt)

        # Print a quick “value line” so you can visually confirm it works
        # (limit spam: only first 10 rows OR every heartbeat)
        if (processed < 10) or ((processed + 1) % HEARTBEAT_EVERY == 0):
            print(
                f"[DATA] id={aid} equity={equity} open_pnl={open_pnl} "
                f"pct={pct_change if pct_change is not None else None} source={source} group={group_name}"
            )

        payload = {
            "account_id": aid,
            "customer_name": cname,
            "temp_name": tname,
            "country": country,
            "balance": balance,
            "plan": START_EQUITY,
            "equity": equity,
            "open_pnl": open_pnl,
            "pct_change": pct_change,
            "pct_display": pct_display,
            "created_at": created_at,
            "last_closed_at": last_closed_at,
            "time_taken_hours": time_taken_hours,
            "period": period,
            "source": source,
            "group_name": group_name,
            "updated_at": now_iso_utc(),
        }

        try:
            upsert_row(TABLE_LIVE, payload, on_conflict="account_id")
            upsert_ok += 1
        except Exception as e:
            errors += 1
            # don’t kill whole cycle; keep going
            print(f"[ERROR] Upsert failed for id={aid}: {e}")

        processed += 1

        if RATE_DELAY_SEC > 0:
            time.sleep(RATE_DELAY_SEC)

        # heartbeat line
        if processed % HEARTBEAT_EVERY == 0:
            elapsed = int(time.time() - start_ts)
            mm, ss = divmod(elapsed, 60)
            print(f"[HEARTBEAT] processed={processed}/{total} skipped={skipped} sirix_missing={sirix_missing} errors={errors} elapsed={mm:02d}:{ss:02d}")

    elapsed = int(time.time() - start_ts)
    mm, ss = divmod(elapsed, 60)
    print("-" * 70)
    print(f"[CYCLE] DONE processed={processed} skipped={skipped} sirix_missing={sirix_missing} upsert_ok={upsert_ok} errors={errors} runtime={mm:02d}:{ss:02d}")
    print("-" * 70)

    trigger_netlify_build("demo update")


# --------------------------------------------------------------------
# Main scheduler (immediate run-now)
# --------------------------------------------------------------------
def main():
    interval = int(os.environ.get("E2T_LOOP_SECONDS", "120"))  # 2 min default
    print(f"[SERVICE] Demo worker running. interval={interval}s START_EQUITY={START_EQUITY}")

    while True:
        run_update()
        print(f"[SCHED] Sleeping {interval}s…")
        time.sleep(interval)


if __name__ == "__main__":
    try:
        if not SIRIX_TOKEN:
            print("[FATAL] SIRIX_TOKEN is not set in Heroku config vars.", file=sys.stderr)
            sys.exit(1)
        main()
    except KeyboardInterrupt:
        print("\n[EXIT] Stopped by user.")
