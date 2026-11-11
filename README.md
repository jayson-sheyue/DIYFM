# DIYFM · Letter Radio

[English](README.md) · [日本語](README.ja.md) · [中文](README.zh-CN.md)

**v2.4.1 fixes multi-speaker voice collapse:** every `Host` and `Guest` turn is now synthesized with isolated single-speaker `voiceConfig` (`host_voice` vs `guest_voice`), per-turn silence trimming, loudness balancing, bounded `429`/`503` retry backoff, and turn-level resume checkpoints — eliminating cases where Gemini multi-speaker TTS read almost an entire episode in a single voice. Both bundled starter channels (**Starter · English Letters** and **Starter · 日本語のお便り**) have also been re-synthesized with verified distinct two-host voices.

**v2.4.0 bundles English and Japanese starter channels:** brand-new installations on Web, Android and Mac open with two finished sample channels (**Starter · English Letters** and **Starter · 日本語のお便り**) — complete with mixed host dialogue, background music, transcripts and expressions — ready to play immediately offline without an API key. Deleting a starter channel never resurrects it, upgrading an existing library keeps your saved channels untouched, and both samples remain available anytime in **Discover**.

**v2.3 adds channel sharing:** export selected finished episodes with public credits, preview ZIP imports, and use Discover to add curated channels locally without a key. [Sharing and curator guide](docs/sharing.md).

**Choose English or Japanese, tell us what you feel like hearing, and listen to two hosts open a fictional letter.**

DIYFM turns language listening into radio you want to return to: self-contained stories, natural conversation and useful expressions recurring in context. It is listening first. You do not need to supply research material, answer quizzes, record your voice, shadow the hosts or maintain a streak.

[Open the public test site](https://jayson-sheyue.github.io/DIYFM/) · [Get a Google AI Studio key](https://aistudio.google.com/apikey) · [API references](docs/api-references.md) · [Verification record](docs/testing.md)

> **The web edition is a static, bring-your-own-key application.** GitHub Pages hosts the application; your browser sends text, speech and music requests directly to Google. Each visitor provides their own key, pays for their own requests and has a separate browser library. Free hosting does not mean free model usage.

## Android and Mac clients

**v2.2.0 adds standalone clients with bundled application resources and native playback/files.** [Client guide and build instructions](docs/clients.md) · [Release downloads](https://github.com/jayson-sheyue/DIYFM/releases).

**v2.3.1 puts listening first on phones:** bottom navigation, a compact channel selector and episodes shown before editing. **New episode** opens production; **Channel options** contains preferences, voices, sharing and deletion. Playback mode/speed are under **Playback settings**, model controls under **Settings → Model settings**, and files under **Settings → Library & files**. Controls retain 48 px touch height and content scrolls independently. Android resizes the actual WebView viewport for system bars, cutouts and the keyboard; rotating back restores the portrait layout.

- **Android:** Android 8+ with a current System WebView; signed APK, foreground media service, background/channel playback and system media controls.
- **Mac:** macOS 13+; Apple Silicon + Intel universal DMG/ZIP, native playback and save/open dialogs. The first test build is ad-hoc signed and **not Apple notarized**; downloaded copies may be blocked by macOS. Apple Silicon is tested; physical Intel Macs are not.
- Saved episodes play offline. Making new episodes still needs internet and your own key. Keys remain in the app's current memory session and clear on exit.
- Each client has an independent local library. Move programs using Settings → Export backup / Import file; no automatic cloud sync. Quit/force-stop interrupts production; keep the app foregrounded while generating on Android.
- MP3 exports include the finished BGM mix. Native exports use the system file dialog. Manual updates use **Download app updates**; Android upgrades must retain the same signing identity and app data.

Developers: `npm run test:mac`, `npm run build:mac`, and (after JDK/SDK setup and one-time `npm run android:signing`) `npm run build:android`. End users only install the packages. See the client guide for signing, storage, update and validation boundaries.

## Features

- English or Japanese; Beginner, Elementary or Advanced; approximately 3, 5, 10 or 15 minutes.
- One lasting channel wish, plus an optional twist for a single episode. No material gathering required.
- Two hosts and an independent fictional letter in each episode, without a long-running cast to remember.
- Browser-based editorial rules: plan → Google Search verification when needed → write → structural checks and review → two-host speech → background music mixing.
- Selectable, previewable voices; selectable and regenerable music, including a voice-only option.
- Progress, failed attempts and retry controls in Messages. Reviewed scripts and compatible completed speech segments can be reused.
- Play, pause, speed controls, repeat one, channel playback, MP3 downloads, scripts and actual search sources.
- Delete channels or individual episodes; export ZIP backups and merge imports. Clearing previews does not delete finished episodes.

## Interface language

The first visit uses **English**, regardless of your operating system or browser language. Open **Settings → Interface language** to choose **English / 日本語 / 中文**. Your explicit choice is saved in the current browser and restored after refreshing. Switching takes effect immediately without refreshing, clearing your key, interrupting production or resetting the player.

The interface and listening languages are independent: you can use a Japanese interface to listen to English, for example. Wishes, existing titles and scripts keep their original text. New episodes capture the interface language for their supporting metadata when production starts; retries retain that choice. Switching does not translate saved works or generate additional model requests. Missing interface translations fall back to English.

## First use

1. Open the test site and go to **Settings**. Get your own Gemini API key from Google AI Studio.
2. Paste it into **Your API key**, then click **Enable key for this page**. The field clears; the UI shows only whether a key is enabled.
3. Optionally click **Check key**. This reads metadata for the selected text model without generating content. It does not verify speech or music access.
4. Return to **Listen**, choose the listening language and describe a wish, such as: “Funny misunderstandings between roommates, lighthearted and in easy English.”
5. The defaults are Elementary and about 5 minutes. Expand **Voices & background music** to choose and preview the two hosts and music before your first episode.
6. Click **Make my first episode**. You may switch views inside the app and check Messages, but keep the webpage open.
7. When ready, play the episode, download its MP3, or open **Script & episode details** for expressions, input and returned search sources.

Refreshing, closing or leaving clears the key, so you will need to enter it again. **Saved channels and audio remain.** Opening the page, reading scripts, replaying and importing/exporting do not call generation models. Production, first previews and explicit regeneration send requests subject to Google's pricing, quota and regional rules.

New AI Studio authorization keys, including those beginning with `AQ.`, are accepted without guessing their service from the prefix. The public application connects only to the **Gemini Developer API**. **Vertex AI Express Mode is not integrated**; it requires different endpoints and capability handling. Use a key authorized for the Generative Language API.

### Models

| Function                                       | Default model                  | API                                                      |
| ---------------------------------------------- | ------------------------------ | -------------------------------------------------------- |
| Planning, verification, writing and review     | `gemini-3.8-flash`             | Gemini `generateContent`; Google Search for verification |
| Two-host speech and voice previews             | `gemini-3.1-flash-tts-preview` | Gemini `generateContent` with audio output               |
| Approximately 30 seconds of instrumental music | `lyria-3-clip-preview`         | Gemini Interactions with `store: false`                  |

Model IDs are editable. Availability depends on your key, region, billing and model capabilities; the application does not silently substitute models. Legacy Vertex `lyria-002` is not compatible with the AI Studio endpoint. A music model supported by the Developer API, such as `lyria-3.5`, may have different duration and costs. Music failure keeps the voice-only episode and shows a notice. Content or speech failure is not presented as a finished episode.

### Playback and management

- **Repeat one** repeats the current episode.
- **Play channel** follows the displayed order of ready episodes within that channel, wraps to the first after the last, and skips failed or unfinished records.
- Change the mode above the episode list or in the bottom player. The controls stay synchronized and the browser remembers your choice. Speed carries across episodes; pausing or stopping does not resume automatically.
- Voice and music previews play once and never enter the channel queue.
- MP3 downloads are encoded from the same finished audio used by the player, including its mixed background music. The cache is verified against that audio; old or imported unverified MP3s are rebuilt locally. No model request is needed. A voice-only episode or one made with **No background music** remains voice-only.
- If the browser cannot start the MP3 Worker, encoding automatically falls back to small batches in the page. Keep the page open until the download starts; no audio or key is sent to an external conversion service.
- **Delete episode** keeps channel preferences and other letters. **Delete channel** removes all its records and audio. Both ask for confirmation, cannot be undone, and can be preceded by a backup. Conflicting deletion is refused during channel production or MP3 preparation.

## Key, privacy and data boundaries

- Your key stays in this page's JavaScript memory. It is not written to `localStorage`, `sessionStorage`, IndexedDB, URLs, logs, ZIP backups, the repository or build artifacts.
- Requests go only to the fixed `https://generativelanguage.googleapis.com` origin, with the key in an `x-goog-api-key` header. There is no arbitrary credential-carrying proxy address and API redirects are rejected.
- Provider errors use sanitized messages rather than raw response bodies that might contain sensitive data.
- There are no analytics, advertising or third-party CDN scripts. MP3 and ZIP libraries are hosted with the site; a content security policy restricts script and network sources.
- This does not hide a shared key in frontend code. The visitor, developer tools, authorized extensions and a compromised page environment can still access runtime credentials. Use a trusted device, site and browser environment; restrict the key in Google, monitor usage, set budget alerts and revoke leaked keys promptly.
- Google receives your wish, scripts needed for generation and associated requests under its own terms. This site does not replace Google's data or billing policies.
- Channels, scripts, audio, music and ordinary model settings are stored in this origin's IndexedDB. Drafts, interface language, playback mode and message read state use local browser storage. Clearing site data, leaving private browsing or storage eviction can lose them: export backups.
- Different browsers, devices, `localhost` versus `127.0.0.1`, and local versus Pages sites have independent libraries. Pages projects under the same GitHub account share an origin; browser storage is not a secret vault isolated from those projects.
- There is no account system, server-side library or cross-device sync. Other visitors cannot browse your local library through this application. **Your local `data/` directory and existing recordings are not published to GitHub.**

Additional details: [security notes](docs/security.md).

## Saving, retrying and backups

Each production task captures preferences, listening language, metadata language, models and the current key. Changing settings during a task does not change its inputs. Clearing the key blocks new tasks; submitted tasks may continue with their original in-memory snapshot until completion or failure.

Failed attempts remain in Messages. A retry uses the original input and reuses saved plans, research, reviewed scripts and compatible voice segments where available. It uses current model settings; incomplete or incompatible stages still need new service calls.

- **Export backup** includes channels, scripts, completed audio, music, production segments and ordinary model settings. It excludes keys and voice-preview cache.
- **Import file** merges channels with new IDs, without replacing existing works or your current models/key. Invalid manifests and missing completed audio reject the import without replacing the library.
- ZIP import/export is limited to 500 MB to control browser memory. For larger libraries, download individual MP3s and organize them in batches.
- Refreshing or closing interrupts production. Reopening marks tasks without a surviving executor as interrupted and does not automatically resume paid generation. Browser throttling, sleep and network outages can also affect completion.

## Run the static application locally

Use a modern browser and Node.js 22+ for installation, tests and building. Any static HTTP server will do. The primary application needs no ADC, GCP project ID, Python backend or shared key deployment.

```bash
git clone https://github.com/jayson-sheyue/DIYFM.git
cd DIYFM
npm ci --ignore-scripts
npm run vendor
npm test
npm run build

# One option, if Python is already installed:
python3 -m http.server 5055 --directory dist
```

Open `http://localhost:5055/`. Do not double-click `index.html` using `file://`; ES modules, IndexedDB and Workers require a normal web origin. Choose another port if 5055 is occupied.

### Legacy Python library

The Flask/Vertex sources remain for legacy compatibility. The main static application does not use their ADC generation endpoints. Migration does not delete `data/` or add it to Git.

An existing legacy environment can still run `app.py`, whose root redirects to `/static/index.html`. Only at this explicit local path does the browser attempt to copy legacy channels, scripts and completed audio into its library, without calling Google or changing the original files. Keep a copy of `data/` first; failed reads leave the original library intact.

You can also **Import file** using a ZIP exported by the old version. Migration never copies ADC credentials or treats legacy Vertex configuration as Developer API configuration. Unfinished records remain available for inspection; cross-version imports do not guarantee reuse of every intermediate stage.

## Deploy to GitHub Pages

The included `.github/workflows/pages.yml` checks pull requests, then builds `dist/` and deploys pushes to `main`.

1. Create a public repository in your GitHub account and push the source.
2. Under **Settings → Pages → Build and deployment → Source**, choose **GitHub Actions**.
3. Run the workflow or push to `main`; wait for **Check and deploy DIYFM** to succeed.
4. Open `https://<account>.github.io/<repository>/`. Relative resources support project subpaths.

**No Gemini repository Secret is needed.** Never inject a shared key into Actions variables, build arguments or frontend configuration: that would expose it in the public site. A service funded by the owner needs a separate backend with access control and usage limits; Pages cannot conceal its key.

## Source layout

```text
static/
  app.js / app.css / index.html    UI, playback, messages and management
  app-entry.mjs                   Static startup and local migration boundary
  i18n.mjs / messages.mjs          Three UI languages, preference and messages
  browser-api.mjs / library.mjs    Tasks, IndexedDB, backup and compatibility
  harness.mjs / editorial.mjs      Editorial rules, planning and review
  gemini.mjs                      Memory-only key and fixed-origin Google API
  audio.mjs / mp3-worker.js        Decode, mix, WAV and MP3
  vendor/                         Self-hosted encoding/ZIP libraries and licenses
scripts/build-pages.mjs            Static artifact and credential-pattern check
tests/                            Controlled API, storage, media and race tests
```

A featured expression does not mean the listener has mastered it. Learning outcomes, model facts and pronunciation are not guaranteed. Episode lengths are editorial targets; the actual duration is the audio's duration. Search failure never fabricates sources, editorial review allows at most one revision, and speech batches reduce the cost of restarting an incomplete task.

## Checks and current limits

```bash
npm test            # Static rules, credentials, storage, backup, i18n and playback races
npm run build       # Build dist and scan known credential patterns
./scripts/check.sh  # Also checks legacy Python paths; requires Python dependencies
```

Automated tests are not a substitute for real Google account integration. Actual environments, calls and unverified items are recorded in [the verification report](docs/testing.md). Account access, region, paid tier, quota and model lifecycle are controlled by Google. A successful key check does not prove every model or Search is available. Downloads, background execution, storage and media behavior also vary by browser.

Some detailed developer documents are currently in Chinese. All three READMEs cover the same setup, configuration, security boundaries and known limits.

See [THIRD_PARTY.md](THIRD_PARTY.md) for bundled code and licenses. This public repository is available for inspection and testing; no additional project license has been chosen. Third-party components retain their own licenses.
