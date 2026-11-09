# DIYFM native clients

DIYFM provides installable Android and macOS clients. The 2.2.1 release updates Android, Mac and the shared web layout. Both bundle the same reviewed HTML/CSS/JavaScript as the website and use native audio and file APIs. They do not depend on GitHub Pages being online to open the application or replay saved episodes. Generation still requires a network connection and your own Google AI Studio key.

## Install and first use

- **Android:** Android 8.0 / API 26 or later, with an up-to-date Android System WebView supporting WebMessageListener and modern JavaScript. Install `DIYFM-2.2.1-android.apk` using Android's normal package installer. This is a direct-install test build, not a Play Store listing. No microphone, broad storage access, account login or shared model key is required.
- **Mac:** macOS 13 or later. `DIYFM-2.2.1-mac-universal.dmg` contains an Apple Silicon + Intel universal application; copy DIYFM to Applications. A ZIP is provided as an alternative. The initial build has an ad-hoc signature and is **not Apple Developer ID signed or notarized**. macOS may block a downloaded copy; its trust decision remains with the user. Do not disable Gatekeeper or remove quarantine as an installation step. The actual machine tested is Apple Silicon; Intel is cross-compiled but not run on physical Intel hardware.
- Open Settings, choose English / 日本語 / 中文, and enable your own key. First launch always uses English. Generated channels, scripts and audio stay in the client's local library. No key is bundled with either app.
- To move programs from the website, export a backup there, then choose **Settings → Import backup** in the client. The ZIP format is shared; imports merge into the destination library with new IDs. There is no automatic account or cloud sync.

## Phone portrait layout

Phone widths use a compact header and a horizontally scrollable channel strip. The main content scrolls independently while the player stays within the usable viewport. Visible buttons and selectors have at least 48 CSS px touch height. Long translated actions wrap; the Messages icon retains its translated accessible name. Desktop layouts continue to use the side navigation.

Android pads a containing native view for system bars, display cutouts and the IME, so the WebView's actual viewport shrinks instead of drawing under them. When the keyboard is visible on Android 11+, the channel strip and secondary player options collapse to leave editing space, then return after dismissal. Older supported Android versions retain system `adjustResize` behavior; this release's inset/rotation checks ran on API 36, not every older OS or vendor keyboard.

## Native playback and files

The native queue contains finished mixed WAVs, including their background music. Repeat one, channel playback, pause/resume, seeking and speed controls use the same native session as the system media controls. Voice/music previews play once. Deleting an episode also removes it from the native queue; stale preparation results cannot restart a stopped player.

Android uses a Media3 `MediaSessionService` foreground playback service. Audio continues while the Activity is in the background, subject to the system and device manufacturer's policies. System media notifications and lock-screen controls use that session. Back sends the Activity to the background. Force-stopping the app stops playback. Background generation is not guaranteed: keep the app in the foreground while producing an episode; process termination interrupts production and retains completed stages for retry.

On Mac, closing the window hides it while the process and audio keep running. Use its Dock icon or **Window → Show DIYFM** to return; **Quit DIYFM** terminates the process. Quitting during production asks whether to keep running. This does not imply that Google has cancelled an already-submitted model request.

MP3 and ZIP exports use the system's save/create-document dialog, not a browser download workaround. Cancelling leaves the episode intact. Transfers use 192 KiB chunks, validate their final byte count, and commit only complete files. Mac stages the export next to its destination and atomically replaces it; Android writes the selected Storage Access Framework destination after staging is complete. Provider/disk failures are reported and the original program remains in the app. A failing third-party Android document provider can leave a partial destination file; retry the export rather than treating that file as complete.

## Storage and key protection

- Keys remain only in the running application page's memory. They are sent exclusively to the fixed Google HTTPS API in a request header. They never pass through the native file bridge, logs, backups, bundles or signing configuration. Hiding a window or backgrounding the app does not clear an active session; quitting/terminating does.
- Mac keeps its web library in WebKit's app-specific data store. Native playback copies are under `~/Library/Application Support/DIYFM/AudioCache`; incomplete transfers are under `Transfers`. The bundled application serves only static assets over `127.0.0.1:24618`. It binds only loopback, validates Host/path, provides no HTTP library or key endpoint, and refuses to start if that port is occupied. The stable origin preserves the web library across upgrades.
- Android keeps the WebView library in the app's private storage and playback copies in `files/audio-cache`. Its local assets use `https://appassets.androidplatform.net/assets/web/`, with no remote fall-through for missing app assets. Android backup is disabled; uninstalling or clearing app data removes the library, so export a ZIP first.
- Both bridges accept messages only from the trusted main application frame. External HTTPS links open in the system browser; other navigation schemes and arbitrary file paths are rejected. The bridges expose bounded file transfers and media actions, not arbitrary commands or key storage.
- Native audio files are derivatives of the authoritative local library and can be recreated without model calls. Clearing/removing a derivative does not delete the saved episode. Web, Android and Mac libraries are independent.

## Updates and signing identity

This first test release uses manual updates through the existing GitHub repository's Releases page. **Download app updates** is available in client settings; Mac also provides a menu item. It opens the download page and does not execute downloaded software. No automatic installation or OTA validation is claimed.

Replace the Mac application while it is closed, preserving its app identity and user data. Install a newer Android APK over the existing app, using the **same signing key and application ID**. Uninstalling first deletes its private library. The first native release is 2.2.0; 2.2.1 uses the same storage origins, application IDs and Android signing identity. Export a backup before updating. Consult the release verification notes for which actual upgrade paths and devices were exercised; a same-version reinstall is not proof of a future migration.

The Android publisher key is generated locally by `npm run android:signing` under ignored `clients/android/.signing/`. Back up the entire directory securely; losing it prevents compatible APK upgrades. Never commit it, upload it to a release, include it in an APK, or substitute a new key for an already-installed production client. The local key password file has owner-only permissions. A production signing/notarization setup or store publication is a separate distribution step.

## Build from source

End users do not need Node, Java, Python, Gradle or Xcode installed to run the packages. Developers need Node.js 22+ and the following platform tools:

```bash
npm ci --ignore-scripts
npm run vendor
npm test
npm run build

# Mac: macOS command-line developer tools (xcode-select --install).
npm run test:mac
npm run build:mac

# Android: JDK 17, SDK platform 36 and build-tools 35.0.0.
# Set JAVA_HOME and ANDROID_HOME for your installation when needed.
npm run android:signing  # once per publisher identity; preserve the output
npm run build:android
```

The Gradle 8.13 wrapper is pinned and checked against its official distribution SHA-256. Android uses AGP 8.13.2, AndroidX WebKit 1.14.0 and Media3 1.8.0. Mac uses AppKit, WebKit, AVFoundation, MediaPlayer and Network from the system SDK. There is no downloaded runtime on first launch.

Artifacts are written to ignored `build/clients/`: `.app`, universal ZIP/DMG and signed APK. Package versions derive from `package.json`; artifacts record the Git revision, with a `-dirty` suffix for a working-tree build. Build distribution assets from a clean, known commit. Static assets are copied from the same audited `dist/` whitelist as Pages; private browser data and signing material are never included.

Android emulator integration checks (isolated device):

```bash
cd clients/android
./gradlew :app:connectedDebugAndroidTest
# To exercise the signed release candidate with the same publisher key:
./gradlew -PtestBuildType=release :app:connectedReleaseAndroidTest
```

Tests use generated synthetic tones, actual local files and the actual platform player. Google generation is covered by controlled contracts unless a real test key is explicitly provided; synthetic tones are not model-generated speech. See [verification notes](testing.md) for what was actually run and remaining platform limits.

## Official integration references

- [Android window insets and edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
- [Android WebView viewport settings](https://developer.android.com/reference/android/webkit/WebSettings#setUseWideViewPort(boolean))
- [Android local app assets](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)
- [Android WebView messaging](https://developer.android.com/reference/androidx/webkit/WebViewCompat)
- [Media3 background playback](https://developer.android.com/media/media3/session/background-playback)
- [Android Storage Access Framework](https://developer.android.com/guide/topics/providers/document-provider)
- [AGP 8.13 compatibility](https://developer.android.com/build/releases/agp-8-13-0-release-notes)
- [Gradle 8.13](https://docs.gradle.org/8.13/release-notes.html)
- [Apple WKWebView](https://developer.apple.com/documentation/webkit/wkwebview)
- [Apple remote media commands](https://developer.apple.com/documentation/mediaplayer/mpremotecommandcenter)
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
