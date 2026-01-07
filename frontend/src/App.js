// frontend/src/App.js
import React, { useEffect, useState, useMemo, useLayoutEffect, useRef } from "react";
import "./App.css";
import countries from "i18n-iso-countries";
import enLocale from "i18n-iso-countries/langs/en.json";

countries.registerLocale(enLocale);

// Supabase REST (read-only)
const SUPABASE_URL  = process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_ANON = process.env.REACT_APP_SUPABASE_ANON_KEY;

// demo table + no balance needed for UI
const SB_SELECT =
  "account_id,customer_name,country,plan,equity,open_pnl,pct_change,time_taken_hours,updated_at";

// fetch from demo live table (sorted by pct_change desc)
const SB_ACTIVE_URL = `${SUPABASE_URL}/rest/v1/e2t_demo_live?select=${encodeURIComponent(
  SB_SELECT
)}&order=pct_change.desc.nullslast&limit=500`;

// NOTE: We no longer render API_BASE anywhere (you asked to hide it)
const API_BASE = process.env.REACT_APP_API_BASE || "";

// === Helpers ===
function fmtNumber(v, digits = 2) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "";
  const n = Number(v);
  const sign = n > 0 ? "+" : (n < 0 ? "" : "");
  return sign + n.toFixed(2) + "%";
}
function numVal(v) {
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function pad2(n){ return String(n).padStart(2, "0"); }

function fmtPeriodDHMS(hoursVal) {
  const h = Number(hoursVal);
  if (!Number.isFinite(h) || h <= 0) return "00D-00H-00M";

  const totalMinutes = Math.floor(h * 60);
  const d = Math.floor(totalMinutes / (24 * 60));
  const rem = totalMinutes % (24 * 60);
  const hh = Math.floor(rem / 60);
  const mm = rem % 60;

  return `${pad2(d)}D-${pad2(hh)}H-${pad2(mm)}M`;
}

function fmtHHMMSS(hoursVal) {
  const h = Number(hoursVal);
  if (!Number.isFinite(h) || h <= 0) return "00:00:00";

  let totalSeconds = Math.floor(h * 3600);

  const hh = Math.floor(totalSeconds / 3600);
  totalSeconds -= hh * 3600;

  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds - mm * 60;

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

function fmtDDHHMM(hoursVal) {
  const h = Number(hoursVal);
  if (!Number.isFinite(h) || h <= 0) return "00:00:00";

  const totalMinutes = Math.floor(h * 60);

  const dd = Math.floor(totalMinutes / (24 * 60));
  const rem = totalMinutes % (24 * 60);

  const hh = Math.floor(rem / 60);
  const mm = rem % 60;

  return `${pad2(dd)}:${pad2(hh)}:${pad2(mm)}`;
}

// === Countdown helpers ===
// === Monthly Reset (GMT/UTC): 00:00:00 on the 1st of the next month ===
function getNextMonthResetTarget(now = new Date()) {
  // Use UTC so it's always GMT (no DST drift)
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11
  // first of NEXT month 00:00:00 UTC
  return new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));
}

function diffToDHMS(target, now = new Date()) {
  let ms = Math.max(0, target - now);
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return { d, h, m, s };
}

// London timezone label (BST/GMT) for the reset caption
function getLondonTZAbbrev(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/London",
      timeZoneName: "short",
    }).formatToParts(d);
    const tz = parts.find(p => p.type === "timeZoneName")?.value || "";
    // Normalize "GMT+1" etc. to "GMT"
    return tz.replace(/^GMT(?:[+-]\d+)?$/, "GMT");
  } catch {
    return "GMT/BST";
  }
}

// --- Flag helpers (robust country-name → ISO alpha-2) ---
const COUNTRY_ALIASES = {
  "uk": "United Kingdom",
  "u.k.": "United Kingdom",
  "gb": "United Kingdom",
  "great britain": "United Kingdom",
  "britain": "United Kingdom",
  "uae": "United Arab Emirates",
  "u.a.e.": "United Arab Emirates",
  "usa": "United States of America",
  "u.s.a.": "United States of America",
  "united states": "United States of America",
  "us": "United States of America",
  "russia": "Russian Federation",
  "kyrgyzstan": "Kyrgyz Republic",
  "czech republic": "Czechia",
  "ivory coast": "Côte d'Ivoire",
  "cote d'ivoire": "Côte d'Ivoire",
  "côte d'ivoire": "Côte d'Ivoire",
  "dr congo": "Congo, Democratic Republic of the",
  "democratic republic of the congo": "Congo, Democratic Republic of the",
  "republic of the congo": "Congo",
  "swaziland": "Eswatini",
  "cape verde": "Cabo Verde",
  "palestine": "Palestine, State of",
  "iran": "Iran, Islamic Republic of",
  "syria": "Syrian Arab Republic",
  "moldova": "Moldova, Republic of",
  "venezuela": "Venezuela, Bolivarian Republic of",
  "bolivia": "Bolivia, Plurinational State of",
  "laos": "Lao People's Democratic Republic",
  "brunei": "Brunei Darussalam",
  "vietnam": "Viet Nam",
  "south korea": "Korea, Republic of",
  "north korea": "Korea, Democratic People's Republic of",
  "macau": "Macao",
  "hong kong": "Hong Kong",
  "burma": "Myanmar",
  "myanmar": "Myanmar",
  "north macedonia": "North Macedonia",
  "são tomé and príncipe": "Sao Tome and Principe",
  "sao tome and principe": "Sao Tome and Principe",
  "micronesia": "Micronesia, Federated States of",
  "st kitts and nevis": "Saint Kitts and Nevis",
  "saint kitts and nevis": "Saint Kitts and Nevis",
  "st lucia": "Saint Lucia",
  "saint lucia": "Saint Lucia",
  "st vincent and the grenadines": "Saint Vincent and the Grenadines",
  "saint vincent and the grenadines": "Saint Vincent and the Grenadines",
  "antigua": "Antigua and Barbuda",
  "bahamas": "Bahamas",
  "gambia": "Gambia",
  "bahrein": "Bahrain",
  "netherlands the": "Netherlands",
  "republic of ireland": "Ireland",
  "eswatini": "Eswatini",
  "kosovo": "Kosovo",
  "tanzania": "tz",
  "tanzania, united republic of": "tz",
  "united republic of tanzania": "tz",
  "tanzania united republic of": "tz",
};

function resolveCountryAlpha2(rawName) {
  if (!rawName) return null;

  let raw = String(rawName).trim();
  if (!raw) return null;

  let code = countries.getAlpha2Code(raw, "en");

  const rawLower = raw.toLowerCase();
  const cleanedLower = rawLower.replace(/[().]/g, "").replace(/\s+/g, " ").trim();
  const fullyNormalized = rawLower
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[().]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!code) {
    const alias =
      COUNTRY_ALIASES[rawLower] ??
      COUNTRY_ALIASES[cleanedLower] ??
      COUNTRY_ALIASES[fullyNormalized];

    if (alias) {
      if (/^[A-Za-z]{2}$/.test(alias)) {
        return alias.toLowerCase();
      }
      code = countries.getAlpha2Code(alias, "en") || (alias.toLowerCase() === "kosovo" ? "XK" : null);
    }
  }

  if (!code) {
    code =
      countries.getAlpha2Code(cleanedLower, "en") ||
      countries.getAlpha2Code(fullyNormalized, "en");
  }

  if (!code) {
    if (fullyNormalized.includes("tanzania")) return "tz";
  }

  return code ? code.toLowerCase() : null;
}

function getFlagOnly(countryName) {
  const code = resolveCountryAlpha2(countryName);
  if (!code) return countryName || "";
  return (
    <img
      src={`https://flagcdn.com/w40/${code}.png`}
      title={countryName || ""}
      alt={countryName || ""}
      loading="lazy"
      style={{
        width: "38px",
        height: "28px",
        objectFit: "cover",
        borderRadius: "3px",
        boxShadow: "0 0 3px rgba(0,0,0,0.6)"
      }}
      onError={(e) => {
        e.currentTarget.style.display = "none";
        e.currentTarget.insertAdjacentText("afterend", countryName || "");
      }}
    />
  );
}

function shortName(full) {
  if (!full) return "";
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const capWord = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const first = capWord(parts[0]);
  const last = parts[parts.length - 1] || "";
  const lastInitial = last ? last[0].toUpperCase() + "." : "";
  return lastInitial ? `${first} ${lastInitial}` : first;
}

/**
 * NEW: rank movement storage (last refresh order)
 * - we store a map: { [account_id]: 0-based rank }
 * - movement: prev - current (positive => moved up)
 */
const LS_RANK_KEY = "e2t_prev_rank_by_id";
function buildRankMap(rows) {
  const m = Object.create(null);
  for (let i = 0; i < rows.length; i++) {
    const id = String(rows[i]?.account_id ?? "");
    if (id) m[id] = i;
  }
  return m;
}

// Top-2 only: highlight + strips; 3–20 identical
const rowStyleForRank = (r) => {
  if (r === 0) return { background: "#1a1505" };  // gold tint
  if (r === 1) return { background: "#0f1420" }; // silver/blue tint
  return {};
};
const rowHeightForRank = (r) => (r <= 1 ? 45 : 42);
const accentForRank = (r) => {
  if (r === 0) return "#F4C430";
  if (r === 1) return "#B0B7C3";
  return "transparent"; // no strip for 3–20
};
const rankBadge = (r) => {
  if (r === 0) return <span style={{ fontWeight: 1100, fontSize: "25px" }}>🥇</span>;
  if (r === 1) return <span style={{ fontWeight: 900, fontSize: "23px" }}>🥈</span>;
  return null;
};

// === Schedule helper: next EVEN hour :30 ===
function msUntilNextEvenHour30(now = new Date()) {
  const t = new Date(now);
  t.setSeconds(0, 0);
  if (t.getHours() % 2 === 0 && t.getMinutes() < 30) {
    const cand = new Date(t);
    cand.setMinutes(30, 0, 0);
    return cand - now;
  }
  const addHours = (t.getHours() % 2 === 1) ? 1 : 2;
  const cand = new Date(t.getTime() + addHours * 3600 * 1000);
  cand.setMinutes(30, 0, 0);
  return cand - now;
}

// ===== Mobile Leaderboard Cards (phone-only UI) =====
function MobileLeaderboardCards({ rows, rowsTop30, globalRankById, prevRankById }) {
  const list = rows && rows.length ? rows : rowsTop30;

  return (
    <div role="list" style={{ display: "grid", gap: 10 }}>
      {list.map((row, idx) => {
        const id = String(row.account_id ?? "");
        const globalRank = globalRankById[id];
        const displayRank =
          globalRank >= 0 && Number.isInteger(globalRank) ? globalRank + 1 : "";

        const nRaw = numVal(row.pct_change);
        const n = (nRaw == null) ? null : Math.min(nRaw, 100);
        const pctColor =
          n == null ? "#eaeaea" : n > 0 ? "#34c759" : n < 0 ? "#ff453a" : "#eaeaea";

        // top-2 subtle highlight (keep modern + readable)
        const isTop1 = globalRank === 0;
        const isTop2 = globalRank === 1;

        const leftStripColor = isTop1 ? "#F4C430" : isTop2 ? "#B0B7C3" : "transparent";
        const cardBorderColor = isTop1
          ? "rgba(244,196,48,0.35)"
          : isTop2
          ? "rgba(176,183,195,0.30)"
          : "#2a2a2a";

        const bg =
          globalRank === 0
            ? "linear-gradient(135deg, rgba(212,175,55,0.22) 0%, #161616 100%)"
            : globalRank === 1
            ? "linear-gradient(135deg, rgba(176,183,195,0.18) 0%, #161616 100%)"
            : "#181818";

        return (
          <div
            key={id || idx}
            role="listitem"
            style={{
              background: bg,
              border: "1px solid ${cardBorderColor}`",
              borderRadius: 12,
              padding: 12,
              display: "grid",
              gap: 8,
              borderLeft: `6px solid ${leftStripColor}`,
            }}
          >
            {/* Row 1: rank + name + country flag */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  minWidth: 38,
                  height: 32,
                  borderRadius: 8,
                  background: "#101010",
                  border:
                    globalRank <= 1 ? "1px solid rgba(212,175,55,0.25)" : "1px solid #222",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: isTop1 ? 1000 : isTop2 ? 900 : 800,
                  color: globalRank <= 1 ? "#d4af37" : "#eaeaea",
                  padding: "0 6px",
                  gap: 4
                  transform: isTop1 ? "scale(1.05)" : isTop2 ? "scale(1.03)" : "none",
                }}
                aria-label={`Rank ${displayRank}`}
              >
                {rankBadge(globalRank) || displayRank}
              </div>

              <div
                style={{
                  fontWeight: 700,
                  fontSize: 14,
                  fontWeight: isTop1 ? 900 : isTop2 ? 800 : 700,
                  fontSize: isTop1 ? 16 : isTop2 ? 15 : 14,
                  color: "#f2f2f2",
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={row.customer_name}
              >
                {shortName(row.customer_name)}
              </div>

              <div>{getFlagOnly(row.country)}</div>
            </div>

            {/* Row 2: Net % only (capital removed) */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div /> {/* spacer to keep layout balanced */}

              <span
                style={{
                  justifySelf: "end",
                  background: "#101010",
                  border: "1px solid #2a2a2a",
                  borderRadius: 999,
                  padding: "6px 10px",
                  fontWeight: isTop1 ? 1000 : isTop2 ? 950 : 900,
                  color: pctColor,
                  minWidth: 80,
                  textAlign: "center",
                  fontSize: isTop1 ? 15 : isTop2 ? 14 : 13,
                }}
                aria-label="Net percent change"
              >
                {fmtPct(n)}
              </span>

              <div
                style={{
                  justifySelf: "end",
                  color: "#aaa",
                  fontSize: 12,
                  fontWeight: 600,
                  marginTop: 6,
                  minWidth: 80,          // matches Net% pill
                  textAlign: "center",   // keeps it lined up perfectly
                  fontVariantNumeric: "tabular-nums", // makes digits align cleanly
                }}
              >
                {fmtDDHHMM(row.time_taken_hours)}
              </div>

            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [originalData, setOriginalData] = useState([]);
  const [data, setData] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");

  const [target, setTarget] = useState(getNextMonthResetTarget());

  const [tleft, setTleft] = useState(diffToDHMS(target));

  // NEW: previous ranks for movement arrows (from localStorage)
  const [prevRankById, setPrevRankById] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_RANK_KEY) || "{}");
    } catch {
      return {};
    }
  });

  // Measure the real header height so the sticky strip matches exactly
  const theadRef = useRef(null);
  const [headerH, setHeaderH] = useState(46);

  useLayoutEffect(() => {
    function measure() {
      if (theadRef.current) {
        const h = Math.round(theadRef.current.getBoundingClientRect().height);
        if (h > 0) setHeaderH(h);
      }
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Detect mobile viewport (<= 768px) to switch prize labels
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 768px)").matches
      : false
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener?.("change", onChange);
    mq.addListener?.(onChange); // Safari fallback
    return () => {
      mq.removeEventListener?.("change", onChange);
      mq.removeListener?.(onChange);
    };
  }, []);

  // Prize labels (1,2 special; 3–20 same label)
  const PRIZE_TOP_DESKTOP = {
    1: "$100,000 Funded Account",
    2: "$60,000 Funded Account",
  };
  const PRIZE_TOP_MOBILE = {
    1: "$100K Account",
    2: "$60K Account",
  };

  const PRIZE_3_TO_20_DESKTOP = "Discount of 22%";
  const PRIZE_3_TO_20_MOBILE  = "22% Discount";

  const prizeLabel = (rank1based) => {
    if (rank1based === 1) return isMobile ? PRIZE_TOP_MOBILE[1] : PRIZE_TOP_DESKTOP[1];
    if (rank1based === 2) return isMobile ? PRIZE_TOP_MOBILE[2] : PRIZE_TOP_DESKTOP[2];
    if (rank1based >= 3 && rank1based <= 22) return isMobile ? PRIZE_3_TO_20_MOBILE : PRIZE_3_TO_20_DESKTOP;
    return "";
  };

  async function loadData() {
    try {
      if (!SUPABASE_URL || !SUPABASE_ANON) {
        throw new Error("Missing REACT_APP_SUPABASE_URL or REACT_APP_SUPABASE_ANON_KEY");
      }

      // read PREVIOUS map first (before we overwrite it)
      let prevMap = {};
      try {
        prevMap = JSON.parse(localStorage.getItem(LS_RANK_KEY) || "{}");
      } catch {
        prevMap = {};
      }
      setPrevRankById(prevMap);

      const res = await fetch(SB_ACTIVE_URL, {
        headers: {
          apikey: SUPABASE_ANON,
          Authorization: `Bearer ${SUPABASE_ANON}`,
        },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }

      const rows = await res.json();

      // Defensive client-side sort (NULLs last)
      rows.sort((a, b) => {
        const av = Number.isFinite(Number(a.pct_change)) ? Number(a.pct_change) : -Infinity;
        const bv = Number.isFinite(Number(b.pct_change)) ? Number(b.pct_change) : -Infinity;
        return bv - av;
      });

      const norm = (r) => ({
        customer_name: r.customer_name ?? "",
        account_id: r.account_id ?? "",
        country: r.country ?? "",
        plan: r.plan ?? null,
        equity: r.equity ?? null,
        open_pnl: r.open_pnl ?? null,
        pct_change: r.pct_change ?? null,
        time_taken_hours: r.time_taken_hours ?? null,
        updated_at: r.updated_at ?? null,
      });

      const nextData = Array.isArray(rows) ? rows.map(norm) : [];

      // write NEW map for next refresh (don’t use it for arrows now)
      const nextRankMap = buildRankMap(nextData);
      try { localStorage.setItem(LS_RANK_KEY, JSON.stringify(nextRankMap)); } catch {}

      setOriginalData(nextData);
      setData(nextData);
    } catch (e) {
      console.error("[loadData] error:", e);
      setOriginalData([]);
      setData([]);
    }
  }


  useEffect(() => { loadData(); }, []);

  // Re-fetch at every even hour :30
  useEffect(() => {
    let cancelled = false;
    let timeoutId;
    function arm() {
      const ms = msUntilNextEvenHour30();
      timeoutId = setTimeout(async () => {
        if (cancelled) return;
        await loadData();
        arm();
      }, ms);
    }
    arm();
    return () => { cancelled = true; if (timeoutId) clearTimeout(timeoutId); };
  }, []);

  // Countdown tick
  useEffect(() => {
    const id = setInterval(() => {
      const now = new Date();
      if (now >= target) {
        const nextT = getNextMonthResetTarget(now);
        setTarget(nextT);
        setTleft(diffToDHMS(nextT, now));
      } else {
        setTleft(diffToDHMS(target, now));
      }
    }, 1000);
    return () => clearInterval(id);
  }, [target]);

  // build global rank index (by account_id)
  const globalRankById = useMemo(() => {
    const m = Object.create(null);
    for (let i = 0; i < originalData.length; i++) {
      const id = String(originalData[i]["account_id"] ?? "");
      if (id) m[id] = i;
    }
    return m;
  }, [originalData]);

  const handleSearch = (e) => {
    const q = e.target.value.toLowerCase();
    setSearchQuery(q);
    if (!q) { setData(originalData); return; }
    const filtered = originalData.filter(row =>
      Object.values(row).some(val => String(val ?? "").toLowerCase().includes(q))
    );
    setData(filtered);
  };

  const top30Data = useMemo(() => originalData.slice(0, 30), [originalData]);
  const rowsToRender = useMemo(() => (searchQuery ? data : top30Data), [searchQuery, data, top30Data]);

  const centerWrap = { maxWidth: 1250, margin: "0 auto" };
  const gradientTheadStyle = {
    background: "linear-gradient(135deg, #0f0f0f 0%, #222 60%, #d4af37 100%)",
    color: "#fff"
  };

  // Sticky header cells for the leaderboard table
  const stickyThBase = {
    position: "sticky",
    top: 0,
    zIndex: 5,
    boxShadow: "0 2px 0 rgba(0,0,0,0.4)"
  };

  // Prizes show ranks 1..20
  const visibleForPrizes = top30Data.slice(0, 20);

  // Live tz label (recomputed each render thanks to the ticking countdown)
  const londonTZ = getLondonTZAbbrev();

  // desktop column sizing (rank tighter, name wider, net% prominent, flag fixed)
  const COL_RANK_W = 80;
  const COL_NET_W  = 140;
  const COL_TIME_W = 110;
  const COL_FLAG_W = 110;

  return (
    <div
      style={{
        padding: "20px",
        fontFamily: "Switzer, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, 'Helvetica Neue', sans-serif",
        background: "transparent",
        color: "#eaeaea"
      }}
    >
      <h1
        style={{
          fontSize: "3.0rem",
          fontWeight: 900,
          marginBottom: "16px",
          fontFamily: "Switzer, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, 'Helvetica Neue', sans-serif",
          letterSpacing: "0.7px",
          textAlign: "center",
          textTransform: "uppercase",
          lineHeight: "1.15",
          background: "linear-gradient(90deg, #eee 0%, #d4af37 25%, #eee 50%, #d4af37 75%, #eee 100%)",
          backgroundSize: "300% 100%",
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          animation: "gradientShift 6s ease-in-out infinite"
        }}
      >
        E2T MONTHLY LEADERBOARD
      </h1>

      <div style={{ ...centerWrap }}>
        <div style={{ marginBottom: "16px", display: "flex", gap: "12px", alignItems: "center", justifyContent: "center" }}>
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={handleSearch}
            style={{
              padding: "10px 14px",
              width: "260px",
              border: "1px solid #2a2a2a",
              borderRadius: "6px",
              fontSize: "14px",
              fontFamily: "inherit",
              boxShadow: "0 0 0 rgba(0,0,0,0)",
              outline: "none",
              background: "#111",
              color: "#eaeaea"
            }}
          />
        </div>
      </div>

      <div className="layout-3col" style={{ ...centerWrap }}>
        {/* PRIZES */}
        <div className="col-prizes">
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              background: "#121212",
              boxShadow: "0 1px 6px rgba(0,0,0,0.6)",
              borderRadius: 8,
              overflow: "hidden",
              color: "#eaeaea"
            }}
          >
            <colgroup>
              <col style={{ width: 56 }} />
              <col />
            </colgroup>

            <thead style={gradientTheadStyle}>
              <tr>
                <th style={{ padding: "10px 8px", fontWeight: 900, textAlign: "left", fontSize: 14 }}>PRIZES</th>
                <th style={{ padding: "10px 8px", fontWeight: 900, textAlign: "right", fontSize: 14 }}>AMOUNT</th>
              </tr>
            </thead>
            <tbody>
              {top30Data.length === 0 ? (
                <tr><td colSpan={2} style={{ padding: 10, color: "#999" }}>No data</td></tr>
              ) : (
                <>
                  {/* Rank 1 */}
                  <tr style={{ background: "#1a1505" }}>
                    <td style={{
                      height: 45, lineHeight: "45px",
                      padding: 0, paddingLeft: 8,
                      fontWeight: 800,
                      borderLeft: "6px solid #F4C430"
                    }}>
                      🥇 1
                    </td>
                    <td style={{
                      height: 45, lineHeight: "45px",
                      padding: 0, paddingRight: 12,
                      fontSize: "15px",
                      fontWeight: 800,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis"
                    }}>
                      {isMobile ? PRIZE_TOP_MOBILE[1] : PRIZE_TOP_DESKTOP[1]}
                    </td>
                  </tr>

                  {/* Rank 2 */}
                  <tr style={{ background: "#0f1420" }}>
                    <td style={{
                      height: 45, lineHeight: "45px",
                      padding: 0, paddingLeft: 8,
                      fontWeight: 800,
                      borderLeft: "6px solid #B0B7C3"
                    }}>
                      🥈 2
                    </td>
                    <td style={{
                      height: 45, lineHeight: "45px",
                      padding: 0, paddingRight: 12,
                      fontSize: "14px",
                      fontWeight: 700,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis"
                    }}>
                      {isMobile ? PRIZE_TOP_MOBILE[2] : PRIZE_TOP_DESKTOP[2]}
                    </td>
                  </tr>

                  {/* Rank 3–22 */}
                  <tr style={{ background: "#121212" }}>
                    <td style={{
                      height: 45, lineHeight: "45px",
                      padding: 0, paddingLeft: 8,
                      fontWeight: 800,
                      borderLeft: "6px solid transparent"
                    }}>
                       ✯  3–22
                    </td>
                    <td style={{
                      height: 42, lineHeight: "42px",
                      padding: 0, paddingRight: 12,
                      fontSize: "13px",
                      fontWeight: 500,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis"
                    }}>
                      {isMobile ? PRIZE_3_TO_20_MOBILE : PRIZE_3_TO_20_DESKTOP}
                    </td>
                  </tr>

                  {/* Gold separator line */}
                  <tr>
                    <td colSpan={2} style={{ padding: 0 }}>
                      <div style={{ height: 2, background: "#F4C430" }} />
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* LEADERBOARD */}
        <div className="col-leaderboard">
          <div className="desktopOnly" style={{ overflowX: "auto", maxHeight: "70vh", overflowY: "auto" }}>
            {/* STICKY GRADIENT STRIP (behind header text) */}
            <div
              style={{
                position: "sticky",
                top: 0,
                height: headerH,
                background: "linear-gradient(135deg, #0f0f0f 0%, #222 60%, #d4af37 100%)",
                borderTopLeftRadius: 8,
                borderTopRightRadius: 8,
                zIndex: 4,
                marginBottom: -(headerH - 1),
                pointerEvents: "none"
              }}
            />

            <table
              cellPadding="5"
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
                textAlign: "center",
                fontFamily: "inherit",
                fontSize: "14px",
                backgroundColor: "#121212",
                borderRadius: 8,
                borderTopLeftRadius: 0,
                borderTopRightRadius: 0,
                overflow: "visible",
                color: "#eaeaea",
                border: "none"
              }}
            >
              {/* column sizing to match your screenshot */}
              <colgroup>
                <col style={{ width: COL_RANK_W }} />
                <col /> {/* NAME gets remaining space */}
                <col style={{ width: COL_NET_W }} />
                <col style={{ width: COL_TIME_W }} />
                <col style={{ width: COL_FLAG_W }} />
              </colgroup>

              <thead ref={theadRef}>
                <tr>
                  {["RANK", "NAME", "NET %", "TIME (DD:HH:MM)", "COUNTRY"].map((label, idx, arr) => (
                    <th
                      key={idx}
                      style={{
                        ...stickyThBase,
                        background: "transparent",
                        color: "#fff",
                        fontWeight: 1000,
                        fontSize: "16px",
                        padding: "10px 6px",
                        whiteSpace: "nowrap",
                        border: "none",
                        borderTopLeftRadius:  idx === 0 ? 8 : 0,
                        borderTopRightRadius: idx === arr.length - 1 ? 8 : 0
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {rowsToRender.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ padding: 20, color: "#999" }}>
                      No records found.
                    </td>
                  </tr>
                ) : (
                  rowsToRender.map((row, rowIndex) => {
                    const id = String(row["account_id"] ?? "");
                    const globalRank = globalRankById[id];
                    const displayRank = (globalRank >= 0 && Number.isInteger(globalRank)) ? globalRank + 1 : "";

                    const zebra = { background: rowIndex % 2 === 0 ? "#121212" : "#0f0f0f" };
                    const highlight = rowStyleForRank(globalRank);
                    const rowStyle = { ...zebra, ...highlight };

                    // only 1 & 2 get bigger font; 3+ identical
                    let rowFontSize = "14px";
                    let rowFontWeight = 400;
                    if (globalRank === 0) { rowFontSize = "17px"; rowFontWeight = 800; }
                    else if (globalRank === 1) { rowFontSize = "16px"; rowFontWeight = 700; }

                    const leftAccent = accentForRank(globalRank);

                    const nRaw = numVal(row["pct_change"]);
                    const n = (nRaw == null) ? null : Math.min(nRaw, 100);
                    const pctColor = n == null ? "#eaeaea" : (n > 0 ? "#34c759" : (n < 0 ? "#ff453a" : "#eaeaea"));

                    // keep net% prominent but not huge for 3+
                    let pctFont = rowFontSize;
                    if (globalRank === 0) pctFont = "calc(17px + 6px)";
                    else if (globalRank === 1) pctFont = "calc(16px + 4px)";
                    else pctFont = "15px";

                    const cellBase = { whiteSpace: "nowrap", fontSize: rowFontSize, fontWeight: rowFontWeight };

                    const rank1based = (typeof globalRank === "number" ? globalRank + 1 : null);
                    const isAfter22 = rank1based === 22;

                    return (
                      <React.Fragment key={id || rowIndex}>
                        <tr style={rowStyle}>
                          <td
                            style={{
                              ...cellBase,
                              fontWeight: 800,
                              borderLeft: globalRank <= 1 ? `8px solid ${leftAccent}` : "8px solid transparent",
                              textAlign: "center",
                            }}
                          >
                            {rankBadge(globalRank) || displayRank}
                          </td>

                          <td style={{ ...cellBase, textAlign: "center" }}>
                            {shortName(row["customer_name"])}
                          </td>

                          <td style={{ ...cellBase, textAlign: "center" }}>
                            <span style={{ color: pctColor, fontWeight: 800, fontSize: pctFont }}>
                              {fmtPct(n)}
                            </span>
                          </td>

                          <td style={{ ...cellBase, textAlign: "center", fontWeight: 500, color: "#eaeaea" }}>
                            {fmtDDHHMM(row["time_taken_hours"])}
                          </td>

                          <td style={{ ...cellBase, textAlign: "center" }}>
                            {getFlagOnly(row["country"])}
                          </td>
                        </tr>

                        {/* Gold separator AFTER rank 22 */}
                        {isAfter22 && (
                          <tr>
                            <td colSpan={5} style={{ padding: 0, background: "#121212" }}>
                              <div style={{ height: 2, background: "#F4C430" }} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* ===== Mobile cards (phone-only), uses same data ===== */}
          <div className="mobileOnly">
            <MobileLeaderboardCards
              rows={searchQuery ? data : []}
              rowsTop30={top30Data}
              globalRankById={globalRankById}
              prevRankById={prevRankById}
            />
          </div>
        </div>

        {/* COUNTDOWN */}
        <div className="col-countdown">
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13,
              background: "#121212",
              boxShadow: "0 1px 6px rgba(0,0,0,0.6)",
              borderRadius: 8,
              overflow: "hidden",
              color: "#eaeaea"
            }}
          >
            <thead style={gradientTheadStyle}>
              <tr>
                <th colSpan={4} style={{ padding: "10px 8px", fontWeight: 900, textAlign: "center", fontSize: 14 }}>
                  LEADERBOARD MONTHLY RESET
                </th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ background: "#0f0f0f" }}>
                <td style={{ padding: "8px 6px", fontWeight: 700, textAlign: "center" }}>DD</td>
                <td style={{ padding: "8px 6px", fontWeight: 700, textAlign: "center" }}>HH</td>
                <td style={{ padding: "8px 6px", fontWeight: 700, textAlign: "center" }}>MM</td>
                <td style={{ padding: "8px 6px", fontWeight: 700, textAlign: "center" }}>SS</td>
              </tr>
              <tr>
                <td style={{ padding: "10px 6px", textAlign: "center", fontWeight: 900, fontSize: 18 }}>{pad2(tleft.d)}</td>
                <td style={{ padding: "10px 6px", textAlign: "center", fontWeight: 900, fontSize: 18 }}>{pad2(tleft.h)}</td>
                <td style={{ padding: "10px 6px", textAlign: "center", fontWeight: 900, fontSize: 18 }}>{pad2(tleft.m)}</td>
                <td style={{ padding: "10px 6px", textAlign: "center", fontWeight: 900, fontSize: 18 }}>{pad2(tleft.s)}</td>
              </tr>

              <tr>
                <td colSpan={4} style={{ padding: "8px 6px", textAlign: "center", color: "#aaa", fontSize: 12 }}>
                  NEXT RESET: COMING 1ST @ 00:00 {londonTZ}
                </td>
              </tr>

              {/* Gold separator line */}
              <tr>
                <td colSpan={4} style={{ padding: 0 }}>
                  <div style={{ height: 2, background: "#F4C430" }} />
                </td>
              </tr>

            </tbody>
          </table>

        </div>
      </div>
    </div>
  );
}
