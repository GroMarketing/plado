// Fires refresh.yml once a day. The workflow's concurrency group makes an overlapping
// trigger wait instead of double-running; installs recount on Mondays (UTC).
export default {
  async scheduled(event, env, ctx) {
    const monday = new Date(event.scheduledTime).getUTCDay() === 1;
    const r = await fetch(`https://api.github.com/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.GH_PAT}`, accept: 'application/vnd.github+json', 'user-agent': 'plado-refresh-cron', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ ref: 'main', inputs: { installs: String(monday), deploy: 'true' } }),
    });
    if (r.status !== 204) throw new Error(`dispatch failed ${r.status}: ${await r.text()}`);
  },
};
