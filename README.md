# aicv.co — the hub

Sat Singh's hub: one map of every project and experiment, built from **one content file**,
`content/hub.json`. The design is artboard "I3 · The Hub, arms folded" on the aicv.co design
canvas. The original build brief and agent-readiness kit are kept outside this public repo.

## Change something

Edit `content/hub.json`, or ask Claude Code in plain English, for example:
*"Add 'valley founder dinners' to the lab, linked to AI Tinkerers"* or
*"Mark AIQnA completed"*. Push to `main`; Cloudflare Pages rebuilds in about a minute.

| To… | Edit in `hub.json` |
|---|---|
| Add a project (inner ring) | a new entry in `projects` (up to 8 on the map; more go to the list only) |
| Add an experiment (outer ring) | a new entry in `lab` (up to 12 on the map) |
| Change an experiment's label | `status`: `open`, `running`, `completed` or `idea`; optional `statusLabel` for custom words ("Filling up") |
| Retire an experiment | set `"status": "completed"` (it stays on the map, faded) or delete the entry |
| Add a penciled-in idea | `ideas`: `{ "label": "…", "near": "<id of a project or lab item>" }` |
| Add an event | `events`: `title`, `short`, `date` (YYYY-MM-DD), `place` (as it reads in a sentence: "the Palm Desert ERC"), `project` (id), optional `free`, `kind`, `url`. It shows on that project's panel and drops off the day after its date. |
| Turn on the AI phone line | `person.contact.agentPhone`: the number, e.g. `"+1 760 555 0100"`. It then shows in the "Reach me" bar, the footer, llms.txt and the JSON-LD. `null` hides it. |

No coordinates anywhere: the map lays itself out from the lists. If an edit has a mistake
(a missing field, an `id` used twice, an idea pointing at an id that doesn't exist), the build
stops and says what to fix, and the live site stays as it was.

## How it builds

`node scripts/build.mjs` writes `dist/`:

- `index.html`: the map, "Reach me", "Every destination", the TEDx card, "The short version",
  the footer, and the JSON-LD in `<head>`. Everything is plain HTML, including every panel's
  text, so agents and no-JavaScript crawlers see what people see.
- `llms.txt` (with "Last updated"), `sitemap.xml`, `now.json`, and everything in `static/`.

At build time it pulls the latest AICV News headline (`projects[].feed`) and works out the next
event per project. If the feed is down it keeps the last good headline (read from the live
`https://aicv.co/now.json`), then falls back to that project's `now` text. A feed never breaks
the build.

The last step is the **entity check** (`scripts/check-entity.mjs`): any sentence giving
nonprofit or fiscal-sponsorship status to something other than aicoachellavalley.org fails the
build.

Other commands:

```bash
node scripts/build.mjs --offline                    # no network
AICV_CO_TODAY=2026-12-06 node scripts/build.mjs      # pretend it's another day
node scripts/check-links.mjs                         # check every outside link (after a build)
```

## Cloudflare Pages settings (project `aicv-co`)

- Build command: `node scripts/build.mjs`
- Build output directory: `dist`
- Node version comes from `.node-version` (22).

## Daily refresh

`cron/` is a tiny Worker, `aicv-co-daily-rebuild`, that calls the Pages deploy hook at 13:00 UTC
(5 am Pacific in winter, 6 am in summer). One-time setup, after the deploy hook exists:

```bash
cd cron
env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=52a9db008bc2f79a8e51e03797776476 wrangler deploy
env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=52a9db008bc2f79a8e51e03797776476 wrangler secret put DEPLOY_HOOK
```

(`env -u CLOUDFLARE_API_TOKEN` because the token exported in `~/.zshrc` can't see any account.)

## Files

```
content/hub.json        the one file to edit
scripts/build.mjs       builds dist/ (Pages runs this)
scripts/check-entity.mjs  the entity firewall check (the build runs it)
scripts/check-links.mjs   link checker (run by hand)
static/                 copied as-is: portrait, favicons, robots.txt, 404.html, older photos
cron/                   the daily-rebuild Worker
```
