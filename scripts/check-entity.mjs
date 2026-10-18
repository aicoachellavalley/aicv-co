#!/usr/bin/env node
/**
 * check-entity.mjs — aicv.co (the hub) must not give nonprofit or fiscal-
 * sponsorship status to AICV as a whole, to aicoachellavalley.com, to
 * SunshineFM, or to the hub. Sponsorship describes aicoachellavalley.org only.
 *
 * The rule is the same one aicoachellavalley.com builds with
 * (homepage repo, scripts/entity-rule.mjs, adopted 2026-10-17), run in STRICT
 * mode: this whole site is about AICV, so a status sentence that names no
 * property is read as being about the hub and must name aicoachellavalley.org.
 * The patterns are copied, not imported (separate repos); if one changes, change
 * both and re-run each repo's controls.
 *
 * SCOPE = every text file this repo serves (the repo root is the site), read
 * the way an agent reads it: tags joined, JSON-LD node by node, attribute text
 * included. A JSON-LD node whose own @id/url is on aicoachellavalley.org is
 * .org-scoped by structure, so .org's self-description passes there.
 *
 * Run: `node scripts/check-entity.mjs` (exit 1 on a violation). It runs on
 * every deploy only if the aicv-co Pages project's build command is set to it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const STATUS = new RegExp([
  String.raw`fiscal(?:ly)?[\s-]+sponsor\w*`,
  String.raw`\b501\s*\(\s*c\s*\)`,
  String.raw`\bNGO\b`,
  String.raw`\b(?:a|an|the|our|its)\s+non-?profit\b`,
  String.raw`\bnon-?profit(?:'s|’s)`,
  String.raw`\bnon-?profit\s+(?:initiative|organi[sz]ation|project|entity|arm|face|side|status|corporation|structure|site|surface|program|programme|org)\b`,
].join('|'), 'i');
const ORG_SCOPE = /aicoachellavalley\.org|\bthe \.org\b/i;
const sentences = (t) => t.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map((s) => s.trim()).filter(Boolean);
const violations = (t) => sentences(t).filter((s) => STATUS.test(s) && !ORG_SCOPE.test(s));

const ROOT = new URL('../', import.meta.url).pathname;
const SKIP = new Set(['.git', 'node_modules', 'scripts']);
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  SKIP.has(e.name) ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const TEXT = new Set(['.html', '.txt', '.xml', '.json', '.md', '']);

/** JSON-LD: every string of every node, except nodes that ARE the .org. */
function ldText(raw) {
  let doc; try { doc = JSON.parse(raw); } catch { return raw; }
  const out = [];
  (function visit(v, scoped) {
    if (typeof v === 'string') { if (!scoped) out.push(v); return; }
    if (Array.isArray(v)) return v.forEach((x) => visit(x, scoped));
    if (v && typeof v === 'object') {
      const isOrg = /^https:\/\/aicoachellavalley\.org(\/|#|$)/.test((v['@id'] || v.url || '').trim()) && !!(v['@type']);
      for (const x of Object.values(v)) visit(x, scoped || isOrg);
    }
  })(doc, false);
  return out.join('\n');
}

const BLOCK = /^(?:p|li|h[1-6]|div|td|tr|dt|dd|br|section|article|header|footer|nav|main|ul|ol|title|a|span)$/i;
function htmlText(html) {
  const attrs = [...html.matchAll(/\b(?:content|alt|title|aria-label)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  const ld = [...html.matchAll(/<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => ldText(m[1]));
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '\n').replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?([a-z0-9-]+)\b[^>]*>/gi, (_, t) => (BLOCK.test(t) ? '\n' : ''));
  return [body, ...ld, ...attrs].join('\n').replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'");
}

const failures = [];
for (const f of walk(ROOT).filter((p) => TEXT.has(extname(p).toLowerCase()))) {
  const raw = readFileSync(f, 'utf8');
  const text = extname(f) === '.html' ? htmlText(raw) : raw;
  for (const s of violations(text)) failures.push(`${relative(ROOT, f)}: ${s.slice(0, 200)}`);
}
if (failures.length) {
  console.error(`ENTITY CHECK FAILED — ${failures.length} sentence(s) give sponsorship/nonprofit status to something other than aicoachellavalley.org:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('entity check ok — every sponsorship or nonprofit-status sentence on aicv.co names aicoachellavalley.org');
