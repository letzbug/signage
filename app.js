const TZ = "Europe/Luxembourg";
const DATA_URL = "./data/today.json";

const REFRESH_MS = 60_000;
const SCROLL_SPEED_PX_PER_SEC = 28;
const SCROLL_PAUSE_MS = 1400;
const ROW_MIN_FOR_SCROLL = 7;

/* FILTER: nur UniPop Datensätze */
const UNIPOP_FILTER = [
  "unipop",
  "université populaire",
  "universite populaire",
  "université populaire luxembourg",
  "universite populaire luxembourg"
];

const elDate = document.getElementById("dateText");
const elSite = document.getElementById("siteText");
const elTime = document.getElementById("timeText");
const elSec  = document.getElementById("secText");

const elKpiCourses = document.getElementById("kpiCourses");
const elKpiPeople  = document.getElementById("kpiPeople");
const elKpiFull    = document.getElementById("kpiFull");
const elKpiNext    = document.getElementById("kpiNext");

const elRows = document.getElementById("rows");
const tbodyScroll = document.getElementById("tbodyScroll");
const countdownEl = document.getElementById("countdown");

let coursesCache = [];
let scrollState = { running:false, dir:1, raf:0, lastTs:0, pauseUntil:0 };

function nowLux(){ return new Date(); }

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
  return new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, second:"2-digit" }).format(d);
}
function capitalize(s){ return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function parseHHMM(s){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if(!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if(Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh*60 + mm;
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function safeNum(x, fallback=0){
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function unipopMatch(text){
  const t = String(text || "").toLowerCase();
  return UNIPOP_FILTER.some(k => t.includes(k));
}

/* Flexible JSON normalizer (passt sich deinem Export an) */
function normalizeItem(raw, defaultSite){
  // Date
  const date =
    raw.date || raw.datum || raw.day || raw.jour || null;

  // Time range (either "08:30–11:00" or start/end)
  const start = raw.start || raw.heure_debut || raw.time_start || raw.begin || null;
  const end   = raw.end   || raw.heure_fin   || raw.time_end   || raw.finish || null;
  const timeRange = raw.time || raw.zeit || raw.heure || raw.horaire || (start && end ? `${start}–${end}` : "—");

  // Course title + code
  const title =
    raw.title || raw.cours || raw.kurs || raw.course || raw.name || "—";

  const code =
    raw.code || raw.course_code || raw.kurs_code || raw.ref || raw.reference || raw.id_code || raw.shortcode || raw.sigle || raw.abbr || raw.courseId || raw.course_id || raw.id || "—";

  // Place / trainer
  const place =
    raw.place || raw.ort || raw.lieu || raw.location || raw.site || raw.organisation || raw.organization || defaultSite || "—";

  const trainer =
    raw.trainer || raw.formateur || raw.referent || raw.instructor || raw.animateur || raw.coach || "—";

  // Enrollment
  const enrolled = safeNum(raw.enrolled ?? raw.inscrits ?? raw.inscriptions ?? raw.participants ?? raw.nb_inscrits ?? 0);
  const capacity = safeNum(raw.capacity ?? raw.max ?? raw.places ?? raw.nb_places ?? raw.capacite ?? 0);

  // Room (optional)
  const room = raw.salle || raw.room || raw.local || raw.classroom || "";

  return { date, timeRange, title, code, place, trainer, enrolled, capacity, room };
}

function occPercent(enrolled, capacity){
  if(!capacity || capacity <= 0) return 0;
  return Math.round((enrolled / capacity) * 100);
}

function occDotClass(pct){
  if(pct >= 95) return "green";
  if(pct >= 70) return "amber";
  return "red";
}

function timeStartFromRange(range){
  // expects "08:30–11:00" or "08:30-11:00" -> return "08:30"
  const s = String(range || "");
  const m = s.match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : null;
}

function sortByTime(items){
  return [...items].sort((a,b)=>{
    const sa = parseHHMM(timeStartFromRange(a.timeRange) || "99:99") ?? 9999;
    const sb = parseHHMM(timeStartFromRange(b.timeRange) || "99:99") ?? 9999;
    return sa - sb;
  });
}

function renderTable(items){
  elRows.innerHTML = "";

  for(const it of items){
    const pct = occPercent(it.enrolled, it.capacity);
    const dot = occDotClass(pct);
    const cap = it.capacity > 0 ? it.capacity : Math.max(it.enrolled, 0);

    const tr = document.createElement("tr");

    const tdDate = document.createElement("td");
    tdDate.textContent = it.date || "—";
    tr.appendChild(tdDate);

    const tdTime = document.createElement("td");
    tdTime.textContent = it.timeRange || "—";
    tr.appendChild(tdTime);

    const tdCourse = document.createElement("td");
    tdCourse.innerHTML = `
      <div class="courseTitle">${escapeHtml(it.title)}</div>
      <div class="courseMeta">
        <span class="codePill">${escapeHtml(String(it.code))}</span>
      </div>
    `;
    tr.appendChild(tdCourse);

    const tdPlace = document.createElement("td");
    tdPlace.textContent = it.place || "—";
    tr.appendChild(tdPlace);

    const tdTrainer = document.createElement("td");
    tdTrainer.textContent = it.trainer || "—";
    tr.appendChild(tdTrainer);

    const tdOcc = document.createElement("td");
    tdOcc.innerHTML = `
      <div class="occWrap">
        <div class="occTop">
          <span class="occDot ${dot}"></span>
          <span>${pct}%</span>
        </div>
        <div class="occSub">${it.enrolled}/${cap}</div>
      </div>
    `;
    tr.appendChild(tdOcc);

    elRows.appendChild(tr);
  }
}

function computeKPIs(items){
  const totalCourses = items.length;
  const totalPeople = items.reduce((s,x)=> s + safeNum(x.enrolled,0), 0);
  const fullCount = items.filter(x => x.capacity > 0 && x.enrolled >= x.capacity).length;

  const next = sortByTime(items)[0];
  const nextStart = next ? (timeStartFromRange(next.timeRange) || "—") : "—";

  elKpiCourses.textContent = String(totalCourses);
  elKpiPeople.textContent  = String(totalPeople);
  elKpiFull.textContent    = String(fullCount);
  elKpiNext.textContent    = String(nextStart);

  return next || null;
}

function updateCountdown(nextItem){
  if(!nextItem){ countdownEl.textContent = "—"; return; }

  const nextStart = timeStartFromRange(nextItem.timeRange);
  if(!nextStart){ countdownEl.textContent = `${nextItem.timeRange} • ${nextItem.title}`; return; }

  const cur = parseHHMM(fmtTimeHM(nowLux()));
  const nxt = parseHHMM(nextStart);
  if(cur == null || nxt == null){ countdownEl.textContent = `${nextStart} • ${nextItem.title}`; return; }

  let diffMin = nxt - cur;
  if(diffMin < 0) diffMin = 0;

  const h = Math.floor(diffMin/60);
  const m = diffMin%60;

  countdownEl.textContent = `${String(h).padStart(2,"0")}h ${String(m).padStart(2,"0")}m • ${nextStart} • ${nextItem.title}`;
}

function tickClock(){
  const n = nowLux();
  elTime.textContent = fmtTimeHM(n);
  elSec.textContent = fmtSec(n);
  elDate.textContent = capitalize(fmtDateLong(n));
}

async function loadData(){
  const res = await fetch(DATA_URL + `?v=${Date.now()}`, { cache:"no-store" });
  if(!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const json = await res.json();

  const defaultSite = json.site || json.lieu || json.organisation || "UniPop";
  elSite.textContent = "UniPop";

  const list = Array.isArray(json.courses) ? json.courses
            : Array.isArray(json.items) ? json.items
            : Array.isArray(json.data) ? json.data
            : Array.isArray(json) ? json
            : [];

  let items = list.map(x => normalizeItem(x, defaultSite));

  // UniPop filter: on place / organisation / provider / any relevant field
  items = items.filter(it => unipopMatch(it.place) || unipopMatch(json.site) || unipopMatch(json.organisation));

  items = sortByTime(items);
  coursesCache = items;

  renderTable(items);
  const next = computeKPIs(items);
  updateCountdown(next);

  setupAutoScroll(items.length);
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
    tbodyScroll.scrollTop = Math.max(0, Math.min(max, tbodyScroll.scrollTop + delta));

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

/* Boot */
tickClock();
setInterval(tickClock, 250);

loadData().catch(()=>{});
setInterval(()=> loadData().catch(()=>{}), REFRESH_MS);

// Countdown tick every minute
setInterval(()=>{
  const next = sortByTime(coursesCache)[0] || null;
  updateCountdown(next);
}, 60_000);
