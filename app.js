const TZ = "Europe/Luxembourg";
const DATA_URL = "./data/today.json";

const REFRESH_MS = 60_000;
const SCROLL_SPEED_PX_PER_SEC = 28;
const SCROLL_PAUSE_MS = 1400;
const ROW_MIN_FOR_SCROLL = 7;

/* UniPop Filter über adresseCours.nom */
function isUniPopCourse(raw){
  const nom = (raw?.adresseCours?.nom || "").toLowerCase();
  return nom.includes("université populaire") || nom.includes("universite populaire") || nom.includes("unipop");
}

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

/* dd/mm/yyyy -> dd.mm.yyyy */
function formatDateDE(fr){
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(fr || "").trim());
  if(!m) return fr || "—";
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/* Try to read date from horaires[0] or fallback to dateDebut */
function getDate(raw){
  // common possibilities in horaires objects
  const h0 = Array.isArray(raw?.horaires) ? raw.horaires[0] : null;

  const d =
    h0?.date || h0?.jour || h0?.dateCours || h0?.dateSeance ||
    raw?.date || raw?.dateDebut || null;

  // If it's already like "23/02/2026" -> convert
  if(typeof d === "string" && d.includes("/")) return formatDateDE(d);

  // If ISO -> display dd.mm.yyyy
  if(typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d)){
    const [Y,M,D] = d.slice(0,10).split("-");
    return `${D}.${M}.${Y}`;
  }

  return d ? String(d) : "—";
}

/* Extract start/end from horaires[0] or parse from horairePrevu */
function getTimeRange(raw){
  const h0 = Array.isArray(raw?.horaires) ? raw.horaires[0] : null;

  // Most likely fields
  const start =
    h0?.heureDebut || h0?.start || h0?.debut || h0?.heureStart || null;

  const end =
    h0?.heureFin || h0?.end || h0?.fin || h0?.heureEnd || null;

  if(start && end) return `${start}–${end}`;

  // Fallback: parse "Lundi à 18:00 (durée 1h40)"
  const hp = String(raw?.horairePrevu || "");
  const startMatch = hp.match(/(\d{1,2}:\d{2})/);
  const durMatch = hp.match(/durée\s*(\d+)\s*h\s*(\d+)?/i) || hp.match(/dur[ée]e\s*(\d+)h(\d+)?/i);

  if(startMatch){
    const s = startMatch[1];
    if(durMatch){
      const h = Number(durMatch[1] || 0);
      const m = Number(durMatch[2] || 0);
      const sMin = parseHHMM(s);
      if(sMin != null){
        const eMin = sMin + h*60 + m;
        const eh = Math.floor(eMin/60) % 24;
        const em = eMin % 60;
        return `${s}–${pad2(eh)}:${pad2(em)}`;
      }
    }
    // no duration -> show start only (still ok)
    return `${s}–—`;
  }

  return "—";
}

/* Trainer display from enseignants[] */
function getTrainer(raw){
  const ens = Array.isArray(raw?.enseignants) ? raw.enseignants : [];
  if(!ens.length) return raw?.enseignant || raw?.trainer || "—";

  // try common shapes: {prenom, nom} or {firstName,lastName} or plain string
  const first = ens[0];
  if(typeof first === "string") return first;

  const prenom = first?.prenom || first?.firstName || "";
  const nom = first?.nom || first?.lastName || "";
  const full = `${prenom} ${nom}`.trim();
  return full || "—";
}

/* Ort display from adresseCours */
function getPlace(raw){
  const a = raw?.adresseCours || {};
  const nom = a?.nom || raw?.lieu || raw?.ort || "—";
  const loc = a?.localite || a?.ville || "";
  // like screenshot: "Université Populaire Belval" (optional add localite)
  return loc ? `${nom}` : `${nom}`;
}

/* Percent + color dot */
function occPercent(enrolled, capacity){
  if(!capacity || capacity <= 0) return 0;
  return Math.round((enrolled / capacity) * 100);
}
function occDotClass(pct){
  if(pct >= 95) return "green";
  if(pct >= 70) return "amber";
  return "red";
}

/* start time for sorting */
function timeStartFromRange(range){
  const m = String(range || "").match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : null;
}
function sortByTime(items){
  return [...items].sort((a,b)=>{
    const sa = parseHHMM(timeStartFromRange(a.timeRange) || "99:99") ?? 9999;
    const sb = parseHHMM(timeStartFromRange(b.timeRange) || "99:99") ?? 9999;
    return sa - sb;
  });
}

/* Normalize your UniPop JSON object */
function normalizeItem(raw){
  const date = getDate(raw);
  const timeRange = getTimeRange(raw);

  const title = raw?.intitule || raw?.titre || raw?.title || "—";
  const code  = raw?.coursCode || raw?.coursId || raw?.code || raw?.id || "—";

  const place = getPlace(raw);
  const trainer = getTrainer(raw);

  const enrolled = safeNum(raw?.nbInscrits ?? raw?.nbInscriptions ?? raw?.nbInscrit ?? 0);
  const capacity = safeNum(raw?.nbPlaces ?? raw?.places ?? raw?.capacite ?? 0);

  return { date, timeRange, title, code, place, trainer, enrolled, capacity };
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
  if(cur == null || nxt == null){
    countdownEl.textContent = `${nextStart} • ${nextItem.title}`;
    return;
  }

  let diffMin = nxt - cur;
  if(diffMin < 0) diffMin = 0;

  const h = Math.floor(diffMin/60);
  const m = diffMin%60;

  countdownEl.textContent = `${pad2(h)}h ${pad2(m)}m • ${nextStart} • ${nextItem.title}`;
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

  // array roots supported
  const list = Array.isArray(json) ? json
    : Array.isArray(json.items) ? json.items
    : Array.isArray(json.data) ? json.data
    : Array.isArray(json.courses) ? json.courses
    : [];

  // filter UniPop + normalize
  let items = list.filter(isUniPopCourse).map(normalizeItem);

  // sort
  items = sortByTime(items);

  coursesCache = items;

  renderTable(items);
  const next = computeKPIs(items);
  updateCountdown(next);

  setupAutoScroll(items.length);

  elSite.textContent = "UniPop";
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

setInterval(()=>{
  const next = sortByTime(coursesCache)[0] || null;
  updateCountdown(next);
}, 60_000);
