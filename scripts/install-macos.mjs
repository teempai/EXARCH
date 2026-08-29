import { spawn } from "node:child_process";
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const [repositoryRoot, nodePath] = process.argv.slice(2);
if (!repositoryRoot || !nodePath) throw new Error("Installer arguments are missing");

const usesDefaultInstallHome = process.env.EXARCH_INSTALL_HOME === undefined;
const installHome = usesDefaultInstallHome
  ? homedir()
  : resolve(process.env.EXARCH_INSTALL_HOME);
if (!isAbsolute(installHome) || installHome === "/") {
  throw new Error("Installer home must be a specific absolute directory");
}
const applicationRoot = join(installHome, "Library", "Application Support", "EXARCH");
const runtimeDestination = join(applicationRoot, "runtime");
const configPath = join(applicationRoot, "config.json");
const logsDirectory = join(applicationRoot, "logs");
const launchAgentsDirectory = join(installHome, "Library", "LaunchAgents");
const launchAgentPath = join(launchAgentsDirectory, "com.teempai.exarch.daemon.plist");
const applicationsDirectory = join(installHome, "Applications");
const appDestination = join(applicationsDirectory, "Exarch Desktop.app");
const previousExarchAppDestination = join(applicationsDirectory, "EXARCH.app");
const serviceRelativeExecutable = join(
  "Contents", "Library", "LoginItems", "EXARCH Service.app",
  "Contents", "MacOS", "EXARCH Service"
);
const serviceExecutable = join(appDestination, serviceRelativeExecutable);
const derivedData = join(repositoryRoot, "native", ".build", "installer-xcode");
const legacyApplicationRoot = join(installHome, "Library", "Application Support", "MobileRemoteAgent");
const legacyLaunchAgentPath = join(launchAgentsDirectory, "com.teempai.mobile-remote-agent.daemon.plist");
const legacyAppDestination = join(applicationsDirectory, "Mobile Remote Agent.app");
const upgradingExistingInstallation = await exists(configPath);

log("verify", "Installing from a local, user-owned checkout");
await run("npm", ["ci"], repositoryRoot);
await run("npm", ["run", "build"], repositoryRoot);
await run("swift", ["build", "-c", "release", "--product", "exarch-keychain"], join(repositoryRoot, "native"));
await run("swift", ["build", "-c", "release", "--product", "exarch-service"], join(repositoryRoot, "native"));
await run(
  "xcodebuild",
  [
    "-project", "EXARCH.xcodeproj",
    "-scheme", "EXARCHMac",
    "-configuration", "Release",
    "-destination", "platform=macOS",
    "-derivedDataPath", derivedData,
    "CODE_SIGNING_ALLOWED=NO",
    "build"
  ],
  join(repositoryRoot, "native")
);

const stagingParent = await mkdtemp(join(tmpdir(), "exarch-install-"));
const stagedRuntime = join(stagingParent, "runtime");
await mkdir(stagedRuntime, { recursive: true, mode: 0o700 });
await cp(join(repositoryRoot, "dist"), join(stagedRuntime, "dist"), { recursive: true });
await cp(join(repositoryRoot, "package.json"), join(stagedRuntime, "package.json"));
await cp(join(repositoryRoot, "package-lock.json"), join(stagedRuntime, "package-lock.json"));
await run("npm", ["ci", "--omit=dev"], stagedRuntime);
await mkdir(join(stagedRuntime, "bin"), { recursive: true, mode: 0o700 });
await cp(
  join(repositoryRoot, "native", ".build", "release", "exarch-keychain"),
  join(stagedRuntime, "bin", "exarch-keychain")
);
await chmod(join(stagedRuntime, "bin", "exarch-keychain"), 0o700);
await writeLauncher(stagedRuntime, "exarch-daemon", "dist/services/daemon/src/main.js", nodePath);
await writeLauncher(stagedRuntime, "exarch-setup", "dist/apps/setup-cli/src/main.js", nodePath);
await writeLauncher(stagedRuntime, "exarch-context", "dist/apps/context-cli/src/main.js", nodePath);

// Finish and validate the complete signed application before interrupting the
// currently running service. A build, embed, or signing failure therefore
// leaves the existing installation online and untouched.
const builtApp = join(derivedData, "Build", "Products", "Release", "Exarch Desktop.app");
const builtService = join(repositoryRoot, "native", ".build", "release", "exarch-service");
await lstat(builtApp);
await lstat(builtService);
const stagedApp = join(stagingParent, "Exarch Desktop.app");
await cp(builtApp, stagedApp, { recursive: true });
await embedService(stagedApp, builtService);
await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stagedApp], repositoryRoot);

// A healthy installation must prove that its existing helper can still reach
// every startup credential before we interrupt it. If the service was already
// offline, the new foreground recovery UI is allowed to repair it after the
// files are installed; there is no healthy process for this installer to harm.
if (upgradingExistingInstallation && await currentServiceIsHealthy()) {
  await verifyCurrentCredentials();
}

const launchAgentBackup = join(stagingParent, "launch-agent.plist");
const hadLaunchAgent = await exists(launchAgentPath);
if (hadLaunchAgent) await cp(launchAgentPath, launchAgentBackup);
let runtimeBackup = null;
let appBackup = null;
let runtimeReplaced = false;
let appReplaced = false;
let launchAgentWritten = false;

try {
  await runLaunchctl(["bootout", `gui/${process.getuid()}`, launchAgentPath], true);
  await migrateLegacyInstallation();
  await migrateCurrentDesktopName();
  await migrateLegacyKeychain(stagedRuntime);
  await mkdir(applicationRoot, { recursive: true, mode: 0o700 });
  await chmod(applicationRoot, 0o700);
  await preserveTrustedKeychainHelper(stagedRuntime);
  runtimeBackup = await replaceRecoverably(stagedRuntime, runtimeDestination);
  runtimeReplaced = true;
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 });
  await mkdir(applicationsDirectory, { recursive: true, mode: 0o700 });
  appBackup = await replaceRecoverably(stagedApp, appDestination);
  appReplaced = true;
  await writeFileAtomically(
    launchAgentPath,
    launchAgent(serviceExecutable, configPath, logsDirectory),
    0o600
  );
  launchAgentWritten = true;
  if (upgradingExistingInstallation) {
    log("preserve", "Existing encrypted configuration, pairing, and Keychain credentials retained");
  } else {
    await run(
      join(runtimeDestination, "bin", "exarch-setup"),
      ["initialize", "--config", configPath, "--data-dir", join(applicationRoot, "data")],
      repositoryRoot
    );
  }
  if (usesDefaultInstallHome) {
    await runLaunchctl(["bootstrap", `gui/${process.getuid()}`, launchAgentPath]);
    await runLaunchctl(["kickstart", "-k", `gui/${process.getuid()}/com.teempai.exarch.daemon`]);
    log("service", "EXARCH service started; phone pairing is available in the client");
  } else {
    log("service", "Isolated installation initialized without changing the active user service");
  }
  await pruneBackups(runtimeDestination, 1);
  await pruneBackups(appDestination, 1);
  log("complete", `Open ${appDestination}`);
} catch (error) {
  log("rollback", "Installation failed; restoring the previous EXARCH application and service");
  await runLaunchctl(["bootout", `gui/${process.getuid()}`, launchAgentPath], true);
  if (appReplaced) await restoreReplacement(appDestination, appBackup);
  if (runtimeReplaced) await restoreReplacement(runtimeDestination, runtimeBackup);
  if (launchAgentWritten) {
    if (hadLaunchAgent) await cp(launchAgentBackup, launchAgentPath);
    else await rm(launchAgentPath, { force: true });
  }
  if (usesDefaultInstallHome && hadLaunchAgent) {
    await runLaunchctl(["bootstrap", `gui/${process.getuid()}`, launchAgentPath], true);
    await runLaunchctl(["kickstart", "-k", `gui/${process.getuid()}/com.teempai.exarch.daemon`], true);
  }
  throw error;
}

async function migrateLegacyKeychain(stagedRuntime) {
  if (!(await exists(configPath))) return;
  const legacyHelper = await findLegacyKeychainHelper();
  if (legacyHelper === null) return;

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const prefix = config?.secretAccountPrefix;
  if (typeof prefix !== "string" || !/^[A-Za-z0-9._-]{1,160}$/.test(prefix)) {
    throw new Error("Existing secret account prefix is invalid");
  }
  const destinationHelper = join(stagedRuntime, "bin", "exarch-keychain");
  for (const suffix of ["database-key", "context-capability", "host-transport", "host-relay-access"]) {
    await pipeSecret(legacyHelper, destinationHelper, `${prefix}.${suffix}`);
  }
  log("migrate", "Existing Keychain credentials copied to the EXARCH service namespace");
}

/**
 * Generic-password Keychain items created by an unsigned prototype helper are
 * authorized to that helper's exact code identity. Rebuilding the same source
 * produces a new ad-hoc identity, so replacing the helper would strand the
 * existing encrypted database and pairing secrets. Preserve the already
 * authorized helper bytes across runtime upgrades; keep the newly built helper
 * beside it for a future explicit, in-memory credential migration. Copying
 * rather than moving also leaves the prior runtime complete for rollback.
 */
async function preserveTrustedKeychainHelper(stagedRuntime) {
  if (!(await exists(configPath))) return;
  const trusted = join(runtimeDestination, "bin", "exarch-keychain");
  if (!(await exists(trusted))) return;
  const staged = join(stagedRuntime, "bin", "exarch-keychain");
  await rename(staged, `${staged}.next`);
  await cp(trusted, staged);
  await chmod(staged, 0o700);
  log("keychain", "Existing trusted helper preserved; rebuilt helper staged as exarch-keychain.next");
}

async function findLegacyKeychainHelper() {
  if (!(await exists(applicationRoot))) return null;
  const runtimeNames = (await readdir(applicationRoot))
    .filter((entry) => entry === "runtime" || entry.startsWith("runtime.previous-"))
    .sort()
    .reverse();
  for (const runtimeName of runtimeNames) {
    const helper = join(applicationRoot, runtimeName, "bin", "mra-keychain");
    if (await exists(helper)) return helper;
  }
  return null;
}

async function pipeSecret(sourceHelper, destinationHelper, account) {
  await new Promise((resolve, reject) => {
    const source = spawn(sourceHelper, ["get", account], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env
    });
    const destination = spawn(destinationHelper, ["put", account], {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env
    });
    source.stdout.pipe(destination.stdin);
    let sourceCode;
    let destinationCode;
    const finish = () => {
      if (sourceCode === undefined || destinationCode === undefined) return;
      if (sourceCode === 0 && destinationCode === 0) resolve();
      else reject(new Error("Existing Keychain credential migration failed"));
    };
    source.once("error", reject);
    destination.once("error", reject);
    source.once("exit", (code) => { sourceCode = code; finish(); });
    destination.once("exit", (code) => { destinationCode = code; finish(); });
  });
}

async function currentServiceIsHealthy() {
  try {
    const statusPath = join(applicationRoot, "data", "runtime-status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    if (status?.state !== "online" || !Number.isInteger(status?.pid) || status.pid <= 0) return false;
    process.kill(status.pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verifyCurrentCredentials() {
  const helper = join(runtimeDestination, "bin", "exarch-keychain");
  if (!(await exists(helper))) throw new Error("Existing EXARCH Keychain helper is missing");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const prefix = config?.secretAccountPrefix;
  if (typeof prefix !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(prefix)) {
    throw new Error("Existing secret account prefix is invalid");
  }
  const suffixes = ["database-key", "context-capability", "host-transport"];
  if (config?.pairing !== null && config?.pairing !== undefined) suffixes.push("host-relay-access");
  for (const suffix of suffixes) {
    await runSecretCheck(helper, `${prefix}.${suffix}`);
  }
  log("keychain", "Existing startup credentials verified before service interruption");
}

async function runSecretCheck(helper, account) {
  await new Promise((resolve, reject) => {
    const child = spawn(helper, ["get", account], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
      env: process.env
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Existing Keychain credentials are not currently available to EXARCH"));
    });
  });
}

async function migrateLegacyInstallation() {
  if (await exists(configPath) || !(await exists(join(legacyApplicationRoot, "config.json")))) return;

  await runLaunchctl(["bootout", `gui/${process.getuid()}`, legacyLaunchAgentPath], true);
  await mkdir(dirname(applicationRoot), { recursive: true, mode: 0o700 });
  await rename(legacyApplicationRoot, applicationRoot);

  const legacyConfig = JSON.parse(await readFile(configPath, "utf8"));
  const migratedConfig = replaceLegacyPaths(legacyConfig);
  await writeFileAtomically(configPath, `${JSON.stringify(migratedConfig, null, 2)}\n`, 0o600);

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  if (await exists(legacyLaunchAgentPath)) {
    await rename(legacyLaunchAgentPath, `${launchAgentPath}.previous-${timestamp}`);
  }
  if (await exists(legacyAppDestination) && !(await exists(appDestination))) {
    await rename(legacyAppDestination, `${appDestination}.previous-${timestamp}`);
  }
  log("migrate", "Existing installation moved to EXARCH without replacing pairing or context");
}

async function migrateCurrentDesktopName() {
  if (!(await exists(previousExarchAppDestination))) return;
  if (!(await exists(appDestination))) {
    await rename(previousExarchAppDestination, appDestination);
    log("migrate", "Installed Mac app renamed to Exarch Desktop");
    return;
  }
  const backup = `${appDestination}.previous-${new Date().toISOString().replaceAll(":", "-")}`;
  await rename(previousExarchAppDestination, backup);
  log("migrate", `Older EXARCH.app moved to ${backup}`);
}

function replaceLegacyPaths(value) {
  if (typeof value === "string") {
    return value.startsWith(legacyApplicationRoot)
      ? `${applicationRoot}${value.slice(legacyApplicationRoot.length)}`
      : value;
  }
  if (Array.isArray(value)) return value.map(replaceLegacyPaths);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceLegacyPaths(item)]));
  }
  return value;
}

async function writeLauncher(runtime, name, relativeMain, executable) {
  const path = join(runtime, "bin", name);
  await writeFile(
    path,
    `#!/bin/sh\nexec ${shellQuote(executable)} ${shellQuote(join(runtimeDestination, relativeMain))} \"$@\"\n`,
    { mode: 0o700 }
  );
}

async function embedService(app, executable) {
  const serviceApp = join(app, "Contents", "Library", "LoginItems", "EXARCH Service.app");
  const contents = join(serviceApp, "Contents");
  const macOS = join(contents, "MacOS");
  await mkdir(macOS, { recursive: true, mode: 0o755 });
  await cp(executable, join(macOS, "EXARCH Service"));
  await chmod(join(macOS, "EXARCH Service"), 0o755);
  const servicePlist = join(contents, "Info.plist");
  await cp(join(repositoryRoot, "native", "Apps", "macOS", "EXARCHService-Info.plist"), servicePlist);
  // The service runs exactly one child and takes nothing from its command
  // line. Recording the path here rather than in the LaunchAgent puts it
  // inside the signed bundle, so it cannot be edited without invalidating the
  // signature the privacy approvals are keyed to. codesign runs after this.
  await run("/usr/bin/plutil", [
    "-replace", "EXARCHDaemonLauncher",
    "-string", join(runtimeDestination, "bin", "exarch-daemon"),
    servicePlist
  ], repositoryRoot);
}

async function pruneBackups(destination, retain) {
  const parent = dirname(destination);
  const prefix = `${basename(destination)}.previous-`;
  const backups = (await readdir(parent))
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .reverse();
  for (const entry of backups.slice(retain)) {
    await rm(join(parent, entry), { recursive: true, force: true });
    log("prune", `${entry} removed after successful installation`);
  }
}

async function replaceRecoverably(source, destination) {
  let backup = null;
  if (await exists(destination)) {
    backup = `${destination}.previous-${new Date().toISOString().replaceAll(":", "-")}`;
    await rename(destination, backup);
    log("backup", `${basename(destination)} moved to ${backup}`);
  }
  await rename(source, destination);
  return backup;
}

async function restoreReplacement(destination, backup) {
  await rm(destination, { recursive: true, force: true });
  if (backup !== null) await rename(backup, destination);
}

async function writeFileAtomically(path, contents, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, path);
}

function launchAgent(service, config, logs) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.teempai.exarch.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${xml(service)}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>EXARCH_CONFIG_PATH</key><string>${xml(config)}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(join(logs, "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logs, "daemon.error.log"))}</string>
</dict></plist>
`;
}

async function run(command, arguments_, cwd) {
  log("run", `${command} ${arguments_.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

async function runLaunchctl(arguments_, tolerateFailure = false) {
  try {
    await run("/bin/launchctl", arguments_, repositoryRoot);
  } catch (error) {
    if (!tolerateFailure) throw error;
  }
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function log(event, message) { process.stdout.write(`[${event}] ${message}\n`); }
