# WHOOP API — the calibration answer-key

Pulls WHOOP's **official** Recovery / Strain / Sleep / HRV / RHR via the developer API so they
can be paired with WHOOP Core captures and used to tune the `scores.js` `CALIBRATE` constants.

Runs on your PC (Node 18+). Your client secret stays in a **local, gitignored** file — never in
the repo, never printed, never pasted into chat.

## One-time setup
1. Go to **[developer.whoop.com](https://developer.whoop.com)** → sign in with your WHOOP account → **create an app**.
2. Set the app's **Redirect URI** to exactly:
   ```
   http://localhost:8765/callback
   ```
3. Select scopes: **read:recovery, read:cycles, read:sleep, read:profile, offline**.
4. Copy the **Client ID** and **Client Secret**.
5. In the repo root, create a file **`.whoop.env`** (already gitignored) with:
   ```
   WHOOP_CLIENT_ID=your_client_id
   WHOOP_CLIENT_SECRET=your_client_secret
   ```

## Use
```sh
node tools/whoop-api.mjs auth      # one-time: opens the browser, you log in & approve
node tools/whoop-api.mjs 7         # print the last 7 days (default 7)
node tools/whoop-api.mjs 14        # …or any number of days
```

`auth` saves rotating tokens to `.whoop-tokens.json` (gitignored); after that, `pull` refreshes
them automatically. It prints a table like:

```
date         recovery  strain   sleep%   HRV       RHR
-----------  --------  -------  -------  --------  -----
2026-06-17   64%       11.3     88%      78        51
```

Paste that table next to your WHOOP Core capture for the same day(s), and the scores get
calibrated to match WHOOP.

> Data comes from WHOOP's cloud (your band syncs via the official app), which is fine here —
> this is the *comparison* source, not the app-free reading path.
