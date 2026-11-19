# Library robot

Builds one shared video library for all users and publishes it as static files.
The app downloads these files instead of calling YouTube itself.

## One-time setup (about 10 minutes)

1. Create a **new GitHub repository** (public is fine: it only holds code and the creator list, never keys).
   Copy this folder's contents into it (`robot/` and `.github/`), then push.
2. In the repo: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `YOUTUBE_API_KEY`
   - Value: a **new** YouTube Data API key (do not reuse the one inside the shipped app).
3. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
4. **Actions tab → "Refresh library" → Run workflow.** The first run builds everything.
   If the daily quota runs out, it stops cleanly and the next run continues.
5. Your library address is `https://<your-github-username>.github.io/<repo-name>/v1/index.json`.
   Open it in a browser: you should see JSON. Send me that address.

## What runs, and when

| When | What | Quota cost |
|---|---|---|
| Every 4 hours | Ask each creator for uploads newer than the ones saved, fetch details for new videos only | about 420 units per run |
| Per creator, every 72 hours | Re-read views/likes for the saved videos, drop deleted/private ones | about 1 unit per 50 videos |
| First run | Full walk back `WINDOW_DAYS` for every creator | a few thousand units |

The robot keeps its own running total of units used today (YouTube resets at midnight Pacific)
and stops at `DAILY_QUOTA_BUDGET` (8000 of the default 10,000), leaving room for other uses.
Saved data is re-read at least every 3 days, well inside YouTube's 30-day rule.

## Settings (in the workflow file)

- `WINDOW_DAYS` how far back videos are kept (180).
- `DAILY_QUOTA_BUDGET` units the robot may spend per day (8000).
- `REFRESH_AFTER_HOURS` how often saved numbers are re-read (72; keep under 720).
- Cron `17 */4 * * *`: every 4 hours. Do not go below every 2 hours without raising your quota.

## Changing the creator list

Edit `robot/creators.json` (same format as the app's `creators_for_content.json`) and push; the next run picks it up.
Removed creators disappear from the published index automatically.

## What it publishes

- `v1/index.json`: one line per creator with a `rev` fingerprint. A phone compares revs and downloads only changed creators.
- `v1/creators/<channelId>.json`: that creator's videos, same shape the app already reads.

## Safety

- If a creator fails to fetch, its previous file is kept, never replaced with a half-result.
- If nothing at all could be built, the run fails instead of deploying an empty library.

## Local test (no key needed)

`node --test robot/refresh.test.mjs`
