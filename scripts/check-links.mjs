#!/usr/bin/env node
/**
 * check-links.mjs — checks every web link the built site points to (dist/index.html and
 * dist/llms.txt). Run it by hand after a build: `node scripts/check-links.mjs`.
 * It is not part of the build, because other sites going down for a minute should never
 * stop aicv.co from deploying. Exit 1 if any link fails.
 *
 * LinkedIn and X refuse automated requests (999 / 403 / 400) even when the page is fine, so
 * those are reported as "not checkable by script" rather than failures.
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('../dist/', import.meta.url).pathname;
const text = readFileSync(ROOT + 'index.html', 'utf8') + '\n' + readFileSync(ROOT + 'llms.txt', 'utf8');
const urls = [...new Set([...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/[.,;:]$/, '').replace(/&amp;/g, '&')))]
  .filter((u) => !/fonts\.(googleapis|gstatic)\.com\/?$|schema\.org|www\.w3\.org|\/embed\//.test(u))
  .filter((u) => !/^https:\/\/aicv\.co(\/|$)/.test(u)) // aicv.co itself: check after deploy
  .sort();
const BOT_WALLED = /linkedin\.com|(^|\/\/)(www\.)?x\.com/;

const results = await Promise.all(urls.map(async (u) => {
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(u, { method, redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (aicv.co link check)' } });
      if (r.ok) return { u, ok: true, status: r.status, final: r.url !== u ? r.url : '' };
      if (method === 'GET') return { u, ok: false, status: r.status };
    } catch (e) {
      if (method === 'GET') return { u, ok: false, status: e.name === 'TimeoutError' ? 'timeout' : e.message };
    }
  }
}));

let bad = 0;
for (const r of results) {
  if (r.ok) console.log(`ok   ${r.status}  ${r.u}${r.final ? `  -> ${r.final}` : ''}`);
  else if (BOT_WALLED.test(r.u)) console.log(`n/a  ${r.status}  ${r.u}  (refuses scripts; open it in a browser)`);
  else { bad++; console.log(`FAIL ${r.status}  ${r.u}`); }
}
console.log(`\n${results.length} links, ${bad} failing`);
process.exit(bad ? 1 : 0);
