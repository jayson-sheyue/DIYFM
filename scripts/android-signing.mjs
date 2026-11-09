// Signing keys are local publisher credentials, never repository/build assets.
import { mkdir, writeFile, chmod, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const root = resolve(new URL("..", import.meta.url).pathname);
const directory = join(root, "clients/android/.signing");
if (
  existsSync(join(directory, "release.jks")) ||
  existsSync(join(directory, "signing.properties"))
)
  throw Error(
    "Signing material already exists. Preserve it for compatible future updates.",
  );
await mkdir(directory, { recursive: true, mode: 0o700 });
const java =
  process.env.JAVA_HOME ||
  "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
const password = randomBytes(32).toString("hex");
const result = spawnSync(
  join(java, "bin/keytool"),
  [
    "-genkeypair",
    "-keystore",
    join(directory, "release.jks"),
    "-storetype",
    "PKCS12",
    "-storepass:env",
    "DIYFM_SIGNING_PASSWORD",
    "-keypass:env",
    "DIYFM_SIGNING_PASSWORD",
    "-alias",
    "diyfm",
    "-keyalg",
    "RSA",
    "-keysize",
    "3072",
    "-sigalg",
    "SHA256withRSA",
    "-validity",
    "10000",
    "-dname",
    "CN=DIYFM, OU=Independent Apps, O=DIYFM",
  ],
  {
    env: { ...process.env, DIYFM_SIGNING_PASSWORD: password },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
if (result.status !== 0)
  throw Error(
    "Could not create signing key. Check your JDK and remove only the unsuccessful new signing files before retrying.",
  );
await chmod(join(directory, "release.jks"), 0o600);
await writeFile(
  join(directory, "signing.properties"),
  `storePassword=${password}\nkeyPassword=${password}\n`,
  { mode: 0o600 },
);
console.log(
  "Created local Android signing material. Back up clients/android/.signing securely; never commit or share it.",
);
