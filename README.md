# Activity Dock for OBS

A **free, open-source activity feed + alert overlay** for OBS Studio that tracks **Twitch and YouTube** in one place:

| Twitch | YouTube |
|---|---|
| Follows, subs, resubs, gift subs, Prime/gift upgrades | Chat messages (with emojis) |
| Bits / cheers, power-ups, charity donations | Super Chats & Super Stickers |
| Raids (in & out), shoutouts | New members, membership milestones, gifted memberships |
| Channel-point redeems (custom + automatic) | New channel subscribers *(official API + Google sign-in)* |
| Chat messages (with emotes, badges, replies, highlights) | Members-only mode, bans, stream ended |
| Hype Trains, ad breaks, stream online/offline, announcements, watch streaks, shared-chat events | |

Plus: per-type filters and search, session counters, optional sounds (built-in or your own files), a **browser-source alert overlay** with text-to-speech, and test buttons for everything.

It is a plain web page – no accounts, no subscription, nothing leaves your PC except the calls to Twitch/YouTube themselves.

---

## 1. Quick start (Windows, recommended)

1. Install **Node.js LTS** from <https://nodejs.org> (only needed once – it powers the small local server).
2. Download this repository (green **Code** button → **Download ZIP**, or `git clone …`) and unzip it somewhere permanent, e.g. `C:\StreamTools\activity-dock`.
3. Double-click **`start-dock.bat`**. A console window opens and stays open while you stream (you can minimise it). It prints:
   ```
   Dock     http://localhost:8520/
   Overlay  http://localhost:8520/overlay.html
   ```
4. In OBS: **Docks → Custom Browser Docks…** → Dock Name `Activity`, URL `http://localhost:8520/` → **Apply**. Drag the new dock wherever you like.
5. In the dock click **⚙ Settings → Twitch** and follow the 2-minute setup below. Then **YouTube**.

macOS / Linux: run `./start-dock.sh` (or `node server.js`) instead of the `.bat`.

> The server is the only moving part. It hosts the dock, reads YouTube chat without any Google setup, and relays alerts to the overlay. It never sends anything anywhere except to twitch.tv / youtube.com.

## 2. Connect Twitch (≈2 minutes, free)

Twitch requires every app to have its own *Client ID*. You create one once:

1. Go to <https://dev.twitch.tv/console/apps/create> (log in with your Twitch account – it must have two-factor authentication enabled).
2. Fill in:
   * **Name:** anything, e.g. `My Activity Dock`
   * **OAuth Redirect URLs:** `http://localhost` (required by the form, not used)
   * **Category:** Broadcaster Suite
   * **Client Type:** **Public** ← important
3. Click **Create**, then **Manage**, and copy the **Client ID** (no secret is needed).
4. In the dock: **Settings → Twitch**, paste the Client ID, click **Connect with Twitch**.
5. The dock shows a link and an 8-character code. Open the link in your **normal browser** (not inside OBS), sign in if needed, enter the code if asked, and click **Authorize**. The dock connects by itself a few seconds later.

The dock asks only for *read* permissions (followers, subs, bits, channel points, chat, hype train, ads, shoutouts, charity). Tokens are stored in the dock's own browser storage and refreshed automatically; you should not have to log in again unless you stay offline for more than 30 days.

Subs, bits, channel points and Hype Train events only exist for **Affiliate/Partner** channels – on other channels those subscriptions show as "not allowed", which is expected.

## 3. Connect YouTube

You have two ways; you can set up both and the dock picks the best available one (**Settings → YouTube → Mode**).

### Option A – Helper (no Google setup, no quota) – default

Nothing to configure beyond your channel:

1. **Settings → YouTube**, tick **Enable YouTube**.
2. Enter your **Channel** (`@YourHandle`) – or paste the **live stream URL** if you prefer.
3. Click **Start**. While the local server (`start-dock.bat`) is running, the dock reads the public live chat exactly like a browser does and shows chat, Super Chats, Super Stickers, new members, milestones and gifted memberships. It waits automatically for your stream to go live and picks up the next stream when one ends.

Limitations: it cannot see *new subscribers* (YouTube does not show those in chat), and because it is unofficial it can break for a while if YouTube changes its page layout (updates fix it).

### Option B – Official YouTube Data API

More "official", adds **new-subscriber** events and works even without the local server, but Google gives every project a **daily quota of 10,000 units** – live chat costs ~5 units per request, which is roughly **6–8 hours of streaming per day**. When the quota runs out the dock switches to the helper automatically (if it is running).

1. Go to <https://console.cloud.google.com/> → create a project (e.g. `Activity Dock`).
2. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.
3. **APIs & Services → Credentials → Create credentials**:
   * **API key** → copy it into **Settings → YouTube → API key**. With only a key the dock needs your **live stream URL** (cheap, 1 unit) or can search your channel (expensive, 100 units per check).
   * *and/or* **OAuth client ID** → Application type **TVs and Limited Input devices** → copy **Client ID** and **Client secret** into the dock. Before that, open **OAuth consent screen / Audience** once: choose *External*, fill in the app name and your e-mail, and add your own Google account under **Test users**.
4. In the dock click **Sign in with Google**, open <https://www.google.com/device> in your normal browser, enter the code, and allow *"View your YouTube account"*. With Google sign-in the dock finds your live broadcast by itself and also polls for new public subscribers.

Note: while your Google app is in *Testing* status the sign-in expires after **7 days** – just click *Sign in with Google* again. (Publishing the app to *In production* removes that limit; you will see an "unverified app" warning during sign-in that you can click through via *Advanced*.)

## 4. Alerts on stream (overlay)

1. In OBS: **Sources → + → Browser**, URL `http://localhost:8520/overlay.html`, width **1920**, height **1080**. Tick **Control audio via OBS** if you want alert sounds to go to the stream.
2. In the dock: **Settings → Overlay** – choose which event types alert, minimum bits / amounts, position, theme, duration, optional text-to-speech. **Send test alert to overlay** to check it.

The overlay receives alerts from the dock through the local server, so it works even though OBS docks and browser sources cannot talk to each other directly. Preview it any time in a browser with `http://localhost:8520/overlay.html?preview=1` (add `&theme=neon&position=bottom-center&sound=1` to try options).

*(Alternative without the server: enable **Tools → WebSocket Server Settings** in OBS, enter the URL/password in **Settings → OBS**, and use the second overlay URL shown in the Overlay tab.)*

## 5. Running it from GitHub Pages instead

The dock is 100 % static, so you can also host it on GitHub Pages and add the URL to OBS – no local install at all for Twitch:

1. Fork / push this repository to GitHub.
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch** → branch `main`, folder `/ (root)` → Save. A minute later your copy is live.
3. Add `https://<your-user>.github.io/activity-dock/` as a custom browser dock in OBS.

What works from Pages:

| Feature | From GitHub Pages | + local `start-dock.bat` running |
|---|---|---|
| Everything Twitch | ✅ | ✅ |
| YouTube via official API (key / Google sign-in) | ✅ | ✅ |
| YouTube via helper (no quota) | ❌ | ✅ (dock finds the server at `127.0.0.1:8520`) |
| Alert overlay | via OBS WebSocket | ✅ `http://localhost:8520/overlay.html` |

When the hosted dock is open in a regular browser (Chrome 142+) it may ask once for permission to "connect to devices on your local network" when it talks to the local server – click Allow. The server only answers browser requests from `localhost`, `*.github.io` and origins you pass with `--allow-origin https://my.site`.

## 6. Tips & troubleshooting

* **Nothing shows up?** Click the coloured **Twitch / YouTube** pills in the header – they open the matching settings tab with a status line. **Settings → About → Log** shows what is happening; *Copy log* is handy for bug reports.
* **Test everything** with **Settings → Test** (test events are marked `TEST` and are not counted in the stats).
* **Filters:** click a chip to hide/show a type, right-click to show only that type, and use the search box to find a user.
* **Pause** (⏸) holds new items while you read; they are added when you resume.
* **Chat too busy?** Untick *Chat messages* under Twitch/YouTube "What to track", or hide it with the *Chat* chip.
* **Sounds don't play in a normal browser** until you click the page once (browser autoplay rules). In OBS docks they play immediately.
* **Signed in with the wrong account?** *Sign out* in the relevant tab. Everything is stored in the browser profile of the OBS dock; *Settings → About → Reset everything* clears it.
* **Port 8520 busy?** `node server.js --port 9000` (and use that port in the URLs).
* **Start with Windows:** create a shortcut to `start-dock.bat` in `shell:startup`.
* Two docks (e.g. OBS + a second monitor browser) can run at the same time; the token refresh is shared between them.

## 7. Files

```
index.html      the dock            js/twitch.js    Twitch auth + EventSub WebSocket
overlay.html    the alert overlay   js/youtube.js   YouTube official API + helper client
server.js       local server: static hosting, YouTube helper (SSE), overlay relay
start-dock.bat  Windows launcher    js/app.js       UI, feed, settings, tests
```

No build step, no dependencies. Runs on Node.js 18+ and in OBS 30+ (Chromium/CEF).

## 8. Privacy & security

* Twitch/Google tokens, settings and the recent feed are stored **only** in the dock's browser storage (`localStorage`). Export/import lives in **Settings → About**.
* The local server binds to `127.0.0.1` by default (only your PC can reach it). Use `--host 0.0.0.0` if you really need another device on your LAN to open the dock.
* The Google client secret of a "TV / limited input" OAuth client is, by Google's own design, not a real secret for this flow – but keep it out of screenshots anyway.

## License

MIT – do whatever you like, no warranty. Not affiliated with Twitch, YouTube/Google, OBS or Aitum.
