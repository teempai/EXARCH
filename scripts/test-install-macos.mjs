import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installHome = await mkdtemp(join(tmpdir(), "exarch-installer-test-"));
const nodePath = process.execPath;
const fixtureHelper = join(repositoryRoot, "services/daemon/src/fixtures/secret-store-helper.mjs");
const secretDirectory = join(installHome, "test-secrets");

try {
  await mkdir(secretDirectory, { mode: 0o700 });
  await run(nodePath, [
    join(repositoryRoot, "scripts/install-macos.mjs"),
    repositoryRoot,
    nodePath
  ], {
    ...process.env,
    EXARCH_INSTALL_HOME: installHome,
    EXARCH_KEYCHAIN_HELPER: fixtureHelper,
    EXARCH_TEST_SECRET_DIR: secretDirectory
  });

  // An upgrade must not rerun initialization. A real macOS Keychain may
  // refuse a non-interactive upgrade process even though the already-running
  // service is authorized. Make reads fail here so the test proves the
  // installer preserves the existing configuration without touching secrets.
  await run(nodePath, [
    join(repositoryRoot, "scripts/install-macos.mjs"),
    repositoryRoot,
    nodePath
  ], {
    ...process.env,
    EXARCH_INSTALL_HOME: installHome,
    EXARCH_KEYCHAIN_HELPER: fixtureHelper,
    EXARCH_TEST_SECRET_DIR: secretDirectory,
    EXARCH_TEST_SECRET_FAIL_READ: "1"
  });

  const applicationRoot = join(installHome, "Library/Application Support/EXARCH");
  const runtime = join(applicationRoot, "runtime");
  const app = join(installHome, "Applications/Exarch Desktop.app");
  const serviceApp = join(app, "Contents/Library/LoginItems/EXARCH Service.app");
  const serviceExecutable = join(serviceApp, "Contents/MacOS/EXARCH Service");
  const launchAgent = join(
    installHome,
    "Library/LaunchAgents/com.teempai.exarch.daemon.plist"
  );
  await assertMode(applicationRoot, 0o700);
  await assertMode(runtime, 0o700);
  await assertMode(join(runtime, "bin/exarch-daemon"), 0o700);
  await assertMode(join(runtime, "bin/exarch-setup"), 0o700);
  await assertMode(join(runtime, "bin/exarch-context"), 0o700);
  await assertMode(join(runtime, "bin/exarch-keychain"), 0o700);
  await assertMode(join(applicationRoot, "config.json"), 0o600);
  if (!(await lstat(join(applicationRoot, "data/context.sqlite"))).isFile()) {
    throw new Error("Encrypted local context was not initialized");
  }
  if ((await readdir(secretDirectory)).length !== 3) {
    throw new Error("Local initialization did not create exactly three core secrets");
  }
  await assertMode(launchAgent, 0o600);
  if (!(await lstat(app)).isDirectory()) throw new Error("Mac app was not installed");
  const appPlist = await readFile(join(app, "Contents/Info.plist"), "utf8");
  if (
    !appPlist.includes("<key>CFBundleExecutable</key>") ||
    !appPlist.includes("<string>Exarch Desktop</string>")
  ) {
    throw new Error("Mac app does not declare its installed executable");
  }
  await assertMode(serviceExecutable, 0o755);
  const servicePlist = await readFile(join(serviceApp, "Contents/Info.plist"), "utf8");
  if (
    !servicePlist.includes("<string>EXARCH Service</string>") ||
    !servicePlist.includes("<string>com.teempai.exarch.service</string>")
  ) {
    throw new Error("Native service does not declare the EXARCH identity");
  }

  const plist = await readFile(launchAgent, "utf8");
  if (
    plist.includes(join(installHome, ".local/bin")) ||
    !plist.includes(`<string>${serviceExecutable}</string>`)
  ) {
    throw new Error("LaunchAgent service path or hardened PATH is incorrect");
  }
  // The service chooses its own child. A LaunchAgent that still names an
  // interpreter would mean the argument-taking build is installed.
  if (plist.includes(`<string>${nodePath}</string>`)) {
    throw new Error("LaunchAgent still passes an executable to the service");
  }
  if (!servicePlist.includes(join(runtime, "bin/exarch-daemon"))) {
    throw new Error("Native service does not seal its daemon launcher path");
  }
  for (const launcher of ["exarch-daemon", "exarch-setup", "exarch-context"]) {
    const contents = await readFile(join(runtime, "bin", launcher), "utf8");
    if (!contents.startsWith("#!/bin/sh\n")) {
      throw new Error(`${launcher} does not use the non-zsh launcher`);
    }
  }
  await run(nodePath, [
    "-e",
    "Promise.all([import('./dist/services/daemon/src/index.js'),import('./dist/services/relay/src/index.js')]).then(() => process.stdout.write('staged modules load\\n'))"
  ], process.env, runtime);
  await run(join(runtime, "bin/exarch-context"), ["help", "--json"], process.env);
  // The sealed launcher is the only child. Stand in a script for it so the
  // supervision checks do not need a configured daemon; the real shim has the
  // same shape.
  const launcher = join(runtime, "bin/exarch-daemon");
  const realLauncher = await readFile(launcher, "utf8");
  await writeFile(launcher, "#!/bin/sh\nprintf 'EXARCH Service child supervision works\\n'\n", { mode: 0o700 });
  await run(serviceExecutable, [], process.env);
  // A caller-supplied executable must be ignored, not run. This is the
  // trampoline the argument-taking build offered every process on the machine.
  await refuseCallerSuppliedChild(serviceExecutable, nodePath);
  await verifySignalForwarding(serviceExecutable, launcher);
  await writeFile(launcher, realLauncher, { mode: 0o700 });
  await rm(launcher);
  await runExpectingExit(serviceExecutable, [], process.env, 64);
  await writeFile(launcher, realLauncher, { mode: 0o700 });
  await run("/usr/bin/plutil", [
    "-lint",
    join(app, "Contents/Info.plist"),
    join(serviceApp, "Contents/Info.plist"),
    launchAgent
  ], process.env);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], process.env);
  process.stdout.write(`macOS staged installer verification passed: ${installHome}\n`);
} finally {
  await chmod(installHome, 0o700).catch(() => undefined);
  await rm(installHome, { recursive: true, force: true });
}

async function assertMode(path, expected) {
  const metadata = await lstat(path);
  if ((metadata.mode & 0o777) !== expected) {
    throw new Error(`${path} mode was ${(metadata.mode & 0o777).toString(8)}, expected ${expected.toString(8)}`);
  }
}

async function run(executable, arguments_, environment, cwd = repositoryRoot) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env: environment,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} failed (${signal ?? code})`));
    });
  });
}

/**
 * The service used to take its child from argv, so any process could spawn the
 * bundle and have an arbitrary binary run as the TCC-responsible process.
 * Nothing on the command line may reach the child now.
 */
async function refuseCallerSuppliedChild(service, node) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(service, [node, "-e", "process.stdout.write('CALLER CHOSE THIS')"], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let text = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.once("error", reject);
    child.once("exit", () => resolve(text));
  });
  if (output.includes("CALLER CHOSE THIS")) {
    throw new Error("EXARCH Service ran an executable named on its command line");
  }
}

async function verifySignalForwarding(service, launcher) {
  await writeFile(
    launcher,
    "#!/bin/sh\ntrap 'exit 42' TERM\nprintf 'ready\\n'\nwhile true; do sleep 1; done\n",
    { mode: 0o700 }
  );
  await new Promise((resolve, reject) => {
    const child = spawn(service, [], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let ready = false;
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", () => {
      ready = true;
      child.kill("SIGTERM");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (ready && code === 42 && signal === null) resolve();
      else reject(new Error(`EXARCH Service signal forwarding failed (${signal ?? code})`));
    });
  });
}

async function runExpectingExit(executable, arguments_, environment, expected) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "ignore", "ignore"]
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal === null && code === expected) resolve();
      else reject(new Error(`${executable} exited ${signal ?? code}, expected ${expected}`));
    });
  });
}
