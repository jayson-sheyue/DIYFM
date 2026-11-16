# Channel packages and the curated catalog

DIYFM 2.3 adds the same sharing workflow to the website, Android and Mac. No account, shared API key, upload service or P2P listener is added. Windows and iOS clients are not part of this release; the versioned data format is available for future clients to implement.

## Share one channel

Open a saved channel and choose **Channel options → Share channel**. Select 1–50 finished episodes, enter a public creator credit and usage terms, and optionally add an HTTPS source link and public description. **Save channel package** saves a ZIP using the browser download or native save dialog. It never uploads the channel. If no finished episode exists, sharing is disabled.

The package contains only the selected finished mixed WAVs (including their existing BGM), scripts, expressions, references and public credits. Private wishes, per-episode inputs, drafts, incomplete records, raw speech/music intermediates, model settings, keys and unrelated channels are excluded. Audio is copied without regeneration or re-encoding. The v1 limit is 100 MiB including the archive, with PCM 16-bit WAV audio; select fewer episodes if needed. Channels imported from older versions must have a readable finished WAV to be shared.

Creator credits and usage terms are supplied by the sharer. They are **not verified identity, a security certificate or an automatic grant of redistribution rights**. Review them before reusing content. Re-sharing an imported episode retains its original source credit and identifies the new sharer separately. Publishing a channel does not publish your local library.

## Preview and save locally

Choose **Discover → Import channel package** or **Settings → Import file** and select a ZIP. Both new channel packages and existing whole-library backups are supported. The preview shows channels, episodes, size, available credits and scripts. Nothing is written before confirmation. Close the preview to cancel.

After **Add to library**, finished audio and metadata are saved atomically to this device's library. Ordinary model settings, keys and existing channels remain unchanged. The channel opens immediately and can be played offline without a Google key. This does not imply that reopening an uncached web application itself works without a network; native clients bundle the application resources.

Importing the same normalized channel package again opens the saved copy, including across concurrent tabs. A different package version is a separate snapshot, not an overwrite or automatic subscription update. Deleting a saved channel allows a later explicit import to add it again. Full backups retain their existing merge-with-new-IDs behavior; they are not deduplicated as public packages.

Imported credits and descriptions survive whole-library backup/restore. Existing backups without credits still work. Old DIYFM versions cannot import the new channel-package format; use 2.3 or later on all receiving devices, or retain a whole-library backup for older clients.

## Discover curated channels & built-in starters

**Discover** reads a data-only catalog from the official GitHub Pages site. Filter by English or Japanese, inspect credits and usage terms, and choose **Preview** or **Add to library**. The latter is a one-click download/check/save action; it needs no key. Downloads can be cancelled before saving. A failed network or integrity check leaves the library unchanged. Refresh failures keep any already-loaded entries visible with an error, and locally saved programs remain usable offline.

Starting in **v2.4.0**, the curated catalog ships two reviewed starter packages (`show_starter_en` — *Starter · English Letters*, and `show_starter_ja` — *Starter · 日本語のお便り*) containing fictional listener letters, AI-synthesized voices/music, transcripts and expressions, with all private inputs and internal tokens stripped. Both packages are also bundled inside the Android and macOS installers:

- **Brand-new install:** When the local library is empty and has never been seeded (`starter-seeded` not set), DIYFM verifies and seeds the bundled starter channels once so listeners can press Play immediately offline without an API key.
- **No resurrection & safe upgrades:** Deleting one or both starter channels never re-adds them on reload/restart. Upgrading an existing installation that already has saved channels sets `starter-seeded` without injecting starter channels into the user's library.
- **Offline native fallback:** Native clients check the live GitHub Pages catalog first when online (and reuse verified local bundle bytes when a listed package's SHA-256 matches the bundled copy), and fall back to the bundled local catalog when offline so deleted starter channels can still be previewed or re-added without a network connection.

Local synthetic QA fixtures and private user libraries are never published. Catalog/package requests omit credentials and referrers, reject redirects, and accept packages only from the catalog's own `packages/` directory. Native CSP permits only the existing Google API plus the official catalog path and local bundle origin; management/file bridges retain their original local-origin restrictions.

## Submit a channel for Discover

Listeners cannot publish to the catalog from inside the application; there is still no account, upload service or automatic listing. To propose a channel, save a channel package as described above, then choose **Discover → Submit your channel**. The link opens the repository's [channel submission form](https://github.com/jayson-sheyue/DIYFM/issues/new?template=channel-submission.yml) in your browser, outside DIYFM, and needs a GitHub account.

- **Submissions are public.** The issue and anything attached to it can be read and downloaded by anyone before any review, so include only content you may distribute and nothing private.
- Attach the ZIP to the form if it is 25 MB or smaller, GitHub's limit for issue attachments. For a larger package, up to the 100 MiB format limit, provide an HTTPS download link instead. Creator credit and usage terms are already inside the package from **Share channel**; the form does not ask for them again.
- A maintainer listens to the audio and reads credits and usage terms from the package before listing anything. A submission may be declined.
- **Same-channel updates:** Re-export the same DIYFM channel (stable `channel.id`) with the episodes you want listed, submit again, and after `channel-approved` the catalog **replaces** that channel’s previous Discover snapshot. Listeners still see one curated card; people who already added an older snapshot keep that local copy until they import the new package explicitly.

## Curator publishing workflow

1. Start from a **channel package**, not a whole-library backup, received through the [submission form](https://github.com/jayson-sheyue/DIYFM/issues/new?template=channel-submission.yml) or directly from the creator. Download an attached package from the issue, or from the HTTPS link it gives. Obtain permission, inspect credits and any BGM/source restrictions, and listen to the finished audio. Clearly disclose AI synthesis and fictional material as appropriate.
2. **Preferred:** on the submission issue, add the `channel-approved` label (requires repository write access). The [List approved channel](../.github/workflows/list-channel.yml) workflow downloads the ZIP, validates it with the same rules as `scripts/catalog.mjs`, commits `static/catalog/` to `main`, deploys Pages in the same run (because `GITHUB_TOKEN` pushes do not re-trigger the Pages workflow), comments on the issue, and adds `channel-listed`. Remove `channel-approved` and add it again to retry.
3. **Manual fallback** (offline package, or when you prefer a local review commit):

   ```bash
   node scripts/catalog.mjs add /absolute/path/to/diyfm-channel.zip
   node scripts/catalog.mjs check
   npm test
   npm run build
   ```

   Review `static/catalog/index.json` and `static/catalog/packages/`, then commit and push `main`. The script derives listing metadata from the validated package and names it by its SHA-256. Adding a revised package for the same `channel.id` replaces that channel's catalog listing and removes the previous unreferenced ZIP; existing local listener snapshots are retained. The `channel-approved` Action comments whether the run was a new listing or an update.
4. After Pages updates, check **Preview** / **Add to library** on the site or a native client. Keep the catalog small and curated to stay within the static host's repository/bandwidth limits.

To unlist a channel, remove its entry from `static/catalog/index.json`, validate and publish. Already-downloaded copies cannot be remotely recalled. Unreferenced old packages can be removed in a separate reviewed change; keep a private archival copy if needed.

## Format and verification boundaries

Each ZIP has `channel.json` (`format: diyfm-channel`, `version: 1`) and exactly the referenced `audio/<episode-id>.wav` files. The manifest has an allowlisted public channel record, attribution, and episode records with audio byte counts and SHA-256 values. No remote scripts, arbitrary filesystem paths or external audio URLs are accepted. A canonical manifest hash identifies the imported snapshot; archive hashes separately verify catalog downloads. Credits can still be false and a valid hash does not make arbitrary content trustworthy.

The catalog uses `format: diyfm-catalog`, `version: 1` and a `channels` array. Each entry repeats the public channel metadata, attribution, episode count, package path, compressed byte count and SHA-256. Builds validate each listed package against the listing, and native Mac/Android installers bundle the validated `catalog/` directory for offline first-launch seeding and Discover fallback.

See [verification notes](testing.md) for executed tests and platform limitations. Relevant APIs: [Fetch credentials](https://developer.mozilla.org/en-US/docs/Web/API/Request/credentials), [SubtleCrypto digest](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest), [HTML dialog](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element), and the bundled [fflate 0.8.2 ZIP implementation](https://github.com/101arrowz/fflate/tree/v0.8.2).
