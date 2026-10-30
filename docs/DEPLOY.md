# Put LearnLens online (step by step)

Learners' browsers send tracking data straight to LearnLens, so it must run on a server they can reach, over **HTTPS**. This guide gets you there without needing to know servers.

**Choose one:**

| Option | Best for | Effort | Cost |
|---|---|---|---|
| [A. Render, one click](#a-render-one-click) | Most people, no terminal needed | 10 minutes | Free to try, small monthly fee for real use |
| [B. Docker on your own server](#b-docker-on-your-own-server) | IT teams, company servers | 30 minutes | Your server |
| [C. A tunnel from your laptop](#c-quick-test-from-your-laptop) | A one-hour test with a real LMS | 10 minutes | Free |

---

## A. Render, one click

[Render](https://render.com) is a hosting service. The `render.yaml` file in this project tells it exactly what to create: the LearnLens app, a PostgreSQL database, a dashboard password and a secret. It also sets the HTTPS address for you.

### 1. Put the project on GitHub (once)

Render deploys from a GitHub repository.

1. Create a free account on [github.com](https://github.com) and click **New repository**. Name it `learnlens`, make it **Public** (or Private, see the note below), and create it without a README.
2. On the new repository's page, click **uploading an existing file**, drag in **everything inside** the unzipped `learnlens` folder (not the folder itself, and not any `node_modules` folders), and click **Commit changes**.

> **Private repository?** That works too: when Render asks, allow it to access that repository.

### 2. Deploy

Open this address in your browser, with your GitHub username in it:

```
https://render.com/deploy?repo=https://github.com/YOUR-GITHUB-USERNAME/learnlens
```

(Or add the button to your README: replace `YOUR-GITHUB-USERNAME` in the "Deploy to Render" button at the top of the README.)

1. Sign in to Render (you can use your GitHub account).
2. Render shows what it will create: a web service called **learnlens** and a database called **learnlens-db**. It may ask for `ALERT_WEBHOOK_URL`; leave it empty unless you use Slack/Teams.
3. Click **Deploy Blueprint** and wait about five minutes until the service shows **Live**.

### 3. Sign in

1. In Render, open the **learnlens** service → **Environment** and copy the value of **ADMIN_TOKEN**. This is your dashboard password.
2. Open your LearnLens address (shown at the top of the service page, like `https://learnlens-xxxx.onrender.com`) and paste the token.
3. Go to **Connect a course**. The **Server setup** panel should show all green ticks.

### 4. Test with your LMS, then track a course

1. On **Connect a course**, add a course, then click **Download test .zip** under *Test the connection from your LMS*.
2. Upload that zip to your LMS as a **SCORM package** and open it as a learner. You'll see a checklist, and the same results appear in LearnLens within a few seconds.
3. All green? Upload your real course zip on the SCORM tab, download the tracked version, and publish it in your LMS. Watch **Live events** while you try it.

### Free plan vs. real use

The free plan is great for trying LearnLens, but for real learners please note (as of Render's current limits):

- **The free database is deleted after 30 days** unless you upgrade it. Upgrade **learnlens-db** to a paid plan before you track real learners.
- **The free web service sleeps after 15 minutes without traffic** and takes about a minute to wake. Courses keep events and retry, but some may be lost if a learner closes the course while it is waking. Use a paid web service plan for real courses.
- **Files are not kept between restarts** on Render web services. Your data is safe in the database, but wrapped packages and generated reports kept on the server disappear after a restart or deploy. Download wrapped packages straight after wrapping (you would anyway), and upload the original again if you need to re-wrap.

Check [Render's free plan page](https://render.com/docs/free) for the latest limits.

---

## B. Docker on your own server

On any server with Docker and a domain name pointing to it:

```bash
cp .env.example .env
# Edit .env: set ADMIN_TOKEN, HASH_SECRET (two different long random strings)
#            and PUBLIC_URL (e.g. https://learnlens.your-company.com)
docker compose up -d
```

This starts LearnLens on port 4000 with its own PostgreSQL database and persistent storage. Put it behind HTTPS with your usual reverse proxy. For example, with [Caddy](https://caddyserver.com), which gets certificates automatically, the whole configuration is:

```
learnlens.your-company.com {
    reverse_proxy localhost:4000
}
```

Then follow [step 3 and 4 above](#3-sign-in) (your ADMIN_TOKEN is the one in `.env`).

**Without Docker**, on any machine with Node.js 20+: `npm run setup`, then start it with the same environment variables (`ADMIN_TOKEN=… HASH_SECRET=… PUBLIC_URL=… npm start`), and keep `server/data` on persistent storage or set `DATABASE_URL` to a PostgreSQL database.

---

## C. Quick test from your laptop

For a short test with a real LMS, a tunnel gives your laptop a temporary HTTPS address.

1. Start LearnLens: `npm start`.
2. In another terminal, start a tunnel, for example [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) (`cloudflared tunnel --url http://localhost:4000`) or [ngrok](https://ngrok.com) (`ngrok http 4000`). It prints an `https://…` address.
3. Stop LearnLens and start it again with that address: `PUBLIC_URL=https://the-address ADMIN_TOKEN=pick-a-password npm start`.
4. Open the HTTPS address, sign in, and run the connection test from your LMS as in [step 4](#4-test-with-your-lms-then-track-a-course).

The address changes each time you restart the tunnel, so packages wrapped with it stop working afterwards. Use option A or B for anything beyond a test.

---

## Troubleshooting

Run the **connection test package** first: it checks everything from inside your LMS and says what to fix. The most common results:

| Test result | What it means | Fix |
|---|---|---|
| *No SCORM API was found* | The zip was added as a file or web page, not a SCORM activity | Add it as a SCORM package / SCORM activity |
| *Your LMS uses HTTPS but LearnLens is at an HTTP address* | Browsers block this | Use an HTTPS address and set `PUBLIC_URL`; re-wrap your courses |
| *Blocked by the LMS security policy* | The LMS sends a Content-Security-Policy that blocks other sites | Ask your LMS admin to add your LearnLens address to `connect-src` |
| *No answer after 20 seconds* | Server asleep (free hosting) or down | Wait a minute and reopen the test; check the server is running |
| *The request failed* | Wrong address, firewall, VPN or proxy | Open `https://your-address/health` from the same computer: it should show `{"ok":true}` |
| Test passes but no events from your course | The course was wrapped before `PUBLIC_URL` was set, or wrapped for another course | Re-wrap the original zip and upload the new version to the LMS |
