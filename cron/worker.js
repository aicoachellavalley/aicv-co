/**
 * aicv-co-daily-rebuild — rebuilds aicv.co every morning.
 *
 * It calls the aicv-co Pages project's deploy hook. Pages then runs `node scripts/build.mjs`,
 * which pulls the latest AICV News headline, drops events whose date has passed and writes
 * the build date into llms.txt. This Worker has no web address and serves nothing; it only
 * runs on its cron schedule (wrangler.toml).
 *
 * Secret: DEPLOY_HOOK (the hook URL from Cloudflare: Workers & Pages -> aicv-co -> Settings ->
 * Builds -> Deploy hooks). Set it with `wrangler secret put DEPLOY_HOOK`.
 */
export default {
  async scheduled(controller, env) {
    if (!env.DEPLOY_HOOK) {
      console.warn('DEPLOY_HOOK is not set; nothing to do');
      return;
    }
    const res = await fetch(env.DEPLOY_HOOK, { method: 'POST' });
    console.log(`aicv.co deploy hook: HTTP ${res.status} (cron ${controller.cron})`);
    if (!res.ok) throw new Error(`deploy hook returned HTTP ${res.status}`);
  },
};
