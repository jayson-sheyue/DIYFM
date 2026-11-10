import {
  mkdir,
  readFile,
  writeFile,
  cp,
  rm,
  copyFile,
  chmod,
  access,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
const root = resolve(new URL("..", import.meta.url).pathname);
process.chdir(root);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} exited with ${result.status}`);
};
const dirty = spawnSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).stdout.trim();
const revision =
  (spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim() || "source") + (dirty ? "-dirty" : "");
const output = join(root, "build", "clients");
await mkdir(output, { recursive: true });
if (!existsSync("dist/index.html")) throw Error("Run npm run build first.");
const mac = process.argv.includes("--mac"),
  android = process.argv.includes("--android");
if (!mac && !android) throw Error("Choose --mac and/or --android.");
if (mac) {
  if (process.platform !== "darwin")
    throw Error("The macOS build requires macOS command-line developer tools.");
  const app = join(output, "DIYFM.app"),
    contents = join(app, "Contents");
  await rm(app, { recursive: true, force: true });
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"), { recursive: true });
  await cp("dist", join(contents, "Resources", "web"), { recursive: true, filter: source => !source.replaceAll("\\", "/").includes("catalog/packages") });
  for (const arch of ["arm64", "x86_64"]) {
    run("xcrun", [
      "swiftc",
      "-swift-version",
      "5",
      "-O",
      "-target",
      `${arch}-apple-macos13.0`,
      "-module-cache-path",
      join(root, "build", "swift-cache"),
      ...[
        "LocalServer.swift",
        "NativeFiles.swift",
        "NativePlayer.swift",
        "main.swift",
      ].map((name) => join("clients/macos", name)),
      "-o",
      join(root, "build", `DIYFM-${arch}`),
      "-framework",
      "AppKit",
      "-framework",
      "WebKit",
      "-framework",
      "AVFoundation",
      "-framework",
      "MediaPlayer",
      "-framework",
      "Network",
    ]);
  }
  run("xcrun", [
    "lipo",
    "-create",
    join(root, "build", "DIYFM-arm64"),
    join(root, "build", "DIYFM-x86_64"),
    "-output",
    join(contents, "MacOS", "DIYFM"),
  ]);
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleName</key><string>DIYFM</string><key>CFBundleDisplayName</key><string>DIYFM</string>
<key>CFBundleIdentifier</key><string>io.github.jaysonsheyue.diyfm</string><key>CFBundleExecutable</key><string>DIYFM</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${pkg.version}</string><key>CFBundleVersion</key><string>${pkg.version}</string><key>DIYFMSourceRevision</key><string>${revision}</string>
<key>CFBundleIconFile</key><string>AppIcon</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`;
  await writeFile(join(contents, "Info.plist"), plist);
  run("xcrun", [
    "swift",
    "-module-cache-path",
    join(root, "build", "swift-cache"),
    "clients/macos/Icon.swift.txt",
    join(root, "build", "DIYFM.iconset"),
  ]);
  run("iconutil", [
    "-c",
    "icns",
    join(root, "build", "DIYFM.iconset"),
    "-o",
    join(contents, "Resources", "AppIcon.icns"),
  ]);
  await writeFile(
    join(contents, "Resources", "build.json"),
    JSON.stringify({ version: pkg.version, revision }, null, 2),
  );
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const archive = join(output, `DIYFM-${pkg.version}-mac-universal.zip`);
  await rm(archive, { force: true });
  run("ditto", ["-c", "-k", "--keepParent", app, archive]);
  const imageRoot = join(root, "build", "dmg-root");
  await rm(imageRoot, { recursive: true, force: true });
  await mkdir(imageRoot, { recursive: true });
  await cp(app, join(imageRoot, "DIYFM.app"), { recursive: true });
  run("ln", ["-s", "/Applications", join(imageRoot, "Applications")]);
  const dmg = join(output, `DIYFM-${pkg.version}-mac-universal.dmg`);
  await rm(dmg, { force: true });
  run("hdiutil", [
    "create",
    "-volname",
    `DIYFM ${pkg.version}`,
    "-srcfolder",
    imageRoot,
    "-ov",
    "-format",
    "UDZO",
    dmg,
  ]);
  console.log("macOS universal app, ZIP and DMG:", output);
}
if (android) {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    join(homedir(), "Library/Android/sdk");
  const java =
    process.env.JAVA_HOME ||
    [
      "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
      "/usr/lib/jvm/java-17-openjdk-amd64",
    ].find(existsSync);
  if (!java || !existsSync(join(sdk, "platforms/android-36")))
    throw Error(
      "Android requires JDK 17 and Android SDK platform 36. See docs/clients.md.",
    );
  const signing = join(root, "clients/android/.signing/signing.properties");
  if (!existsSync(signing))
    throw Error(
      "Create your private Android signing key with npm run android:signing first.",
    );
  run(
    join(root, "clients/android/gradlew"),
    ["--no-daemon", ":app:assembleRelease"],
    {
      cwd: join(root, "clients/android"),
      env: {
        ...process.env,
        JAVA_HOME: java,
        ANDROID_HOME: sdk,
        DIYFM_BUILD_REVISION: revision,
      },
    },
  );
  const apk = join(output, `DIYFM-${pkg.version}-android.apk`);
  await copyFile(
    "clients/android/app/build/outputs/apk/release/app-release.apk",
    apk,
  );
  run(join(sdk, "build-tools/35.0.0/apksigner"), ["verify", "--verbose", apk], {
    env: { ...process.env, JAVA_HOME: java },
  });
  console.log("Android signed APK:", apk);
}
