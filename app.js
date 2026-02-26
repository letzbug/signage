const TZ = "Europe/Luxembourg";
const DATA_URL = "./data/today.json";

const REFRESH_MS = 60_000;
const SCROLL_SPEED_PX_PER_SEC = 28;
const SCROLL_PAUSE_MS = 1400;
const ROW_MIN_FOR_SCROLL = 7;

/* DOM */
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

function escapeHtml(str){
  return String(str ?? "")
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
function parseHHMM(s){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if(!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if(Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh*60 + mm;
}
function pad2(n){ return String(n).padStart(2,"0"); }

/* yyyy-mm-dd -> dd.mm.yyyy */
function formatDateDMY(iso){
  const s = String(iso || "");
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)){
    const [y,m,d] = s.split("-");
    return `${d}.${m}.${y}`;
  }
  return s || "—";
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

/* Sorting by start time */
function sortByStart(items){
  return [...items].sort((a,b)=>{
    const sa = parseHHMM(a.start || "99:99") ?? 9999;
    const sb = parseHHMM(b.start || "99:99") ?? 9999;
    return sa - sb;
  });
}

function computeKPIs(items){
  const totalCourses = items.length;
  const totalPeople = items.reduce((s,x)=> s + safeNum(x.enrolled,0), 0);
  const fullCount = items.filter(x => x.capacity > 0 && x.enrolled >= x.capacity).length;

  const next = sortByStart(items).find(x => {
    const cur = parseHHMM(fmtTimeHM(nowLux()));
    const s = parseHHMM(x.start || "");
    return cur != null && s != null && s >= cur;
  }) || null;

  elKpiCourses.textContent = String(totalCourses);
  elKpiPeople.textContent  = String(totalPeople);
  elKpiFull.textContent    = String(fullCount);
  elKpiNext.textContent    = next ? next.start : "—";

  return next;
}

function updateCountdown(nextItem){
  if(!nextItem){ countdownEl.textContent = "—"; return; }

  const cur = parseHHMM(fmtTimeHM(nowLux()));
  const nxt = parseHHMM(nextItem.start || "");
  if(cur == null || nxt == null){
    countdownEl.textContent = `${nextItem.start || "—"} • ${nextItem.title || ""}`;
    return;
  }

  let diffMin = nxt - cur;
  if(diffMin < 0) diffMin = 0;

  const h = Math.floor(diffMin/60);
  const m = diffMin%60;

  countdownEl.textContent = `${pad2(h)}h ${pad2(m)}m • ${nextItem.start} • ${nextItem.title}`;
}

function renderTable(dateISO, items){
  elRows.innerHTML = "";
  const dateTxt = formatDateDMY(dateISO);

  for(const c of items){
    const timeRange = `${c.start}–${c.end}`;
    const title = c.title || "—";

    // “Code” in Kurs: prefer coursCode, else id
    const code = c.coursCode || c.code || c.id || "—";

    const place = c.lieu || c.site || "—";
    const trainer = c.trainer || c.formateur || "—";

    const enrolled = safeNum(c.enrolled ?? c.nbInscrits ?? 0);
    const capacity = safeNum(c.capacity ?? c.nbPlaces ?? 0);
    const pct = occPercent(enrolled, capacity);
    const dot = occDotClass(pct);
    const capShow = capacity > 0 ? capacity : Math.max(enrolled, 0);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(dateTxt)}</td>
      <td>${escapeHtml(timeRange)}</td>
      <td>
        <div class="courseTitle">${escapeHtml(title)}</div>
        <div class="courseMeta">
          <span class="codePill">${escapeHtml(String(code))}</span>
        </div>
      </td>
      <td>${escapeHtml(place)}</td>
      <td>${escapeHtml(trainer)}</td>
      <td>
        <div class="occWrap">
          <div class="occTop">
            <span class="occDot ${dot}"></span>
            <span>${pct}%</span>
          </div>
          <div class="occSub">${enrolled}/${capShow}</div>
        </div>
      </td>
    `;
    elRows.appendChild(tr);
  }
}

/* Auto-scroll */
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

/* Clock */
function tickClock(){
  const n = nowLux();
  elTime.textContent = fmtTimeHM(n);
  elSec.textContent = fmtSec(n);
  elDate.textContent = capitalize(fmtDateLong(n));
}

/* Load */
async function loadData(){
  const res = await fetch(DATA_URL + `?v=${Date.now()}`, { cache:"no-store" });
  if(!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const json = await res.json();

  const dateISO = json.date || null;
  const site = json.site || "UniPop";
  elSite.textContent = site;

  const list = Array.isArray(json.courses) ? json.courses : [];
  const items = sortByStart(list);

  coursesCache = items;

  renderTable(dateISO, items);

  const next = computeKPIs(items);
  updateCountdown(next);

  setupAutoScroll(items.length);
}

/* Boot */
tickClock();
setInterval(tickClock, 250);

loadData().catch(()=>{});
setInterval(()=> loadData().catch(()=>{}), REFRESH_MS);
setInterval(()=>{
  const next = computeKPIs(coursesCache);
  updateCountdown(next);
}, 60_000);
