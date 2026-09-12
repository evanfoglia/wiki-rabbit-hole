"use strict";

/* =====================================================================
   Wiki Rabbit Hole — a force-directed Wikipedia explorer.
   100% client-side. Live data from the public Wikipedia API.
   ===================================================================== */

const API = "https://en.wikipedia.org/w/api.php";
const MAX_NODES = 150;
const EXPAND_COUNT = 12;

/* ---------------- Wikipedia API ---------------- */

async function api(params) {
  const q = new URLSearchParams(Object.assign({ format: "json", origin: "*" }, params));
  const res = await fetch(API + "?" + q.toString(), {
    headers: { "Api-User-Agent": "WikiRabbitHole/1.0 (personal project)" },
  });
  if (!res.ok) throw new Error("Wikipedia request failed (" + res.status + ")");
  return res.json();
}

async function searchArticles(query, limit) {
  const data = await api({
    action: "query", list: "search",
    srsearch: query, srlimit: String(limit || 6), srnamespace: "0",
  });
  return (data.query.search || []).map((r) => r.title);
}

async function randomArticle() {
  const data = await api({ action: "query", list: "random", rnnamespace: "0", rnlimit: "1" });
  return data.query.random[0].title;
}

async function fetchLinks(title) {
  const data = await api({
    action: "query", prop: "links", titles: title,
    plnamespace: "0", pllimit: "80",
  });
  const pages = data.query.pages;
  const page = pages[Object.keys(pages)[0]];
  if (page.missing !== undefined) throw new Error("Article not found");
  return (page.links || []).map((l) => l.title);
}

async function fetchSummary(title) {
  const data = await api({
    action: "query", prop: "extracts|pageimages", titles: title,
    exintro: "1", explaintext: "1", exsentences: "3", pithumbsize: "500",
  });
  const pages = data.query.pages;
  const page = pages[Object.keys(pages)[0]];
  return {
    summary: ((page.extract || "").trim() || "No summary available for this article."),
    thumb: page.thumbnail ? page.thumbnail.source : null,
  };
}

/* ---------------- graph state ---------------- */

const nodes = new Map(); // title -> node
const edges = [];        // {a, b} titles
let focusTitle = null;
let explored = 0;
let history = []; // every article tapped, in first-visit order; never truncated

function nodeRadius(n) {
  if (n.depth === 0) return 16;
  if (n.title === focusTitle) return 13;
  return 9;
}

function nodeColor(n) {
  if (n.depth === 0) return "#ffd166";
  const hue = 262 - Math.min(n.depth, 8) * 22;
  return "hsl(" + hue + ", 75%, 64%)";
}

function addNode(title, parent) {
  if (nodes.has(title)) return nodes.get(title);
  const angle = Math.random() * Math.PI * 2;
  const dist = 130 + Math.random() * 60;
  const node = {
    title,
    x: parent ? parent.x + Math.cos(angle) * dist : (Math.random() - 0.5) * 200,
    y: parent ? parent.y + Math.sin(angle) * dist : (Math.random() - 0.5) * 200,
    vx: 0, vy: 0,
    depth: parent ? parent.depth + 1 : 0,
    parent: parent ? parent.title : null,
    expanded: false, expanding: false, failed: false,
    born: Date.now() + Math.random(),
    summary: null, thumb: null,
    fixed: false,
  };
  nodes.set(title, node);
  return node;
}

function addEdge(a, b) {
  edges.push({ a, b });
}

function degree(title) {
  let d = 0;
  for (const e of edges) if (e.a === title || e.b === title) d++;
  return d;
}

function recordVisit(title) {
  if (!history.includes(title)) history.push(title);
}

function prune() {
  if (nodes.size <= MAX_NODES) return;
  const keep = new Set(history);
  const candidates = [];
  for (const [title, n] of nodes) {
    if (keep.has(title)) continue;
    if (degree(title) <= 1) candidates.push(n);
  }
  candidates.sort((a, b) => a.born - b.born);
  let removed = 0;
  for (const n of candidates) {
    if (nodes.size - removed <= MAX_NODES) break;
    removed++;
  }
  for (const n of candidates.slice(0, removed)) {
    nodes.delete(n.title);
    for (let i = edges.length - 1; i >= 0; i--) {
      if (edges[i].a === n.title || edges[i].b === n.title) edges.splice(i, 1);
    }
  }
}

function resetGraph() {
  nodes.clear();
  edges.length = 0;
  focusTitle = null;
  history = [];
  explored = 0;
}

/* ---------------- expansion & focus ---------------- */

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

async function expand(node) {
  if (node.expanded || node.expanding) return;
  node.expanding = true;
  try {
    const links = await fetchLinks(node.title);
    if (!nodes.has(node.title)) return; // graph was reset mid-flight
    const fresh = shuffle(links.filter((t) => !nodes.has(t))).slice(0, EXPAND_COUNT);
    for (const t of fresh) {
      addNode(t, node);
      addEdge(node.title, t);
    }
    node.expanded = true;
    node.failed = false;
    explored += fresh.length;
    if (!fresh.length) toast("Dead end — no new links from here.");
    prune();
    updateStats();
    if (focusTitle === node.title) {
      panelMeta.textContent = "depth " + node.depth + " · " + degree(node.title) + " connections";
    }
  } catch (err) {
    node.failed = true;
    toast("That branch didn't open. Tap the node to retry.");
  } finally {
    node.expanding = false;
  }
}

function focus(node) {
  recordVisit(node.title);
  focusTitle = node.title;
  renderTrail();
  showPanel(node);
  updateStats();
  if (node.failed || !node.expanded) expand(node);
}

async function startFrom(title) {
  hideWelcome();
  resetGraph();
  clearTrailParam();
  renderTrail();
  hidePanel();
  const root = addNode(title, null);
  explored = 1;
  focus(root);
  updateStats();
  try {
    await expand(root);
  } catch (e) { /* expand() already toasted */ }
}

/* ---------------- canvas: camera, physics, render ---------------- */

const canvas = document.getElementById("graph");
const ctx = canvas.getContext("2d");
const cam = { x: 0, y: 0, zoom: 1 };
let DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * DPR));
  canvas.height = Math.max(1, Math.round(r.height * DPR));
}
window.addEventListener("resize", resize);

function worldToScreen(wx, wy) {
  const r = canvas.getBoundingClientRect();
  return [(wx - cam.x) * cam.zoom + r.width / 2, (wy - cam.y) * cam.zoom + r.height / 2];
}

function screenToWorld(sx, sy) {
  const r = canvas.getBoundingClientRect();
  return [(sx - r.width / 2) / cam.zoom + cam.x, (sy - r.height / 2) / cam.zoom + cam.y];
}

function tick() {
  const list = Array.from(nodes.values());
  // repulsion
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 4) d2 = 4;
      const d = Math.sqrt(d2);
      const f = Math.min(2600 / d2, 6);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      if (!a.fixed) { a.vx += fx; a.vy += fy; }
      if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
    }
  }
  // springs
  for (const e of edges) {
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d - 110) * 0.02;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (!a.fixed) { a.vx += fx; a.vy += fy; }
    if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
  }
  // gravity + damping + integrate
  for (const n of list) {
    if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
    n.vx += -n.x * 0.004;
    n.vy += -n.y * 0.004;
    n.vx *= 0.86; n.vy *= 0.86;
    n.x += n.vx; n.y += n.vy;
  }
}

function draw() {
  const w = canvas.width, h = canvas.height;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, w / DPR, h / DPR);

  // edges
  ctx.strokeStyle = "rgba(139, 124, 246, 0.28)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const e of edges) {
    const a = nodes.get(e.a), b = nodes.get(e.b);
    if (!a || !b) continue;
    const [ax, ay] = worldToScreen(a.x, a.y);
    const [bx, by] = worldToScreen(b.x, b.y);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();

  // nodes
  const t = performance.now() / 1000;
  for (const n of nodes.values()) {
    const [sx, sy] = worldToScreen(n.x, n.y);
    const r = nodeRadius(n) * cam.zoom;
    const isFocus = n.title === focusTitle;

    if (isFocus) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 7, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(139, 124, 246, 0.9)";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (n.failed) {
      ctx.beginPath();
      ctx.arc(sx, sy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = "#ff6b6b";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(r, 3), 0, Math.PI * 2);
    ctx.fillStyle = nodeColor(n);
    ctx.fill();
    if (n.expanding) {
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(r, 3) + 3 + Math.sin(t * 6) * 2, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // label
    const label = n.title.length > 26 ? n.title.slice(0, 25) + "…" : n.title;
    ctx.font = (isFocus ? "600 " : "") + Math.max(10, 11 * Math.min(cam.zoom, 1.4)) + "px -apple-system, sans-serif";
    ctx.textAlign = "center";
    const ly = sy + Math.max(r, 3) + 14;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(11, 14, 23, 0.85)";
    ctx.strokeText(label, sx, ly);
    ctx.fillStyle = isFocus ? "#ffffff" : "#aab3d0";
    ctx.fillText(label, sx, ly);
  }
}

function loop() {
  tick();
  draw();
  requestAnimationFrame(loop);
}

/* ---------------- pointer interaction ---------------- */

let dragNode = null;
let panning = false;
let downX = 0, downY = 0, moved = 0;
let lastPX = 0, lastPY = 0;

function hitNode(sx, sy) {
  const [wx, wy] = screenToWorld(sx, sy);
  const tol = 10 / cam.zoom;
  const list = Array.from(nodes.values());
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i];
    if (Math.hypot(n.x - wx, n.y - wy) < nodeRadius(n) + tol) return n;
  }
  return null;
}

const pointers = new Map();
let pinchDist = 0;
let pinching = false;

function zoomAt(px, py, factor) {
  const r = canvas.getBoundingClientRect();
  const [wx, wy] = screenToWorld(px, py);
  cam.zoom = Math.min(3, Math.max(0.25, cam.zoom * factor));
  cam.x = wx - (px - r.width / 2) / cam.zoom;
  cam.y = wy - (py - r.height / 2) / cam.zoom;
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  pointers.set(e.pointerId, [px, py]);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    pinching = true;
    if (dragNode) dragNode.fixed = false;
    dragNode = null;
    panning = false;
    canvas.style.cursor = "grab";
    return;
  }
  if (pointers.size !== 1) return;
  lastPX = px; lastPY = py;
  moved = 0;
  dragNode = hitNode(px, py);
  if (dragNode) {
    dragNode.fixed = true;
  } else {
    panning = true;
    canvas.style.cursor = "grabbing";
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const r = canvas.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  pointers.set(e.pointerId, [px, py]);
  if (pinching) {
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinchDist > 0 && dist > 0) {
        zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, dist / pinchDist);
      }
      pinchDist = dist;
    }
    return;
  }
  if (!dragNode && !panning) return;
  moved += Math.abs(px - lastPX) + Math.abs(py - lastPY);
  if (dragNode) {
    const [wx, wy] = screenToWorld(px, py);
    dragNode.x = wx; dragNode.y = wy;
  } else if (panning) {
    cam.x -= (px - lastPX) / cam.zoom;
    cam.y -= (py - lastPY) / cam.zoom;
  }
  lastPX = px; lastPY = py;
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinching) {
    if (pointers.size < 2) {
      pinching = false;
      pinchDist = 0;
      if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        lastPX = p[0]; lastPY = p[1];
        moved = 0;
        panning = true;
        canvas.style.cursor = "grabbing";
      } else {
        panning = false;
        canvas.style.cursor = "grab";
      }
    }
    return;
  }
  if (dragNode) {
    dragNode.fixed = false;
    if (moved < 6) {
      const n = dragNode;
      dragNode = null;
      panning = false;
      canvas.style.cursor = "grab";
      if (n.failed) { n.failed = false; focus(n); }
      else focus(n);
      return;
    }
    dragNode = null;
  }
  panning = false;
  canvas.style.cursor = "grab";
}

canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

/* ---------------- UI: panel, trail, stats, toast ---------------- */

const panel = document.getElementById("panel");
const panelTitle = document.getElementById("panelTitle");
const panelMeta = document.getElementById("panelMeta");
const panelSummary = document.getElementById("panelSummary");
const panelThumb = document.getElementById("panelThumb");
const panelLink = document.getElementById("panelLink");
const trailEl = document.getElementById("trail");
const statsEl = document.getElementById("stats");
const toastEl = document.getElementById("toast");
let toastTimer = null;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}

function hidePanel() {
  panel.classList.add("hidden");
}

document.getElementById("panelClose").addEventListener("click", hidePanel);

async function showPanel(node) {
  panel.classList.remove("hidden");
  panelTitle.textContent = node.title;
  panelMeta.textContent = "depth " + node.depth + " · " + degree(node.title) + " connections";
  panelLink.href = "https://en.wikipedia.org/wiki/" + encodeURIComponent(node.title.replace(/ /g, "_"));
  panelThumb.classList.add("hidden");
  panelThumb.removeAttribute("src");
  if (node.summary) {
    panelSummary.textContent = node.summary;
    if (node.thumb) {
      panelThumb.src = node.thumb;
      panelThumb.classList.remove("hidden");
    }
    return;
  }
  panelSummary.textContent = "Loading summary…";
  try {
    const { summary, thumb } = await fetchSummary(node.title);
    if (focusTitle !== node.title) return; // user moved on
    node.summary = summary;
    node.thumb = thumb;
    panelSummary.textContent = summary;
    if (thumb) {
      panelThumb.src = thumb;
      panelThumb.classList.remove("hidden");
    }
  } catch (err) {
    if (focusTitle !== node.title) return;
    panelSummary.textContent = "Couldn't load the summary.";
  }
}

function renderTrail() {
  trailEl.innerHTML = "";
  const chain = history;
  chain.forEach((title, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "→";
      trailEl.appendChild(sep);
    }
    const chip = document.createElement("button");
    chip.className = "crumb" + (title === focusTitle ? " current" : "");
    chip.textContent = title.length > 30 ? title.slice(0, 29) + "…" : title;
    chip.addEventListener("click", () => {
      const n = nodes.get(title);
      if (n) focus(n);
    });
    trailEl.appendChild(chip);
  });
  trailEl.scrollLeft = trailEl.scrollWidth;
}

function updateStats() {
  statsEl.textContent = nodes.size + " articles · depth " +
    (focusTitle && nodes.get(focusTitle) ? nodes.get(focusTitle).depth : 0);
}

/* ---------------- search & random ---------------- */

const searchForm = document.getElementById("searchForm");
const searchInput = document.getElementById("searchInput");
const suggestEl = document.getElementById("suggest");
let suggestItems = [];
let suggestActive = -1;
let suggestTimer = null;

function hideSuggest() {
  suggestEl.classList.add("hidden");
  suggestItems = [];
  suggestActive = -1;
}

function diveTo(title) {
  hideSuggest();
  searchInput.value = title;
  searchInput.blur();
  toast("Diving into “" + title + "”…");
  startFrom(title);
}

function renderSuggest(items) {
  suggestItems = items;
  suggestActive = -1;
  suggestEl.innerHTML = "";
  if (!items.length) { hideSuggest(); return; }
  for (const t of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "suggest-item";
    b.setAttribute("role", "option");
    b.textContent = t;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      diveTo(t);
    });
    suggestEl.appendChild(b);
  }
  suggestEl.classList.remove("hidden");
}

function markSuggestActive() {
  const kids = suggestEl.children;
  for (let i = 0; i < kids.length; i++) {
    kids[i].classList.toggle("active", i === suggestActive);
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { hideSuggest(); return; }
  suggestTimer = setTimeout(async () => {
    try {
      const results = await searchArticles(q, 7);
      if (searchInput.value.trim() !== q) return; // stale
      renderSuggest(results);
    } catch (err) { hideSuggest(); }
  }, 250);
});

searchInput.addEventListener("keydown", (e) => {
  if (suggestEl.classList.contains("hidden")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = suggestItems.length;
    if (!n) return;
    suggestActive = e.key === "ArrowDown"
      ? (suggestActive + 1) % n
      : (suggestActive - 1 + n) % n;
    markSuggestActive();
  } else if (e.key === "Escape") {
    hideSuggest();
  }
});

searchInput.addEventListener("blur", () => {
  setTimeout(hideSuggest, 150); // let suggestion taps land first
});

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".searchWrap")) hideSuggest();
});

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (suggestActive >= 0 && suggestItems[suggestActive]) {
    diveTo(suggestItems[suggestActive]);
    return;
  }
  hideSuggest();
  const q = searchInput.value.trim();
  if (!q) return;
  searchInput.blur();
  toast("Diving into “" + q + "”…");
  try {
    const results = await searchArticles(q);
    if (!results.length) { toast("No results for “" + q + "”."); return; }
    startFrom(results[0]);
  } catch (err) {
    toast("Search failed — check your connection and try again.");
  }
});

document.getElementById("randomBtn").addEventListener("click", rollRandom);
document.getElementById("welcomeRandom").addEventListener("click", rollRandom);

async function rollRandom() {
  toast("Rolling the dice…");
  try {
    startFrom(await randomArticle());
  } catch (err) {
    toast("Couldn't fetch a random article. Try again.");
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== searchInput) {
    e.preventDefault();
    searchInput.focus();
  }
});

/* ---------------- save & share trail ---------------- */

const SAVE_KEY = "wrh.savedTrails.v1";
const savedSheet = document.getElementById("savedSheet");
const savedList = document.getElementById("savedList");

function getSavedTrails() {
  try {
    const list = JSON.parse(localStorage.getItem(SAVE_KEY));
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function setSavedTrails(list) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(list)); } catch (e) {}
}

function clearTrailParam() {
  try {
    history.replaceState(null, "", location.pathname + location.hash);
  } catch (e) {}
}

function trailName(titles) {
  const short = (t) => t.length > 24 ? t.slice(0, 23) + "…" : t;
  return short(titles[0]) + " → " + short(titles[titles.length - 1]);
}

function saveTrail() {
  if (history.length < 2) {
    toast("Wander a little first — saving needs at least 2 articles.");
    return;
  }
  const list = getSavedTrails();
  list.unshift({ name: trailName(history), titles: history.slice(), savedAt: Date.now() });
  setSavedTrails(list.slice(0, 50));
  toast("Trail saved.");
  renderSavedSheet();
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error("copy failed"));
    } catch (e) {
      document.body.removeChild(ta);
      reject(e);
    }
  });
}

function shareTrail() {
  if (history.length < 2) {
    toast("Wander a little first — sharing needs at least 2 articles.");
    return;
  }
  const param = history.map((t) => encodeURIComponent(t)).join("|");
  const url = location.origin + location.pathname + "?trail=" + param;
  copyText(url).then(
    () => toast("Link copied — anyone who opens it walks your exact trail."),
    () => toast("Couldn't copy automatically. The link is: " + url)
  );
}

function decodeTrailParam(param) {
  return param.split("|").map((s) => {
    try { return decodeURIComponent(s); } catch (e) { return null; }
  }).filter((t) => t && t.length);
}

function restoreTrail(titles) {
  resetGraph();
  hidePanel();
  let prev = null;
  for (const t of titles) {
    const n = addNode(t, prev);
    if (prev) addEdge(prev.title, n.title);
    prev = n;
  }
  history = titles.slice();
  explored = titles.length;
  renderTrail();
  updateStats();
  if (prev) focus(prev);
}

function renderSavedSheet() {
  const list = getSavedTrails();
  savedList.innerHTML = "";
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "savedEmpty";
    p.textContent = "Nothing saved yet. Wander the graph, then hit Save.";
    savedList.appendChild(p);
    return;
  }
  list.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "savedRow";
    const info = document.createElement("button");
    info.className = "savedInfo";
    info.type = "button";
    const name = document.createElement("div");
    name.className = "savedName";
    name.textContent = entry.name;
    const meta = document.createElement("div");
    meta.className = "savedMeta";
    const d = new Date(entry.savedAt);
    meta.textContent = entry.titles.length + " articles · " +
      (isNaN(d) ? "" : d.toLocaleDateString());
    info.appendChild(name);
    info.appendChild(meta);
    info.addEventListener("click", () => {
      savedSheet.classList.add("hidden");
      restoreTrail(entry.titles.slice());
    });
    const del = document.createElement("button");
    del.className = "ghost savedDel";
    del.type = "button";
    del.textContent = "✕";
    del.setAttribute("aria-label", "Delete saved trail");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const l = getSavedTrails();
      l.splice(i, 1);
      setSavedTrails(l);
      renderSavedSheet();
    });
    row.appendChild(info);
    row.appendChild(del);
    savedList.appendChild(row);
  });
}

document.getElementById("saveBtn").addEventListener("click", saveTrail);
document.getElementById("shareBtn").addEventListener("click", shareTrail);
document.getElementById("savedBtn").addEventListener("click", () => {
  renderSavedSheet();
  savedSheet.classList.toggle("hidden");
});
document.getElementById("savedClose").addEventListener("click", () => {
  savedSheet.classList.add("hidden");
});

/* ---------------- boot ---------------- */

resize();
requestAnimationFrame(loop);

const welcomeEl = document.getElementById("welcome");
function showWelcome() { welcomeEl.classList.remove("hidden"); }
function hideWelcome() { welcomeEl.classList.add("hidden"); }

(async function init() {
  const param = new URLSearchParams(location.search).get("trail");
  const titles = param ? decodeTrailParam(param) : [];
  try {
    if (titles.length >= 2) {
      restoreTrail(titles);
    } else {
      showWelcome();
    }
  } catch (err) {
    toast("Couldn't reach Wikipedia. Check your connection and reload.");
  }
})();



