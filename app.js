/* UniPop Signage — pixel clean table + auto-scroll + JSON refresh */

const TZ = "Europe/Luxembourg";
const DATA_URL = "./data/today.json";
const REFRESH_MS = 60_000;          // reload JSON every 60s
const SCROLL_SPEED_PX_PER_SEC = 28; // smooth signage scroll
const SCROLL_PAUSE_MS = 1400;       // pause at top/bottom
const ROW_MIN_FOR_SCROLL = 7;       // under this, no scroll

const elDate = document.getElementById("dateText");
const elSite = document.getElementById("siteText");
const elTime = document.getElementById("timeText");
const elSec  = document.getElementById("secText");

const elKpiCourses = document.getElementById("kpiCourses");
const elKpiPeople  = document.getElementById("kpiPeople");
const elKpiNow     = document.getElementById("kpiNow");
const elKpiNext    = document.getElementById("kpiNext");

const elRows = document.getElementById("rows");
const tbodyScroll = document.getElementById("tbodyScroll");
const countdownEl = document.getElementById("countdown");

let coursesCache = [];
let scrollState = { running:false, dir:1, raf:0, lastTs:0, pauseUntil:0 };

function nowLux(){
  // "now" as Date; formatting uses Intl with TZ
  return new Date();
}

function fmtDateLong(d){
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TZ, weekday:"long", day:"2-digit", month:"long", year:"numeric"
  }).format(d);
}

function fmtTimeHM(d){
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TZ, hour:"2-digit", minute:"2-digit", hour12:false
  }).format(d);
}

function fmtSec(d){
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TZ, second:"2-digit"
  }).format(d);
}

function parseHHMM(s){
  // "13:00" -> minutes since 00:00
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if(!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if(Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh*60 + mm;
}

function statusFromTimes(startHM, endHM){
  const n = nowLux();
  const cur = parseHHMM(new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour:"2-digit", minute:"2-digit", hour12:false }).format(n));
  const s = parseHHMM(startHM);
  const e = parseHHMM(endHM);
  if(s == null || e == null || cur == null) return "À VENIR";
  if(cur >= s && cur < e) return "EN COURS";
  if(cur < s) return "À VENIR";
  return "TERMINÉ";
}

function dotClassFor(status){
  const st = String(status || "").toUpperCase();
  if(st.includes("COURS")) return "green";
  if(st.includes("COMPLET")) return "red";
  return "blue";
}

function safeNum(x, fallback=0){
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function normalizeData(json){
  // Accept both {site, date, courses:[...]} or {site, date, items:[...]}
  const site = json.site || json.lieu || "—";
  const date = json.date || null;
  const list = Array.isArray(json.courses) ? json.courses
            : Array.isArray(json.items) ? json.items
            : [];

  const courses = list.map((c) => {
    const start = c.start || c.heure_debut || c.time_start || "00:00";
    const end   = c.end   || c.heure_fin   || c.time_end   || "00:00";
    const title = c.title || c.cours || c.name || "—";
    const id    = c.id ?? c.course_id ?? "—";
    const lieu  = c.lieu || c.site || site || "—";
    const salle = c.salle || c.room || "—";
    const enrolled = safeNum(c.enrolled ?? c.inscrits ?? c.inscriptions ?? 0);
    const capacity = safeNum(c.capacity ?? c.max ?? c.places ?? 0);
    const status = c.status || statusFromTimes(start, end);
    return { start, end, title, id, lieu, salle, enrolled, capacity, status };
  });

  return { site, date, courses };
}

function sortCourses(courses){
  // EN COURS first, then by start time
  const rank = (s) => {
    const st = String(s || "").toUpperCase();
    if(st.includes("COURS")) return 0;
    if(st.includes("À VENIR") || st.includes("A VENIR")) return 1;
    if(st.includes("COMPLET")) return 2;
    if(st.includes("TERMIN")) return 3;
    return 9;
  };

  return [...courses].sort((a,b)=>{
    const ra = rank(a.status), rb = rank(b.status);
    if(ra !== rb) return ra - rb;
    const sa = parseHHMM(a.start) ?? 9999;
    const sb = parseHHMM(b.start) ?? 9999;
    return sa - sb;
  });
}

function renderTable(courses){
  elRows.innerHTML = "";

  for(const c of courses){
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = `${c.start}–${c.end}`;
    tr.appendChild(tdTime);

    const tdTitle = document.createElement("td");
    tdTitle.innerHTML = `<span class="courseTitle">${escapeHtml(c.title)}</span>`;
    tr.appendChild(tdTitle);

    const tdId = document.createElement("td");
    tdId.textContent = String(c.id);
    tr.appendChild(tdId);

    const tdIns = document.createElement("td");
    const cap = c.capacity > 0 ? c.capacity : Math.max(c.enrolled, 1);
    const pct = clamp((c.enrolled / cap) * 100, 0, 100);

    tdIns.innerHTML = `
      <div class="insWrap">
        <div class="insText">${c.enrolled}/${cap}</div>
        <div class="bar"><span style="width:${pct}%;"></span></div>
      </div>
    `;
    tr.appendChild(tdIns);

    const tdLieu = document.createElement("td");
    tdLieu.textContent = String(c.lieu);
    tr.appendChild(tdLieu);

    const tdSalle = document.createElement("td");
    tdSalle.textContent = String(c.salle);
    tr.appendChild(tdSalle);

    const tdStat = document.createElement("td");
    const dot = dotClassFor(c.status);
    const label = String(c.status || "").toUpperCase().includes("A VENIR") ? "À VENIR" : c.status;
    tdStat.innerHTML = `
      <div class="stat">
        <span class="dot ${dot}"></span>
        <span>${escapeHtml(label)}</span>
      </div>
    `;
    tr.appendChild(tdStat);

    elRows.appendChild(tr);
  }
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function computeKPIs(courses){
  const totalCourses = courses.length;
  const totalPeople = courses.reduce((sum,c)=> sum + safeNum(c.enrolled,0), 0);

  const nowCount = courses.filter(c => String(c.status||"").toUpperCase().includes("COURS")).length;

  // Next: earliest upcoming
  const upcoming = courses
    .filter(c => String(c.status||"").toUpperCase().includes("VENIR"))
    .sort((a,b)=> (parseHHMM(a.start) ?? 9999) - (parseHHMM(b.start) ?? 9999));

  const next = upcoming[0];
  const nextText = next ? next.start : "—";

  elKpiCourses.textContent = String(totalCourses);
  elKpiPeople.textContent  = String(totalPeople);
  elKpiNow.textContent     = String(nowCount);
  elKpiNext.textContent    = String(nextText);

  return next || null;
}

function updateCountdown(nextCourse){
  if(!nextCourse){
    countdownEl.textContent = "—";
    return;
  }

  const n = nowLux();
  // Build “today at nextCourse.start” in Lux time by comparing minutes
  const curHM = parseHHMM(fmtTimeHM(n));
  const nextHM = parseHHMM(nextCourse.start);

  if(curHM == null || nextHM == null){
    countdownEl.textContent = "—";
    return;
  }

  let diffMin = nextHM - curHM;
  if(diffMin < 0) diffMin = 0;

  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;

  countdownEl.textContent = `${String(hours).padStart(2,"0")}h ${String(mins).padStart(2,"0")}m • ${nextCourse.start} • ${nextCourse.title}`;
}

function tickClock(){
  const n = nowLux();
  elTime.textContent = fmtTimeHM(n);
  elSec.textContent = fmtSec(n);
  elDate.textContent = capitalize(fmtDateLong(n));
}
function capitalize(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

async function loadData(){
  const bust = `?v=${Date.now()}`;
  const res = await fetch(DATA_URL + bust, { cache:"no-store" });
  if(!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const json = await res.json();
  const norm = normalizeData(json);

  elSite.textContent = norm.site || "—";
  const sorted = sortCourses(norm.courses);
  coursesCache = sorted;

  renderTable(sorted);
  const next = computeKPIs(sorted);
  updateCountdown(next);

  setupAutoScroll(sorted.length);
}

function stopAutoScroll(){
  scrollState.running = false;
  cancelAnimationFrame(scrollState.raf);
  scrollState.raf = 0;
  scrollState.lastTs = 0;
  scrollState.pauseUntil = 0;
  tbodyScroll.scrollTop = 0;
}

function setupAutoScroll(rowCount){
  stopAutoScroll();

  // Only scroll if content overflows + enough rows
  const canScroll = tbodyScroll.scrollHeight > tbodyScroll.clientHeight + 4;
  if(!canScroll || rowCount < ROW_MIN_FOR_SCROLL) return;

  scrollState.running = true;
  scrollState.dir = 1;
  scrollState.pauseUntil = performance.now() + SCROLL_PAUSE_MS;

  const step = (ts) => {
    if(!scrollState.running) return;

    if(!scrollState.lastTs) scrollState.lastTs = ts;
    const dt = (ts - scrollState.lastTs) / 1000;
    scrollState.lastTs = ts;

    if(ts < scrollState.pauseUntil){
      scrollState.raf = requestAnimationFrame(step);
      return;
    }

    const max = tbodyScroll.scrollHeight - tbodyScroll.clientHeight;
    const delta = SCROLL_SPEED_PX_PER_SEC * dt * scrollState.dir;
    tbodyScroll.scrollTop = clamp(tbodyScroll.scrollTop + delta, 0, max);

    // pause at ends
    if(tbodyScroll.scrollTop <= 0 && scrollState.dir < 0){
      scrollState.dir = 1;
      scrollState.pauseUntil = ts + SCROLL_PAUSE_MS;
    } else if(tbodyScroll.scrollTop >= max - 1 && scrollState.dir > 0){
      scrollState.dir = -1;
      scrollState.pauseUntil = ts + SCROLL_PAUSE_MS;
    }

    scrollState.raf = requestAnimationFrame(step);
  };

  scrollState.raf = requestAnimationFrame(step);
}

function scheduleRefresh(){
  setInterval(async ()=>{
    try { await loadData(); }
    catch(e){ /* silently keep screen */ }
  }, REFRESH_MS);
}

function scheduleMidnightReload(){
  // Reload page shortly after midnight Luxembourg time
  setInterval(()=>{
    const n = nowLux();
    const hm = fmtTimeHM(n);
    if(hm === "00:01"){
      location.reload();
    }
  }, 30_000);
}

/* Boot */
tickClock();
setInterval(tickClock, 250);

loadData().catch(()=>{ /* show empty board if data missing */ });
scheduleRefresh();
scheduleMidnightReload();

// Countdown tick every minute (cheap)
setInterval(()=>{
  // recompute next based on cached + current time
  const next = coursesCache
    .map(c => ({...c, status: c.status || statusFromTimes(c.start,c.end)}))
    .filter(c => String(statusFromTimes(c.start,c.end)).toUpperCase().includes("VENIR"))
    .sort((a,b)=> (parseHHMM(a.start) ?? 9999) - (parseHHMM(b.start) ?? 9999))[0] || null;

  updateCountdown(next);
}, 60_000);
