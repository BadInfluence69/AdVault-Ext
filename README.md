# AdVault-Ext
# AdVault

**Blocks ad and malvertising requests before they execute, hides what is left, and skips the ads inside video players.**

Built against the no-click path: nothing loads, so nothing runs.

A Manifest V3 Chrome extension. Version 0.6.3 · Author: Briam Cambron · Requires Chrome 120+

---

## Why it is built this way

Hiding an ad is cosmetic. The request already went out, the script already ran. Malvertising does not need a click — it needs to execute. So the layer that actually protects you is the network layer, and it has **no switch**: it is the point of the extension, not an option.

Everything above it is cleanup.

| Layer | What it does | Switchable |
|---|---|---|
| **Network** (`declarativeNetRequest`) | 57,286 static rules. The request never reaches the page. | No — always on |
| **YouTube player recovery** | Clears the black-screen player when YouTube paints a spurious error overlay. | No — only ever acts on an already-broken player |
| **Cosmetic** | Hides leftover ad markup, placeholders and empty slots. | Yes |
| **uBO site rules** | Ported uBlock Origin Lite site rules + scriptlets, every site except YouTube. | Yes |
| **Video players** | Mutes, fast-forwards and clicks Skip on player-flagged ads. | Yes |
| **SponsorBlock** | Seeks past community-marked sponsor segments on YouTube. | Yes |
| **YouTube TV DVR** | Skips recorded broadcast breaks. | Yes |

The rule on switches: a switch exists only if there is a real reason someone would turn it off. Anything that simply works is on and has no switch. Anything that did not work is removed, not labelled "experimental".

---

## Install

1. Download or clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. **Load unpacked** → select the `AdVault` folder.

No build step. No bundler. Load the folder as it is.

---

## The network layer

Three static rulesets, all enabled, all together:

| Ruleset | Rules | Contents |
|---|---|---|
| `rules/net_core.json` | 20,307 | 20,000 blocks + 307 first-party allow exceptions |
| `rules/net_ads.json` | 20,000 | ad and badware request blocks |
| `rules/net_ads_extra.json` | 16,979 | the overflow set |

Also shipped, **not enabled** in the manifest — available if you want to wire them up:

| Ruleset | Rules | Contents |
|---|---|---|
| `rules/net_privacy.json` | 9,686 | tracker / telemetry blocks |
| `rules/net_filters.json` | 4,845 | blocks, allows, 807 redirects to neutered stubs, 49 header rewrites |
| `rules/net_overlays.json` | 320 | newsletter / consent / interstitial overlays |

The redirect rules point at the stubs in `web_accessible_resources/` (noop scripts, 1×1 GIFs, empty VAST/VMAP XML, neutered GPT / analytics / prebid / IMA shims). Enabling those rulesets means declaring those resources in the manifest.

### Chrome's static-rule budget

Chrome enables rulesets only while its static-rule budget lasts, and **that budget is shared with every other `declarativeNetRequest` extension in the profile**. It silently skips the rest. With a second blocker installed, which rulesets survive can differ from one browser start to the next — that is what "it works, then it doesn't" looks like from the outside.

AdVault does not hide this. After every sync it reads back what Chrome actually enabled and reports the drift in the popup under **Rule set problem**. If it fires, the fix is running fewer blockers, not adding more rules.

---

## Per-site off

The popup's **Turn off on this site** writes the hostname to `offSites`. That becomes a dynamic `allowAllRequests` rule (priority 1000) on `main_frame` and `sub_frame`, and the hostname is added to `excludeMatches` on the scriptlet bundles. Up to 4,000 hostnames; 500 for the scriptlet exclusions.

---

## The cosmetic layer

`src/cosmetic.js` installs `display:none!important` rules into a **constructable stylesheet** — no `<style>` node for a page to find and remove. Rules go in one at a time, so a selector Chrome dislikes cannot take the rest down with it. Rejected hand-written selectors are warned once and exposed on `self.__agRejectedSelectors` for devtools.

Selectors come from three places:

1. **The hand list** — always on. GPT/AdSense slots, Taboola, Outbrain, IAB `aria-label`s, plus per-site lists for YouTube, X/Twitter, Reddit and Twitch.
2. **Per-site EasyList rules** — `data/cosmetic-sites.json`: 16,071 selectors across 7,764 hosts, with 23 exception hosts and 410 `nohide` hosts where generics are suppressed.
3. **Generic rules, applied lazily** — `data/cosmetic-generic.json`: 8,925 class tokens, 4,268 id tokens, 485 always-on selectors. The page is scanned for the class and id tokens it actually uses, and only selectors keyed on a present token are installed. That keeps thirteen thousand generic rules off the page while still covering all of them.

The databases live in the service worker and answer per-frame lookups by message, so the big JSON files are never injected into a page.

**Re-adoption.** `document.adoptedStyleSheets` is one array shared with the page, and YouTube's Polymer *assigns* to it rather than appending. When it did, AdVault's sheet was dropped off the end and every rule silently stopped applying. The sheet is re-adopted on every rebuild and on a slow timer while hiding is on.

---

## The uBO layer

`data/ubo-cosmetic.json` and `ubo/scriptlets-*.js` are ported from the uBlock Origin Lite tree (GPLv3) by `tools/port_ubo.py`:

- 6,274 selectors across 5,368 hostname keys, 499 exception keys, 3 regex host rules
- generic layer: 80 class tokens, 60 id tokens, 110 always-on
- `src/ubo-procedural.js` handles what plain CSS cannot express — `:has-text()`, `:upward()`, `:xpath()`, `:matches-css()`, `:matches-attr()`, `:others()`, `:shadow()`, plus the `style` / `remove` / `remove-attr` / `remove-class` actions and `@media`-scoped rules
- `ubo/scriptlets-main.js` (MAIN world) and `ubo/scriptlets-isolated.js` (ISOLATED world) carry `set-constant`, `json-prune`, `abort-on-property-read` and the rest, registered dynamically at `document_start` and gated by hostname the way uBO Lite does it

Hostname lookups use uBO's key scheme: every suffix plus the entity forms (`example.*`, `www.example.*`).

**All of it excludes YouTube** — every YouTube host, and every frame inside a YouTube tab. YouTube is handled by AdVault's own logic instead, and mixing the two is what breaks it.

---

## Video players

`src/sites.js` reads the page's own player flag. Not a guess — the player's own class names:

`.html5-video-player.ad-showing` / `.ad-interrupting` (YouTube) · `.jw-flag-ads` · `.vjs-ad-playing` · `.plyr--ad-playing` · Bitmovin · Twitch · IMA SDK · generic `[class*="ad-playing"]` / `[data-ad-playing="true"]` conventions.

On YouTube only the two exact YouTube flags are tested. Running all thirteen attribute-substring selectors against YouTube's ~30k-node document five times a second was pure main-thread cost for an answer the first two already give.

While a flag is up, `src/content.js`:

- mutes the ad
- clicks the player's own Skip / close button the moment it appears (selector list plus a Skip-text match on `aria-label` / `textContent`)
- fast-forwards, **never faster than the download**
- on the flag clearing: normal speed, sound back, and on YouTube a short watchdog to unstick a player that came out of the ad parked in a buffer gap

### Non-skippable ads

A flat fast rate drained the player's buffer faster than googlevideo could refill it, and the stall carried into the programme. So the rate follows `bufferedAhead()`: 1× below two seconds buffered, 4× below six, ceiling of 8× above that. Playback speed can never beat the download.

The answer is to stop decoding the ad at all. `adAdvance()` seeks to the end of data that has **already arrived**, which always lands and costs no decoding — so the ad is consumed as fast as it is delivered. On a decent connection a 30-second ad is gone in about two seconds.

Guarded, because the unguarded version of this was the black-screen bug:

- the target must be inside a buffered range
- at least `SEEK_MIN` (0.7 s) ahead
- at most one seek per `SEEK_GAP` (350 ms)
- the last `AD_TAIL` (0.45 s) plays out normally so YouTube's own ad-end logic fires
- after `SEEK_FAILS` seeks that do not move the clock, it gives up for the rest of the ad and falls back to `playbackRate` alone

### The start gate

On a watch page that opens with a pre-roll, arming the player layers while the player was still initialising left a black screen: the layers set `playbackRate`, `muted` and `currentTime` on a `<video>` whose stream was still being wired up, YouTube's player threw, and it painted its error overlay. Disabling the extension, letting the video start, then re-enabling it mid-ad always worked.

`run_at` does not fix this — neither `document_start` nor `document_idle` waits for YouTube's player, which boots asynchronously well after `window.load`. So the layers inject as normal and simply do not **act** until 3 s after load (10 s floor if `load` never fires). YouTube hosts only; every other site arms immediately.

---

## YouTube player recovery

The symptom: audio keeps playing, the picture is black, clicking the player does nothing, **but the spacebar still pauses**. Those four together say the stream is fine. YouTube has painted its error overlay on top of a video that is still decoding — the overlay is opaque and sits inside `#movie_player` above the video, so it hides the picture and eats every mouse event, while the spacebar still works because YouTube's keyboard handler is on the document.

Two different failures wear the same black rectangle, and they need opposite treatment:

| State | Action |
|---|---|
| Stream healthy, overlay up | Take the overlay down. Re-asking YouTube would throw away a working stream and your position in it. |
| Stream dead, overlay up | Re-ask YouTube for the video at the current position (`loadVideoById`), bounded — 3 tries per video id, then leave the message up. |

The overlay is only ever hidden while the stream is **proven healthy** (alive for 1.2 s), and goes straight back if the stream later dies. So "Video unavailable", members-only and age-gate messages still show normally. `LOGIN_REQUIRED`, `UNPLAYABLE`, `CONTENT_CHECK_REQUIRED`, `AGE_CHECK_REQUIRED` and `LIVE_STREAM_OFFLINE` are treated as answers, not faults — re-asking just gets the same reply.

None of this is a CSS rule. Hiding `#error-screen` from a stylesheet would swallow the real messages too, on every page, whether the stream was healthy or not.

`src/yt-recover.js` runs in the isolated world and cannot touch `#movie_player`'s player object, so `src/inject.js` runs in the page's own world and answers two `postMessage` probes: `__adguardYtProbe` → `__adguardYtState` (player state, `playabilityStatus`, video id) and `__adguardYtFix` (`loadVideoById` at the same position). `inject.js` patches no page globals.

Everything is logged under `[AdVault]`, **including the `declarativeNetRequest` rules that fired on the page** — an overlay over a healthy stream usually means the player's JS threw after a request it wanted was blocked, and that list names the rule.

---

## SponsorBlock

YouTube only. Community-marked `sponsor`, `selfpromo` and `interaction` segments are seeked past.

Only the **first 4 hex digits of the video id's SHA-256** leave the browser — SponsorBlock's k-anonymity API. The match happens locally in the service worker. Results are cached (200 entries); transient failures are not cached.

---

## YouTube TV DVR skip

`tv.youtube.com` only, main frame only.

A DVR recording of a live broadcast carries the broadcast's own commercials as frames inside the same stream. There is no ad request to block, no ad element to hide, and the player never raises an ad flag. The only thing that gets past them is a seek.

Break positions come from, in order of preference:

1. markers the player itself draws on the progress bar — exact, automatic, when present
2. breaks you mark once with **Alt+M** — exact, kept per recording
3. a plain fixed jump on **Alt+S** — no detection at all

**Alt+H** toggles the HUD.

Nothing is guessed from the picture or the sound. On `tv.youtube.com` it could not be anyway — the stream is DRM-protected, so a canvas read is black.

Seek safety follows the same rules `content.js` learned the hard way: one seek at a time, never re-issued until the clock is checked, 1.5 s between seeks, no single jump over 300 s, and after 3 seeks that do not move the clock the layer stops for the rest of the recording. A seek that snaps back means YouTube served the network's on-demand copy instead of your recording — that copy has fast-forward disabled by contract. That is reported, not fought.

---

## Settings

Five switches plus the master switch. That is the whole surface.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `cosmetic` | `true` | hide page ads |
| `cosmeticLists` | `true` | use the full EasyList selector database |
| `uboRules` | `true` | uBO site rules on other sites (not YouTube) |
| `dom` | `true` | click Skip, handle player-flagged ads |
| `sponsorblock` | `true` | YouTube sponsor / self-promo / interaction segments |
| `dvrSkip` | `true` | YouTube TV recorded-break skipping |
| `offSites` | `[]` | hostnames switched off entirely |

### Why settings load three ways

`chrome.storage.sync` is network-backed. On a cold profile, right after the browser starts, when the profile is signed out, or while the sync quota is in backoff, a read can take seconds or never arrive. Every layer waits on the first publish — `cosmetic.js` installs nothing, `content.js` does not scan, the recovery watchdog never arms. When that happened the page ran with the extension doing nothing, and toggling it off and on was the only way out.

So:

1. **`storage.local` mirror** — local, always fast, holds the last known-good settings
2. **`storage.sync`** — the real source; overwrites the mirror when it answers
3. **a 1.2 s floor** — if neither has answered, come up on defaults rather than inert

The service worker does the same, with a 1.5 s race on the sync read, and a single 2 s retry if ruleset sync throws.

---

## What was removed, and why

This is here so nobody tries to put it back.

**The picture-and-sound ad detector** (`src/engine.js`) — a canvas frame-grab and a WebAudio tap on every media second, feeding a statistical engine that guessed where ad breaks were. It was the *"Experimental, turn this off if videos speed up"* switch, and the speed-ups were real: it fired on scene cuts, b-roll and product demos, so it fast-forwarded through programme and then seeked you back. **A guess that is wrong often enough to need a warning label is not a feature.** Ads are found by asking the player, which is exact. Removing it also removed the reason the YouTube smooth-playback switch existed — there is no per-frame readback left to switch off — so that switch is gone too, and YouTube is simply fast now.

**The HLS/DASH manifest rewriter and the YouTube player-JSON prune** (`src/manifest.js`) — monkey-patched `window.fetch`, `XMLHttpRequest.prototype` and `JSON.parse` on every page. The manifest rewriter's XHR gate was one of the things breaking YouTube, and neither earned the risk of patching three globals site-wide.

**Cosmetic 'stealth' mode** — used `visibility:hidden` to keep an element's box for layout-probe anti-adblock checks. It left a hole on the page in exchange for defeating a kind of check the sites that matter here do not run, and it was one more switch to get wrong.

**Four dead YouTube selectors in `cosmetic.js`** — a type selector for a tag that does not exist, a selector with a declaration block already attached (so `insertRule()` got `{...}{...}`, threw, and was silently dropped), a class *attribute value* used as a selector, and another nonexistent tag. The patch was inert. They were not replaced with working selectors either: hiding `#error-screen` leaves a black player behind and swallows real messages. `yt-recover.js` reads the error instead.

**The seek-to-`duration - 0.1` last resort in `sites.js`** — this was the black-screen player. `skip()` is called five times a second for as long as the ad flag is up, and it re-issued the same seek every time without checking whether the previous one took. Traced against a real element: eleven identical seeks in 2.2 s, the clock snapping back between each. On an MSE-backed player that resets the video decoder five times a second, so no frame is ever presented — a black picture — while the audio pipeline keeps draining, so the sound carries on. Hammered like that, the player paints its own opaque error overlay, which swallows mouse clicks while the spacebar still works. That was the whole symptom.

`engine.js` and `manifest.js` are still in `src/` but are not referenced by the manifest and are not loaded. They are dead code kept for reference.

---

## Popup

- **Protection on** — master switch, with a line naming what is on regardless
- **Page ads** — three switches
- **Video players** — three switches
- **How this behaves on YouTube** — a collapsible panel spelling out skippable vs non-skippable vs sponsor segments, so nobody has to guess which switch to try
- **This site** — rulesets live, rules loaded, requests stopped here, elements hidden here, ruleset problem, turn off for this site
- **Video players here** — state, player ads handled, SponsorBlock skips, DVR breaks skipped, time skipped

UI is 19–30 px, light slate on dark with amber headings. The badge shows the running total of player ads handled, DOM skips, SponsorBlock skips, DVR skips and manifest cuts for the tab, in green.

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | settings, the local mirror, per-tab session stats |
| `declarativeNetRequest` | the network layer |
| `declarativeNetRequestFeedback` | `getMatchedRules`, for the popup's blocked count and the `[AdVault]` rule-name diagnostic |
| `scripting` | dynamic registration of the uBO scriptlet bundles |
| `activeTab` | the popup's per-tab readout |
| `<all_urls>` | ads are everywhere |

The only network request AdVault makes on its own is the SponsorBlock hash-prefix lookup, and only while that switch is on.

---

## Layout

```
AdVault/
├─ manifest.json
├─ background.js                 service worker: rulesets, cosmetic DBs, stats, SponsorBlock
├─ popup/
│  ├─ popup.html                 switches + per-tab readout
│  └─ popup.js
├─ src/
│  ├─ settings.js                shared settings + the YouTube start gate
│  ├─ cosmetic.js                page-ad hiding
│  ├─ sites.js                   player ad flags + Skip buttons
│  ├─ content.js                 player layer: mute, advance, SponsorBlock
│  ├─ inject.js                  MAIN world, YouTube only: player probe + loadVideoById
│  ├─ yt-recover.js              black-screen recovery
│  ├─ dvr-skip.js                YouTube TV DVR breaks
│  ├─ adframes.js                ad iframe / empty-slot detection
│  ├─ ubo-procedural.js          uBO procedural cosmetic filtering
│  ├─ engine.js                  removed feature, not loaded
│  └─ manifest.js                removed feature, not loaded
├─ rules/                        6 rulesets, 3 enabled
├─ data/                         cosmetic + uBO selector databases
├─ ubo/                          uBO scriptlet bundles (MAIN + ISOLATED)
├─ web_accessible_resources/     neutered stubs for the redirect rules
└─ icons/
```

---

## Debugging

Filter the page console for `[AdVault]`. The DVR layer logs under `[AdVault/dvr]`.

- `self.__agRejectedSelectors` — hand-written selectors Chrome refused
- popup → **Rule set problem** — ruleset drift against Chrome's static-rule budget
- an overlay over a healthy YouTube stream logs the `declarativeNetRequest` rules that fired on that page, with the filter text spelled out

---

## Credits and licence

Selector data derives from **EasyList**. The procedural filtering engine, the scriptlet bundles and their site rules are ported from **uBlock Origin Lite** by Raymond Hill (GPLv3, https://github.com/gorhill/uBlock), with all YouTube entries removed. Sponsor segment data comes from **SponsorBlock** (https://sponsor.ajay.app).

Because this ships ported uBO code, distribute it under **GPLv3**.
