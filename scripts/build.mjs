#!/usr/bin/env node
/**
 * build.mjs — builds aicv.co into dist/ from ONE content file, content/hub.json.
 *
 *   dist/index.html   the hub: map, "Reach me", "Every destination", TEDx card,
 *                     "The short version", footer, JSON-LD in <head>
 *   dist/llms.txt     the agent-readable summary
 *   dist/sitemap.xml, dist/now.json (the live "Right now" values), static/ copied as-is
 *
 * Everything is rendered into plain HTML here, at build time: the map's names, links and
 * panel text are all in the page source, so agents and no-JS crawlers see what people see.
 * The only JavaScript on the page opens the TEDx player and manages focus on the panels.
 *
 * Live data, fetched at build time (never in the browser):
 *   - the latest AICV News headline (a project's "feed" RSS URL) -> that panel's "Right now"
 *   - events: past ones drop off (Pacific time), the next one per project shows on its panel
 * If a feed fails, the build keeps the last good value (read back from the live
 * https://aicv.co/now.json), then falls back to the project's own "now" text. A feed never
 * breaks the build; a mistake in hub.json does (with a message saying what to fix).
 *
 * Last step: the entity check (scripts/check-entity.mjs) runs over dist/. A violation fails
 * the build, so a page that breaks the entity firewall never deploys.
 *
 * Run:  node scripts/build.mjs            (Cloudflare Pages build command; output dir: dist)
 *       node scripts/build.mjs --offline  (no network: skips the feed and the last-good read)
 *       AICV_CO_TODAY=2026-12-06 node scripts/build.mjs   (pretend it's another day)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const OFFLINE = process.argv.includes('--offline');
const INNER_CAP = 8;
const LAB_CAP = 12;
const STATUS_LABEL = { open: 'Open', running: 'Running', completed: 'Completed', idea: 'Idea' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- load + validate
let hub;
try {
  hub = JSON.parse(readFileSync(join(ROOT, 'content/hub.json'), 'utf8'));
} catch (e) {
  fail(`content/hub.json is not valid JSON: ${e.message}`);
}
validate(hub);

const SITE = hub.site.url.replace(/\/$/, '');
const P = hub.person;
const C = P.contact;
const TODAY = process.env.AICV_CO_TODAY || new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());


// ---------------------------------------------------------------- live data
const lastGood = await readLastGood();
const feeds = {};
for (const p of hub.projects.filter((x) => x.feed)) {
  feeds[p.id] = await latestFromFeed(p.feed) || lastGood?.feeds?.[p.id] || null;
}
const upcoming = (hub.events || [])
  .filter((e) => e.date >= TODAY)
  .sort((a, b) => a.date.localeCompare(b.date));
const droppedEvents = (hub.events || []).length - upcoming.length;

// ---------------------------------------------------------------- "Right now" lines
// Each returns { html, text } so the page and llms.txt say the same thing.
function nowFor(item) {
  if (item.feed && feeds[item.id]) {
    const f = feeds[item.id];
    return {
      html: `Latest from ${esc(item.name)}: <a href="${esc(f.url)}">“${esc(f.title)}”</a>`,
      text: `Latest from ${item.name}: “${f.title}” (${f.url})`,
    };
  }
  const ev = upcoming.find((e) => e.project === item.id);
  if (ev) {
    const title = ev.url ? `<a href="${esc(ev.url)}">${esc(ev.title)}</a>` : esc(ev.title);
    const kind = ev.kind ? `, a ${ev.free ? 'free ' : ''}${ev.kind}` : '';
    const free = !ev.kind && ev.free ? ' Free.' : '';
    const tail = `${kind}, ${shortDate(ev.date)} at ${ev.place}.${free}`;
    return { html: `Next up: ${title}${esc(tail)}`, text: `Next up: ${ev.title}${tail}` };
  }
  return { html: esc(item.now), text: item.now };
}

function nowForMe() {
  const [a, b] = upcoming;
  if (!a) return { html: esc(P.now), text: P.now };
  let t;
  if (!b) t = `Hosting ${a.short || a.title} on ${shortDate(a.date)} at ${a.place}.`;
  else if (a.place === b.place) t = `Hosting ${a.short || a.title} on ${shortDate(a.date)} and ${b.short || b.title} on ${shortDate(b.date)}, both at ${a.place}.`;
  else t = `Hosting ${a.short || a.title} on ${shortDate(a.date)} at ${a.place}, and ${b.short || b.title} on ${shortDate(b.date)} at ${b.place}.`;
  return { html: esc(t), text: t };
}

// ---------------------------------------------------------------- map layout
// Desktop map: a 3:2 box (reference 1176 x 784 px). Projects on the inner ring, the lab on
// the outer ring, ideas as pencil doodles near the item they name. Positions are % of the box.
// Tall map (tablets and phones): projects ring around Sat; the lab sits in rows of up to three
// above and below the ring, joined by dashed spokes; no doodles. Tall units are % of the width
// (cqw), converted to % of the box height for "top".
const W = 1176, H = 784, KX = 900 / W, KY = 900 / H;
const R_IN = 28, R_OUT = 41;                       // design radii (scaled by KX/KY)
const rad = (d) => (d * Math.PI) / 180;
const f2 = (n) => Number(n.toFixed(2));

const innerOnMap = hub.projects.slice(0, INNER_CAP);
const labOnMap = hub.lab.slice(0, LAB_CAP);
const N = innerOnMap.length, M = labOnMap.length;

const nodeAt = (r, deg) => ({ x: 50 + r * KX * Math.cos(rad(deg)), y: 50 + r * KY * Math.sin(rad(deg)) });

const T_IN = 33, T_ROW = 17, T_RING = 94;          // ring radius, lab row height, ring band height (cqw)
const labTop = Math.ceil(M / 2), labBottom = M - labTop;
const rowsTop = Math.ceil(labTop / 3), rowsBottom = Math.ceil(labBottom / 3);
const tallTopBand = rowsTop * T_ROW + (rowsTop ? 2 : 0), tallBottomBand = rowsBottom * T_ROW + (rowsBottom ? 2 : 0);
const tallH = tallTopBand + T_RING + tallBottomBand;
const tallCY = tallTopBand + T_RING / 2;
const tallPoint = (x, y) => {
  const dx = x - 50, dy = y - tallCY;
  return { x, y: (y / tallH) * 100, len: Math.hypot(dx, dy), deg: (Math.atan2(dy, dx) * 180) / Math.PI };
};
const tallLab = (i) => {
  const top = i < labTop, j = top ? i : i - labTop, count = top ? labTop : labBottom;
  const row = Math.floor(j / 3), inRow = Math.min(3, count - row * 3), col = j % 3;
  const x = ((col + 0.5) * 100) / inRow;
  const y = top ? 1 + (row + 0.5) * T_ROW : tallTopBand + T_RING + 1 + (row + 0.5) * T_ROW;
  return tallPoint(x, y);
};

const innerSize = Math.min(13.01, 0.78 * (2 * Math.PI * R_IN * KX) / Math.max(N, 1));
const tallInnerSize = Math.min(26, 0.8 * (2 * Math.PI * T_IN) / Math.max(N, 1));

const AGENT_COLORS = ['#F2C15A', '#E98A3B', '#C9502A', '#4DA3FF', '#2B1A10', '#7A3418', '#A8401E'];
function agents(own, seed, count) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const r = Math.abs(Math.sin((seed + 1) * 12.9898 + k * 78.233) * 43758.5453) % 1;
    const r2 = Math.abs(Math.sin((seed + 3) * 39.346 + k * 11.135) * 24634.6345) % 1;
    const size = 5 + Math.round(r2 * 5);
    out.push({
      color: k === 0 ? own : AGENT_COLORS[(seed * 3 + k * 2) % AGENT_COLORS.length],
      size, dur: (1.6 + r * 2.6).toFixed(2), delay: (-(r2 * 4 + k * 0.7)).toFixed(2), dir: k % 2 ? 'agentIn' : 'agentOut',
    });
  }
  return out;
}

const mapNodes = [];
innerOnMap.forEach((p, i) => {
  const deg = -90 + (i * 360) / N;
  const d = nodeAt(R_IN, deg);
  const t = tallPoint(50 + T_IN * Math.cos(rad(deg)), tallCY + T_IN * Math.sin(rad(deg)));
  mapNodes.push({ ring: 'in', item: p, deg, x: d.x, y: d.y, len: R_IN * KX, t, agents: agents(p.color, i, 5) });
});
labOnMap.forEach((p, i) => {
  const deg = -90 + 180 / M + (i * 360) / M;
  const d = nodeAt(R_OUT, deg);
  mapNodes.push({ ring: 'out', item: p, deg, x: d.x, y: d.y, len: R_OUT * KX, t: tallLab(i), agents: agents(labColor(p), i + 7, 3) });
});

// Doodles live on a wide ellipse around the rings (desktop only). Each one searches outward
// from its preferred angle for a spot that doesn't cover a node, a pill or another doodle.
// Sizes below are measured from the rendered page at the 1176 px reference width.
const px = (pt) => ({ x: (pt.x * W) / 100, y: (pt.y * H) / 100 });
const onEllipse = (deg) => ({ x: 50 + 45 * Math.cos(rad(deg)), y: 50 + 44 * Math.sin(rad(deg)) });
const shapes = []; // { circle: {x,y,r} } or { box: {x,y,hw,hh} }
const pillBox = (n) => {
  const p = n.item, c = px(n);
  const nameW = p.name.length * 9.5, statusW = `Lab · ${statusLabel(p)}`.length * 7;
  const w = Math.min(153, Math.max(Math.min(nameW, 117), statusW) + 36);
  return { x: c.x, y: c.y, hw: w / 2, hh: nameW > 117 ? 35 : 27 };
};
for (const n of mapNodes) {
  const c = px(n);
  if (n.ring === 'in') shapes.push({ circle: { x: c.x, y: c.y, r: (innerSize * W) / 200 } });
  else shapes.push({ box: pillBox(n) });
}
shapes.push({ box: { x: W / 2, y: H / 2, hw: 70, hh: 126 } }); // the portrait
// A doodle is an icon (about 46 px) with its pencil label underneath.
const doodleBoxes = (c, label) => label
  ? [{ x: c.x, y: c.y - 12, hw: 23, hh: 23 }, { x: c.x, y: c.y + 23, hw: label.length * 3.1 + 4, hh: 12 }]
  : [{ x: c.x, y: c.y, hw: 25, hh: 25 }];
const boxHitsBox = (a, b, pad = 4) => Math.abs(a.x - b.x) < a.hw + b.hw + pad && Math.abs(a.y - b.y) < a.hh + b.hh + pad;
const boxHitsCircle = (a, c, pad = 2) => Math.hypot(Math.max(Math.abs(c.x - a.x) - a.hw, 0), Math.max(Math.abs(c.y - a.y) - a.hh, 0)) < c.r + pad;
const inBounds = (b) => b.x - b.hw >= 4 && b.x + b.hw <= W - 4 && b.y - b.hh >= 0 && b.y + b.hh <= H;
const fits = (bs) => bs.every(inBounds) && !bs.some((b) => shapes.some((s) => (s.circle ? boxHitsCircle(b, s.circle) : boxHitsBox(b, s.box))));
const centerOf = (s) => s.circle || s.box;

const doodles = [];
function placeDoodle(spec, preferDeg, origin) {
  let spot = null;
  if (preferDeg != null) {
    for (let step = 0; step <= 120 && !spot; step++) {
      for (const sgn of step ? [1, -1] : [1]) {
        const deg = preferDeg + sgn * step;
        const c = px(onEllipse(deg)), bs = doodleBoxes(c, spec.label);
        if (fits(bs)) { spot = { deg, c, bs }; break; }
      }
    }
  } else {
    let best = -1;
    for (let deg = 0; deg < 360; deg += 2) {
      const c = px(onEllipse(deg)), bs = doodleBoxes(c, spec.label);
      if (!fits(bs)) continue;
      const clearance = Math.min(...shapes.map((s) => Math.hypot(centerOf(s).x - c.x, centerOf(s).y - c.y)));
      if (clearance > best) { best = clearance; spot = { deg, c, bs }; }
    }
  }
  if (!spot) return; // no room: it stays off the map (ideas still show in the text below it)
  spot.bs.forEach((b) => shapes.push({ box: b }));
  const q = onEllipse(spot.deg);
  let o = origin;
  if (!o) { // decoration: sketch a line from the nearest lab pill
    const pills = mapNodes.filter((n) => n.ring === 'out');
    const d = (n) => Math.hypot(px(n).x - spot.c.x, px(n).y - spot.c.y);
    o = pills.length ? pills.reduce((m, n) => (d(n) < d(m) ? n : m)) : null;
  }
  let line = null;
  if (o) {
    const A = px(o), B = spot.c;
    line = { x: f2(o.x), y: f2(o.y), len: f2(Math.hypot(B.x - A.x, B.y - A.y) / (W / 100)), deg: f2((Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI) };
  }
  const i = doodles.length;
  doodles.push({ ...spec, x: f2(q.x), y: f2(q.y), line, rot: [-8, 6, -4, 9, -10, 5][i % 6], dur: 5 + (i % 4), delay: -(i * 0.9).toFixed(1) });
}
const JITTER = [8, -6, 8, -8, 6];
(hub.ideas || []).forEach((idea, i) => {
  const near = mapNodes.find((n) => n.item.id === idea.near);
  placeDoodle({ mark: idea.mark || 'bulb', label: idea.label, idea: true }, near ? near.deg + JITTER[i % JITTER.length] : null, near || null);
});
(hub.doodles || []).forEach((d) => placeDoodle({ mark: d.mark, label: d.label || '' }, null, null));

// ---------------------------------------------------------------- render: page
const MARKS = {
  bulb: '<path d="M24 8c-8 0-12.5 5.8-12.5 12 0 4.6 2.6 7.4 4.7 9.6 1.4 1.5 2.3 3 2.3 5v1.4h11v-1.4c0-2 .9-3.5 2.3-5 2.1-2.2 4.7-5 4.7-9.6C36.5 13.8 32 8 24 8z"/><path d="M19.5 39.5h9M21 43h6M24 2v3M11 7l2 2M37 7l-2 2M21 26c1.5-2 4.5-2 6 0"/>',
  question: '<path d="M15.5 16c0-5.4 4-9 9-9s8.8 3.4 8.8 8c0 4.6-4.1 6.2-6.5 8.2-1.9 1.6-2.6 3.2-2.6 6.4"/><path d="M24.2 37.5l.3.3"/>',
  arrow: '<path d="M6 36c8-1 13-7 17-14s9-12 18-12"/><path d="M33 5.5l8.5 4.5-5 7.5"/>',
  spark: '<path d="M24 7v11M24 30v11M7 24h11M30 24h11M13 13l5 5M30 30l5 5M35 13l-5 5M18 30l-5 5"/>',
  squiggle: '<path d="M4 28c4-8 8 8 12 0s8 8 12 0 8 8 12 0"/><path d="M8 38c10-3 22-3 32 0"/>',
};
const ICON = {
  mail: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  phone: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
};

const allItems = [...hub.projects.map((p) => ({ ...p, kind: 'Project' })), ...hub.lab.map((p) => ({ ...p, kind: 'Experiment' }))];
const nowMe = nowForMe();
const tel = C.agentPhone ? `tel:${C.agentPhone.replace(/[^\d+]/g, '')}` : null;
const talk = P.talk;
const portraitDims = pngSize(join(ROOT, 'static', P.portrait));

function nodeHtml(n) {
  const p = n.item;
  const vars = `--x:${f2(n.x)}%;--y:${f2(n.y)}%;--tx:${f2(n.t.x)}%;--ty:${f2(n.t.y)}%`;
  if (n.ring === 'in') {
    return `<a class="node node-in" href="#${p.id}" data-open style="${vars};--nb:${p.color};--nf:${p.text || '#FFF8EA'}" aria-label="${esc(p.name)}, project. Open details."><span class="n-name">${esc(p.name)}</span><span class="n-tag">${esc(p.tag)}</span></a>`;
  }
  return `<a class="node node-out${p.status === 'completed' ? ' done' : ''}" href="#${p.id}" data-open style="${vars};--c:${labColor(p)}" aria-label="${esc(p.name)}, experiment, ${esc(statusLabel(p))}. Open details."><span class="n-name">${esc(p.name)}</span><span class="n-status">Lab · ${esc(statusLabel(p))}</span></a>`;
}

function spokeHtml(n) {
  const ag = n.agents.map((g) => `<span class="agent" style="--s:${g.size}px;background:${g.color};animation:${g.dir} ${g.dur}s linear ${g.delay}s infinite"></span>`).join('');
  return `<span class="spoke${n.ring === 'out' ? ' spoke-lab' : ''}" aria-hidden="true" style="--len:${f2(n.len)}%;--deg:${f2(n.deg)}deg;--tlen:${f2(n.t.len)}%;--tdeg:${f2(n.t.deg)}deg">${ag}</span>`;
}

function doodleHtml(d) {
  const line = d.line ? `<span class="sketch" aria-hidden="true" style="left:${d.line.x}%;top:${d.line.y}%;width:${d.line.len}%;transform:rotate(${d.line.deg}deg)"></span>` : '';
  const label = d.label ? `<span class="d-label">${esc(d.label)}</span>` : '';
  return `${line}<span class="doodle${d.label ? '' : ' faint'}" aria-hidden="true" style="left:${d.x}%;top:${d.y}%;transform:translate(-50%,-50%) rotate(${d.rot}deg)"><span class="wobble" style="animation-duration:${d.dur}s;animation-delay:${d.delay}s"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${MARKS[d.mark] || MARKS.bulb}</svg>${label}</span></span>`;
}

function panelHtml({ id, kind, status, color, name, desc, now, links, isMe }) {
  const img = isMe ? `<img class="p-img" src="${esc(P.portraitWeb)}" alt="" width="165" height="300" loading="lazy" decoding="async">` : '';
  const ls = links.map((l, i) => `<a class="p-link${i === 0 ? ' primary' : ''}" href="${esc(l.url)}">${esc(l.label)} →</a>`).join('');
  return `<article class="panel" id="${id}" aria-labelledby="${id}-h" style="--c:${color}">
  <div class="panel-bar" aria-hidden="true"></div>
  <div class="panel-body">
    <a class="back" href="#map">← Back to the map</a>
    <p class="p-meta"><span>${esc(kind)}</span><span class="p-status">${esc(status)}</span></p>
    ${img}<h2 id="${id}-h" tabindex="-1">${esc(name)}</h2>
    <p class="p-desc">${esc(desc)}</p>
    <div class="p-now"><p class="eyebrow">Right now</p><p>${now.html}</p></div>
    <div class="p-links">${ls}</div>
  </div>
</article>`;
}

function rowHtml(p, lab) {
  const status = lab ? ` <span class="r-status">· ${esc(statusLabel(p))}</span>` : '';
  const dot = lab ? `<span class="dot dot-lab" style="border-color:${labColor(p)}" aria-hidden="true"></span>` : `<span class="dot" style="background:${p.color}" aria-hidden="true"></span>`;
  return `<li><a class="row${p.status === 'completed' ? ' done' : ''}" href="${esc(p.url)}">${dot}<span><span class="r-name">${esc(p.name)}${status}</span><span class="r-line">${esc(p.line)}</span></span></a></li>`;
}

const reachButtons = [
  `<a class="btn btn-mail" href="mailto:${esc(C.email)}">${ICON.mail}${esc(C.email)}</a>`,
  `<a class="btn btn-li" href="${esc(C.linkedin)}"><span aria-hidden="true" class="glyph">in</span>Message on LinkedIn</a>`,
  `<a class="btn btn-x" href="${esc(C.x)}"><span aria-hidden="true" class="glyph">X</span>DM ${esc(C.xHandle)}</a>`,
  tel ? `<a class="btn btn-call" href="${tel}">${ICON.phone}Call my AI assistant ${esc(C.agentPhone)}</a>` : '',
].join('\n        ');

const panels = [
  panelHtml({ id: 'sat', kind: 'The center', status: P.location.split(',')[0], color: '#F2C15A', name: P.name, desc: P.about, now: nowMe, links: P.links, isMe: true }),
  ...allItems.map((p) => panelHtml({
    id: p.id, kind: p.kind, status: p.kind === 'Project' ? p.status : statusLabel(p),
    color: p.kind === 'Project' ? p.color : labColor(p), name: p.name, desc: p.desc, now: nowFor(p), links: p.links,
  })),
].join('\n');

const ideasLine = (hub.ideas || []).length
  ? `<p class="ideas"><span class="ideas-k">Penciled in, not started:</span> ${hub.ideas.map((i) => esc(i.label)).join(' · ')}</p>` : '';

const jsonLd = buildJsonLd();
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Generated by scripts/build.mjs from content/hub.json on ${TODAY}. Edit hub.json, not this file. -->
<title>${esc(hub.site.title)}</title>
<meta name="description" content="${esc(hub.site.description)}">
<link rel="canonical" href="${SITE}/">
<link rel="alternate" type="text/plain" href="/llms.txt" title="LLM-readable summary">
<meta name="robots" content="index, follow">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#FCEFD9">
<meta property="og:type" content="profile">
<meta property="og:url" content="${SITE}/">
<meta property="og:title" content="${esc(hub.site.title)}">
<meta property="og:description" content="${esc(hub.site.description)}">
<meta property="og:image" content="${SITE}${esc(P.portrait)}">
<meta property="og:image:alt" content="${esc(P.portraitAlt)}">
<meta property="og:site_name" content="aicv.co">
<meta name="twitter:card" content="summary">
<meta name="twitter:site" content="${esc(C.xHandle)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&amp;family=Caveat:wght@500;700&amp;display=swap" rel="stylesheet">
<script type="application/ld+json">
${jsonLd}
</script>
<style>
${CSS()}
</style>
</head>
<body>
<main>
  <section class="wrap hero">
    <h1><span class="name">${esc(P.name)}.</span><span>Start here.</span><span>Go anywhere.</span></h1>
    <p>${esc(P.intro)}</p>
  </section>

  <section class="wrap reach" aria-label="Contact">
    <div class="reach-in">
      <span class="eyebrow">Reach me</span>
      <span class="btns">
        ${reachButtons}
      </span>
    </div>
  </section>

  <section class="wrap map-sec" id="map" aria-label="Map of projects and experiments">
    <div class="map-frame">
      <div class="map" style="--isz:${f2(innerSize)};--tisz:${f2(tallInnerSize)};--th:${f2(tallH)};--tcy:${f2((tallCY / tallH) * 100)}%">
        <span class="ring ring-in" aria-hidden="true"></span>
        <span class="ring ring-out" aria-hidden="true"></span>
        <svg width="0" height="0" aria-hidden="true" style="position:absolute"><filter id="pencil"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4"/><feDisplacementMap in="SourceGraphic" scale="2.2"/></filter></svg>
        ${mapNodes.map(spokeHtml).join('\n        ')}
        ${mapNodes.map(nodeHtml).join('\n        ')}
        ${doodles.map(doodleHtml).join('\n        ')}
        <a class="hub-figure" href="#sat" data-open><img src="${esc(P.portraitWeb)}" alt="${esc(P.portraitAlt)}" width="480" height="873" fetchpriority="high"></a>
      </div>
${panels}
    </div>
    <p class="legend">
      <span><span class="lg-dot" aria-hidden="true"></span>Projects</span>
      <span><span class="lg-pill" aria-hidden="true"></span>Experiments</span>
      <span><span class="lg-agent" aria-hidden="true"></span>Agents at work</span>
      <span><svg width="16" height="16" viewBox="0 0 48 48" fill="none" stroke="#8A7058" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M24 8c-8 0-12.5 5.8-12.5 12 0 4.6 2.6 7.4 4.7 9.6 1.4 1.5 2.3 3 2.3 5v1.4h11v-1.4c0-2 .9-3.5 2.3-5 2.1-2.2 4.7-5 4.7-9.6C36.5 13.8 32 8 24 8zM19.5 39.5h9"/></svg>Penciled-in ideas</span>
    </p>
    ${ideasLine}
  </section>

  <section class="wrap dest" aria-labelledby="dest-h">
    <h2 id="dest-h">Every destination</h2>
    <div class="dest-grid">
      <div>
        <p class="eyebrow">Projects</p>
        <ul>
          ${hub.projects.map((p) => rowHtml(p, false)).join('\n          ')}
        </ul>
      </div>
      <div>
        <p class="eyebrow">The lab</p>
        <ul>
          ${hub.lab.map((p) => rowHtml(p, true)).join('\n          ')}
        </ul>
      </div>
    </div>
  </section>

  <section class="wrap talk" aria-label="TEDx talk">
    <div class="talk-in">
      <div class="yt-box">
        <a class="yt" href="https://youtu.be/${esc(talk.youtubeId)}" data-yt="${esc(talk.youtubeId)}" aria-label="Play the ${esc(talk.event)} talk, ${esc(talk.title)}">
          <span class="yt-stripes" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
          <span class="yt-play" aria-hidden="true"><svg width="30" height="34" viewBox="0 0 30 34"><path d="M4 3 L27 17 L4 31 Z" fill="#2B1A10"/></svg></span>
          <span class="yt-event">${esc(talk.event)}</span>
        </a>
      </div>
      <div class="talk-copy">
        <p class="eyebrow">The talk</p>
        <h2>${esc(talk.title)}</h2>
        <p>${esc(talk.summary)}</p>
        <a class="talk-btn" href="https://youtu.be/${esc(talk.youtubeId)}">Watch on YouTube →</a>
      </div>
    </div>
  </section>

  <section class="wrap short" aria-labelledby="short-h">
    <div class="short-in">
      <h2 id="short-h" class="eyebrow">The short version</h2>
      <p>${esc(P.shortVersion)}</p>
    </div>
  </section>
</main>

<footer class="wrap foot">
  <span class="foot-line">${esc(hub.site.footerLine)}</span>
  <span class="wordmark">aicv<span>.co</span></span>
  <span class="foot-links"><a href="mailto:${esc(C.email)}">${esc(C.email)}</a>${tel ? `<a href="${tel}">AI assistant ${esc(C.agentPhone)}</a>` : ''}<a href="${esc(C.linkedin)}">LinkedIn</a><a href="${esc(C.x)}">${esc(C.xHandle)}</a><a href="/llms.txt">llms.txt</a></span>
</footer>

<script>
${JS()}
</script>
</body>
</html>
`;

// ---------------------------------------------------------------- render: llms.txt
function buildLlms() {
  const L = [];
  L.push(`# aicv.co — ${P.name}`, '', `> ${P.llmsSummary}`, '', `Last updated: ${TODAY}`, '');
  L.push('## Who This Is', '', `**${P.name}**: ${P.llmsWho}`);
  L.push(`- Email: ${C.email}`, `- LinkedIn: ${C.linkedin}`, `- X: ${C.x} (${C.xHandle})`);
  if (C.agentPhone) L.push(`- AI assistant phone line: ${C.agentPhone} (an AI assistant answers, takes a message and passes it to Sat)`);
  L.push(`- For AI training, agent readiness, speaking, or partnerships, contact ${C.email}.`, `- Right now: ${nowMe.text}`, '');
  L.push('## Projects', '');
  for (const p of hub.projects) {
    L.push(`### ${p.llmsHeading || `${p.name}: ${hostPath(p.url)}`}`, p.llms || p.desc, `- Website: ${p.url}`, `- Right now: ${nowFor(p).text}`);
    for (const l of p.forAgents || []) L.push(`- ${l.label}: ${l.url}`);
    L.push('');
  }
  L.push('## Experiments', '');
  for (const p of hub.lab) L.push(`- ${p.name} (${statusLabel(p)}): ${p.line}${/[.?!]$/.test(p.line) ? '' : '.'} ${p.url.startsWith('mailto:') ? `Ask: ${p.url.slice(7)}` : p.url}`);
  if ((hub.ideas || []).length) L.push(`- Ideas in progress: ${hub.ideas.map((i) => i.llms || i.label).join(', ')}`);
  L.push('');
  if (upcoming.length) {
    L.push('## Upcoming Events', '');
    for (const e of upcoming) {
      const proj = allItems.find((x) => x.id === e.project);
      L.push(`- ${longDate(e.date)}: ${e.title}, ${e.place.replace(/^the /, '')}${proj ? ` (${proj.name})` : ''}.${e.free ? ' Free.' : ''}${e.url ? ` ${e.url}` : ''}`);
    }
    L.push('');
  }
  L.push('## Talk', '', `- ${talk.event}, "${talk.title.replace(/[“”]/g, "'")}": https://youtu.be/${talk.youtubeId}`, '');
  L.push('## Entities', '', hub.site.entities, '');
  L.push(`## ${numberWord(hub.site.cities.length)} Cities Served`, '', hub.site.cities.join(' · '), '');
  L.push(hub.site.footerLine, '');
  return L.join('\n');
}

// ---------------------------------------------------------------- render: JSON-LD
function buildJsonLd() {
  const sat = `${SITE}/#sat`;
  const video = `https://youtu.be/${talk.youtubeId}#video`;
  const person = {
    '@type': 'Person',
    '@id': sat,
    name: P.name,
    url: SITE,
    image: { '@type': 'ImageObject', url: `${SITE}${P.portrait}`, width: portraitDims.w, height: portraitDims.h, caption: P.portraitAlt },
    jobTitle: P.jobTitle,
    description: P.summary,
    homeLocation: { '@type': 'Place', name: P.location },
    knowsAbout: P.knowsAbout,
    email: `mailto:${C.email}`,
    ...(C.agentPhone ? { telephone: C.agentPhone } : {}),
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'AI training, agent readiness, speaking, and partnerships',
      email: C.email,
      areaServed: P.areaServed,
      ...(C.agentPhone ? { telephone: C.agentPhone, description: 'The phone line is answered by an AI assistant that takes a message for Sat.' } : {}),
    },
    sameAs: P.sameAs,
    memberOf: { '@type': 'OrganizationRole', roleName: 'Co-organizer', memberOf: { '@type': 'Organization', name: P.coOrganizes.name, url: P.coOrganizes.url } },
    subjectOf: { '@id': video },
  };
  const orgs = hub.site.organizations.map((o) => ({
    '@type': 'Organization', '@id': o.id, name: o.name, ...(o.alternateName ? { alternateName: o.alternateName } : {}),
    url: o.url, description: o.description, founder: { '@id': sat },
  }));
  const videoNode = {
    '@type': 'VideoObject', '@id': video, name: talk.videoName || talk.title, url: `https://youtu.be/${talk.youtubeId}`,
    embedUrl: `https://www.youtube.com/embed/${talk.youtubeId}`, uploadDate: talk.uploadDate,
    thumbnailUrl: `https://i.ytimg.com/vi/${talk.youtubeId}/hqdefault.jpg`, description: talk.summary, creator: { '@id': sat },
  };
  const website = { '@type': 'WebSite', '@id': `${SITE}/#website`, url: `${SITE}/`, name: 'aicv.co', publisher: { '@id': sat } };
  const profile = {
    '@type': 'ProfilePage', '@id': `${SITE}/#page`, url: `${SITE}/`, name: hub.site.title, description: hub.site.description,
    isPartOf: { '@id': `${SITE}/#website` }, mainEntity: { '@id': sat }, dateModified: TODAY,
  };
  const doc = { '@context': 'https://schema.org', '@graph': [person, ...orgs, videoNode, website, profile] };
  return JSON.stringify(doc, null, 2).replace(/</g, '\\u003c');
}

// ---------------------------------------------------------------- write dist/
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(join(ROOT, 'static'), DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), page);
writeFileSync(join(DIST, 'llms.txt'), buildLlms());
writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}/</loc><lastmod>${TODAY}</lastmod></url>
  <url><loc>${SITE}/llms.txt</loc><lastmod>${TODAY}</lastmod></url>
</urlset>
`);
writeFileSync(join(DIST, 'now.json'), JSON.stringify({ builtOn: TODAY, feeds, upcomingEvents: upcoming }, null, 2) + '\n');

const offMap = [...hub.projects.slice(INNER_CAP), ...hub.lab.slice(LAB_CAP)].map((p) => p.name);
const missing = [...(hub.ideas || []), ...(hub.doodles || [])].length - doodles.length;
console.log(`built dist/ for ${TODAY}: ${N} projects + ${M} lab items on the map, ${doodles.length} doodles, ${upcoming.length} upcoming event(s)` +
  (droppedEvents ? `, ${droppedEvents} past event(s) dropped` : '') +
  (offMap.length ? `; list only (map is full): ${offMap.join(', ')}` : '') +
  (missing ? `; ${missing} doodle(s) had no room on the map` : ''));
for (const p of hub.projects.filter((x) => x.feed)) {
  console.log(`  ${p.name} right now: ${feeds[p.id] ? `“${feeds[p.id].title}”` : `(no feed value; using hub.json "now")`}`);
}

try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/check-entity.mjs')], { stdio: 'inherit' });
} catch {
  process.exit(1);
}

// ================================================================= helpers
function fail(msg) {
  console.error(`\nBUILD STOPPED — ${msg}\n`);
  process.exit(1);
}

function validate(h) {
  const errs = [];
  const need = (obj, keys, where) => keys.forEach((k) => { if (obj?.[k] == null || obj[k] === '') errs.push(`${where} is missing "${k}"`); });
  need(h, ['site', 'person', 'projects', 'lab'], 'hub.json');
  if (errs.length) fail(errs.join('\n  '));
  need(h.site, ['url', 'title', 'description', 'footerLine', 'entities', 'cities', 'organizations'], 'site');
  need(h.person, ['name', 'jobTitle', 'location', 'summary', 'intro', 'about', 'now', 'shortVersion', 'llmsSummary', 'llmsWho', 'portrait', 'portraitWeb', 'portraitAlt', 'contact', 'talk', 'links', 'coOrganizes'], 'person');
  need(h.person?.contact, ['email', 'linkedin', 'x', 'xHandle'], 'person.contact');
  const seen = new Set(['map', 'sat', 'dest-h', 'short-h', 'pencil']);
  const hex = /^#[0-9a-fA-F]{6}$/;
  h.projects.forEach((p, i) => {
    const w = `projects[${i}]${p?.id ? ` ("${p.id}")` : ''}`;
    need(p, ['id', 'name', 'tag', 'status', 'color', 'url', 'line', 'desc', 'now', 'links'], w);
    if (p.color && !hex.test(p.color)) errs.push(`${w}: color must look like #A8401E`);
    if (p.text && !hex.test(p.text)) errs.push(`${w}: text color must look like #FFF8EA`);
  });
  h.lab.forEach((p, i) => {
    const w = `lab[${i}]${p?.id ? ` ("${p.id}")` : ''}`;
    need(p, ['id', 'name', 'status', 'url', 'line', 'desc', 'now', 'links'], w);
    if (p.status && !STATUS_LABEL[p.status]) errs.push(`${w}: status must be one of ${Object.keys(STATUS_LABEL).join(', ')} (use "statusLabel" for custom wording)`);
    if (p.color && !hex.test(p.color)) errs.push(`${w}: color must look like #C9502A`);
  });
  for (const p of [...h.projects, ...h.lab]) {
    if (!p.id) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) errs.push(`id "${p.id}" must be lowercase letters, digits and dashes`);
    if (seen.has(p.id)) errs.push(`id "${p.id}" is used twice (or is reserved)`);
    seen.add(p.id);
    if (!Array.isArray(p.links) || !p.links.length) errs.push(`"${p.id}" needs at least one link`);
  }
  const ids = new Set([...h.projects, ...h.lab].map((p) => p.id));
  (h.ideas || []).forEach((d, i) => {
    need(d, ['label'], `ideas[${i}]`);
    if (d.near && !ids.has(d.near)) errs.push(`ideas[${i}] ("${d.label}"): near "${d.near}" is not a project or lab id`);
  });
  (h.events || []).forEach((e, i) => {
    const w = `events[${i}]${e?.title ? ` ("${e.title}")` : ''}`;
    need(e, ['title', 'date', 'place', 'project'], w);
    if (e.date && !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) errs.push(`${w}: date must look like 2026-12-05`);
    if (e.project && !ids.has(e.project)) errs.push(`${w}: project "${e.project}" is not a project or lab id`);
  });
  if (h.person?.contact?.agentPhone && !/\d{7,}/.test(h.person.contact.agentPhone.replace(/\D/g, ''))) errs.push('person.contact.agentPhone must be a phone number, or null to hide the button');
  if (errs.length) fail(`content/hub.json needs a fix:\n  ${errs.join('\n  ')}`);
}

function labColor(p) { return p.color || '#C9502A'; }
function statusLabel(p) { return p.statusLabel || STATUS_LABEL[p.status] || p.status; }
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function shortDate(iso) { const [, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1].slice(0, 3)} ${d}`; }
function longDate(iso) { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; }
function hostPath(u) { return u.replace(/^mailto:/, '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }
function numberWord(n) { return ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'][n] || String(n); }
function pngSize(file) {
  try { const b = readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; } catch { return { w: undefined, h: undefined }; }
}

function decodeXml(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'aicv.co-build (+https://aicv.co)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

async function latestFromFeed(url) {
  if (OFFLINE) return null;
  try {
    const xml = await fetchText(url);
    const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => {
      const get = (tag) => {
        const x = m[0].match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return x ? decodeXml(x[1].trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')).trim() : '';
      };
      const t = Date.parse(get('pubDate'));
      return { title: get('title').replace(/\s+/g, ' '), url: get('link'), date: Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10), t: Number.isNaN(t) ? 0 : t };
    }).filter((i) => i.title && /^https:\/\//.test(i.url));
    if (!items.length) throw new Error('no items');
    items.sort((a, b) => b.t - a.t);
    const { title, url: link, date } = items[0];
    return { title, url: link, date };
  } catch (e) {
    console.warn(`feed ${url} failed (${e.message}); keeping the last good value`);
    return null;
  }
}

async function readLastGood() {
  if (OFFLINE) return null;
  try { return JSON.parse(await fetchText(`${hub.site.url.replace(/\/$/, '')}/now.json`)); } catch { return null; }
}

// ================================================================= CSS + JS
// (CSS and JS are appended below)
function CSS() {
  return `:root{--bg:#FCEFD9;--ink:#2B1A10;--card:#FFF8EA;--line:#E9CFA3;--accent:#A8401E;--brown:#7A3418;--dim:#6B5440;--body:#4A3826;--body2:#3E2F20;--body3:#5A4632;--sun:#F2C15A}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:'Archivo',system-ui,-apple-system,'Segoe UI',sans-serif}
a{color:var(--brown)}a:hover{color:#4E200E}
a:focus-visible,h2:focus-visible{outline:3px solid var(--ink);outline-offset:3px;border-radius:8px}
h2:focus{outline:none}
.wrap{max-width:1240px;margin:0 auto;padding-left:32px;padding-right:32px}
.eyebrow{margin:0;font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.hero{padding-top:72px;display:flex;flex-wrap:wrap;gap:20px 64px;align-items:flex-end}
.hero h1{flex:1 1 560px;min-width:0;margin:0;font-weight:900;font-stretch:125%;font-size:clamp(32px,4.8vw,68px);line-height:.98;letter-spacing:-.025em}
.hero h1 span{display:block;white-space:nowrap}
.hero h1 .name{color:var(--accent)}
.hero p{flex:1 1 440px;max-width:520px;margin:0 0 0 auto;text-align:right;font-size:18px;line-height:1.6;color:var(--body)}
.reach{padding-top:44px}
.reach-in{display:flex;flex-wrap:wrap;gap:14px 20px;align-items:center;background:var(--card);border:1.5px solid var(--line);border-radius:24px;padding:14px 16px 14px 28px}
.btns{display:flex;flex-wrap:wrap;gap:10px}
.btn{display:inline-flex;align-items:center;gap:10px;min-height:48px;padding:0 20px;border-radius:999px;font-weight:800;font-size:15px;text-decoration:none}
.btn .glyph{font-weight:900;font-size:15px}
.btn-mail,.btn-mail:hover{background:var(--sun);color:var(--ink)}
.btn-li,.btn-li:hover{background:#0A66C2;color:#fff}
.btn-x,.btn-x:hover{background:#000;color:#fff}
.btn-call,.btn-call:hover{background:transparent;color:var(--ink);border:2px dashed var(--accent)}
.btn:hover{filter:brightness(1.06)}
.map-sec{padding-top:40px;scroll-margin-top:8px}
.map-frame{position:relative;max-width:1176px;margin:0 auto}
.map{position:relative;width:100%;aspect-ratio:3/2;container-type:inline-size}
.ring{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border-radius:50%;pointer-events:none}
.ring-in{width:42.86%;height:64.29%;border:1.5px solid var(--line)}
.ring-out{width:62.76%;height:94.14%;border:1.5px dashed #E2BE86}
.spoke{position:absolute;left:50%;top:50%;height:2px;margin-top:-1px;transform-origin:0 50%;width:var(--len);transform:rotate(var(--deg));background:#D9B98A;pointer-events:none}
.spoke-lab{background:repeating-linear-gradient(90deg,#D9B98A 0 6px,transparent 6px 12px)}
.agent{position:absolute;border-radius:50%;width:var(--s);height:var(--s);top:calc(1px - var(--s) / 2);margin-left:calc(var(--s) / -2)}
@keyframes agentOut{0%{left:0;opacity:0}12%{opacity:1}88%{opacity:1}100%{left:100%;opacity:0}}
@keyframes agentIn{0%{left:100%;opacity:0}12%{opacity:1}88%{opacity:1}100%{left:0;opacity:0}}
.node{position:absolute;z-index:2;left:var(--x);top:var(--y);transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;text-decoration:none;transition:transform .18s ease,box-shadow .18s ease,opacity .18s ease}
.node:hover{transform:translate(-50%,-50%) scale(1.06);box-shadow:0 12px 26px rgba(60,35,10,.22)}
.node-in{width:calc(var(--isz) * 1cqw);height:calc(var(--isz) * 1cqw);border-radius:50%;border:3px solid var(--bg);background:var(--nb);color:var(--nf);gap:calc(var(--isz) * .0354cqw);padding:calc(var(--isz) * .0884cqw)}
.node-in:hover{color:var(--nf)}
.node-in .n-name{font-weight:900;font-stretch:110%;font-size:calc(var(--isz) * .1237cqw);line-height:1.05}
.node-in .n-tag{font-weight:600;font-size:calc(var(--isz) * .0792cqw);letter-spacing:.08em;text-transform:uppercase;opacity:.9}
.node-out{max-width:13.01cqw;min-height:44px;padding:.77cqw 1.38cqw;border-radius:999px;background:var(--card);border:2px dashed var(--c);color:var(--ink);gap:.23cqw}
.node-out:hover{color:var(--ink)}
.node-out .n-name{font-weight:800;font-size:1.3cqw;line-height:1.1}
.node-out .n-status{font-weight:600;font-size:.96cqw;letter-spacing:.08em;text-transform:uppercase;color:var(--dim)}
.node-out.done{opacity:.62}.node-out.done:hover{opacity:.9}
.sketch{position:absolute;height:1.5px;margin-top:-.75px;transform-origin:0 50%;background:repeating-linear-gradient(90deg,#D6C3A0 0 3px,transparent 3px 9px);pointer-events:none}
.doodle{position:absolute;z-index:1;width:9.18cqw;color:#B09878;pointer-events:none;display:flex;justify-content:center}
.doodle.faint{opacity:.55}
.wobble{display:flex;flex-direction:column;align-items:center;gap:.15cqw;animation:wobble 6s ease-in-out infinite}
.wobble svg{display:block;width:3.83cqw;height:3.83cqw;filter:url(#pencil)}
.d-label{font-family:'Caveat',cursive;font-weight:700;font-size:1.45cqw;line-height:1;white-space:nowrap;color:#8A7058}
@keyframes wobble{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(3deg)}}
.hub-figure{position:absolute;z-index:3;left:50%;top:50%;transform:translate(-50%,-50%);width:11.79cqw;height:21.43cqw;display:block;transition:transform .18s ease}
.hub-figure:hover{transform:translate(-50%,-50%) scale(1.03)}
.hub-figure img{display:block;width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 10px 18px rgba(43,26,16,.18))}
.panel{display:none;position:absolute;inset:0;z-index:10;background:var(--card);border-radius:20px;box-shadow:0 30px 70px rgba(60,35,10,.25);overflow:auto;scroll-margin-top:16px}
.panel:target{display:flex}
.panel-bar{flex:0 0 18px;background:var(--c)}
.panel-body{flex:1 1 auto;min-width:0;padding:clamp(24px,5vw,64px);display:flex;flex-direction:column;gap:22px}
.back{align-self:flex-start;display:inline-flex;align-items:center;min-height:44px;padding:0 18px;border-radius:999px;border:1.5px solid var(--ink);font-weight:700;font-size:15px;color:var(--ink);text-decoration:none}
.back:hover{background:var(--bg);color:var(--ink)}
.p-meta{margin:8px 0 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.p-status{padding:4px 10px;border-radius:999px;background:#F6DDB0;color:var(--ink)}
.panel h2{margin:0;font-weight:900;font-stretch:125%;font-size:clamp(32px,6vw,80px);line-height:.95;letter-spacing:-.02em;overflow-wrap:break-word}
.p-img{width:auto;height:300px;max-width:100%;object-fit:contain;align-self:flex-start}
.p-desc{margin:0;max-width:40rem;font-size:20px;line-height:1.6;color:var(--body2)}
.p-now{max-width:40rem;padding:18px 22px;background:var(--bg);border-radius:12px}
.p-now .eyebrow{margin-bottom:6px}
.p-now p:not(.eyebrow){margin:0;font-size:17px;line-height:1.55}
.p-links{display:flex;flex-wrap:wrap;gap:12px;margin-top:4px}
.p-link{display:inline-flex;align-items:center;min-height:48px;padding:0 22px;border-radius:999px;font-weight:800;font-size:15px;text-decoration:none;border:2px solid var(--ink);color:var(--ink)}
.p-link:hover{background:var(--bg);color:var(--ink)}
.p-link.primary,.p-link.primary:hover{background:var(--ink);color:#FFF6E6}
.legend{margin:24px auto 0;max-width:1176px;display:flex;flex-wrap:wrap;justify-content:center;gap:12px 32px;font-size:14px;font-weight:600;color:var(--dim)}
.legend>span{display:flex;align-items:center;gap:8px}
.lg-dot{width:14px;height:14px;border-radius:50%;background:#E98A3B}
.lg-pill{width:22px;height:14px;border-radius:999px;border:2px dashed #C9502A}
.lg-agent{width:8px;height:8px;border-radius:50%;background:var(--ink)}
.ideas{margin:12px auto 0;max-width:1176px;text-align:center;font-family:'Caveat',cursive;font-weight:700;font-size:21px;line-height:1.3;color:#8A7058}
.ideas-k{font-family:'Archivo',system-ui,sans-serif;font-weight:600;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin-right:6px}
.dest{padding-top:104px}
.dest h2{margin:0 0 28px;font-weight:900;font-stretch:125%;font-size:clamp(28px,3vw,40px);letter-spacing:-.01em}
.dest-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr));gap:40px}
.dest-grid .eyebrow{margin-bottom:8px}
.dest ul{list-style:none;margin:0;padding:0}
.row{display:grid;grid-template-columns:14px minmax(0,1fr);gap:16px;align-items:baseline;padding:16px 8px;border-top:1px solid var(--line);text-decoration:none;color:var(--ink)}
.row:hover{background:var(--card);color:var(--ink)}
.row.done{opacity:.72}
.dot{display:inline-block;width:12px;height:12px;border-radius:50%}
.dot-lab{width:10px;height:10px;border:2px dashed}
.r-name{display:block;font-weight:800;font-size:19px}
.r-status{font-weight:600;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.r-line{display:block;margin-top:2px;font-size:15px;color:var(--body3)}
.talk{padding-top:104px}
.talk-in{display:flex;flex-wrap:wrap;gap:32px 48px;align-items:center;background:var(--card);border:1.5px solid var(--line);border-radius:20px;padding:clamp(24px,4vw,44px)}
.yt-box{flex:1 1 360px;max-width:520px;aspect-ratio:16/9;border-radius:16px;overflow:hidden;background:var(--ink)}
.yt{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;text-decoration:none}
.yt-stripes{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column}
.yt-stripes span{height:8px}
.yt-stripes span:nth-child(1){background:#F2C15A}.yt-stripes span:nth-child(2){background:#E98A3B}.yt-stripes span:nth-child(3){background:#C9502A}.yt-stripes span:nth-child(4){background:#4DA3FF}
.yt-play{width:84px;height:84px;border-radius:50%;background:var(--sun);display:flex;align-items:center;justify-content:center;transition:transform .18s ease}
.yt:hover .yt-play{transform:scale(1.06)}
.yt-event{position:absolute;left:20px;top:16px;font-weight:800;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--bg)}
.yt-box iframe{display:block;width:100%;height:100%;border:0}
.talk-copy{flex:999 1 380px;min-width:0;display:flex;flex-direction:column;gap:14px}
.talk-copy h2{margin:0;font-weight:900;font-stretch:125%;font-size:clamp(28px,3.2vw,44px);line-height:1.02;letter-spacing:-.015em}
.talk-copy p:not(.eyebrow){margin:0;max-width:36rem;font-size:18px;line-height:1.6;color:var(--body)}
.talk-btn{align-self:flex-start;margin-top:6px;display:inline-flex;align-items:center;min-height:48px;padding:0 22px;border-radius:999px;background:var(--ink);color:var(--card);font-weight:800;font-size:15px;text-decoration:none}
.talk-btn:hover{color:var(--card);background:#4E200E}
.short{padding-top:88px}
.short-in{border-top:1.5px solid var(--line);padding-top:32px;display:flex;flex-wrap:wrap;gap:16px 48px}
.short-in h2{flex:0 0 220px}
.short-in p{flex:1 1 520px;min-width:0;max-width:46rem;margin:0;font-size:17px;line-height:1.65;color:var(--body2)}
.foot{margin-top:88px;padding-top:26px;padding-bottom:40px;border-top:1.5px solid var(--line);display:flex;flex-wrap:wrap;gap:16px 32px;align-items:center;font-size:14px;color:var(--dim)}
.foot-line{flex:1 1 260px}
.wordmark{flex:0 0 auto;font-weight:900;font-stretch:125%;font-size:22px;line-height:1;letter-spacing:-.03em;color:var(--ink)}
.wordmark span{color:var(--accent)}
.foot-links{flex:1 1 260px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px 24px}
.foot-links a{display:inline-flex;align-items:center;min-height:32px}
@media (max-width:1127px){.hero p{text-align:left;margin-left:0;max-width:640px}}
@media (max-width:999px){
.map-frame{max-width:600px}
.map{aspect-ratio:100 / var(--th)}
.ring{top:var(--tcy)}
.ring-in{width:66cqw;height:66cqw}
.ring-out{display:none}
.spoke{top:var(--tcy);width:var(--tlen);transform:rotate(var(--tdeg))}
.node{left:var(--tx);top:var(--ty)}
.node-in{width:calc(var(--tisz) * 1cqw);height:calc(var(--tisz) * 1cqw);padding:calc(var(--tisz) * .06cqw);gap:.6cqw}
.node-in .n-name{font-size:calc(var(--tisz) * .125cqw);font-stretch:88%}
.node-in .n-tag{font-size:calc(var(--tisz) * .08cqw)}
.node-out{max-width:31cqw;padding:1.6cqw 2.8cqw;gap:.5cqw}
.node-out .n-name{font-size:3.6cqw}
.node-out .n-status{font-size:2.6cqw}
.sketch,.doodle{display:none}
.hub-figure{top:var(--tcy);width:21cqw;height:38cqw}
.panel{position:fixed;inset:0;z-index:50;border-radius:0}
.panel-open body{overflow:hidden}
}
@media (max-width:600px){
.wrap{padding-left:16px;padding-right:16px}
.hero{padding-top:44px}
.reach-in{padding:14px 16px;border-radius:20px}
.dest,.talk{padding-top:72px}
.short{padding-top:64px}
.foot{margin-top:64px}
.foot-links{justify-content:flex-start}
.p-desc{font-size:18px}
.p-img{height:220px}
}
@media (max-width:520px){.node-in .n-tag{display:none}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.agent{display:none}.wobble{animation:none}.node,.hub-figure,.yt-play{transition:none}}`;
}

function JS() {
  return `(function () {
  var root = document.documentElement, opener = null;
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[data-open]') : null;
    if (a) opener = a;
  });
  function sync() {
    var id = decodeURIComponent(location.hash.slice(1));
    var el = id ? document.getElementById(id) : null;
    var open = !!(el && el.classList.contains('panel'));
    root.classList.toggle('panel-open', open);
    if (open) { var h = el.querySelector('h2'); if (h) h.focus({ preventScroll: true }); }
    else if (opener && id === 'map') { opener.focus({ preventScroll: true }); opener = null; }
  }
  window.addEventListener('hashchange', sync);
  sync();
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && root.classList.contains('panel-open')) location.hash = 'map';
  });
  var yt = document.querySelector('a[data-yt]');
  if (yt) yt.addEventListener('click', function (e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    var f = document.createElement('iframe');
    f.src = 'https://www.youtube-nocookie.com/embed/' + yt.getAttribute('data-yt') + '?autoplay=1&rel=0';
    f.title = yt.getAttribute('aria-label').replace(/^Play the /, '');
    f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    yt.replaceWith(f);
  });
})();`;
}
