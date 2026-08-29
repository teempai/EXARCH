import Darwin
import Foundation

/// The daemon launcher, relative to the current user's home directory.
///
/// The installer writes this shim and bakes the interpreter path into it, so
/// the service does not need to be told what to run. That matters: this
/// process is the launchd job, which makes it the TCC-responsible process for
/// everything it spawns, and its bundle carries the Desktop, Documents, and
/// Downloads usage descriptions the user approves. A child chosen by the
/// caller would run under those approvals.
private let daemonLauncherPath = "Library/Application Support/EXARCH/runtime/bin/exarch-daemon"

private enum ServiceError: LocalizedError {
    case daemonMissing(String)

    var errorDescription: String? {
        switch self {
        case let .daemonMissing(path):
            "EXARCH Service could not find its daemon at \(path)."
        }
    }
}

/// Resolves the one executable this service will ever run.
///
/// Nothing from the command line reaches this. The service used to take the
/// child from `argv[1]`, validated only as "absolute, not /, executable",
/// which made the bundle a general-purpose launcher: any process on the
/// machine could spawn it and have an arbitrary binary run as the responsible
/// process, inheriting privacy approvals it had not been granted itself.
///
/// The installer records the exact path in this bundle's own Info.plist and
/// then signs the bundle, so the value is sealed: editing it invalidates the
/// signature, and the privacy approvals the attack was reaching for are keyed
/// to that signature. Without the key — running the binary outside a bundle,
/// or from an installation that predates it — the home-relative default is
/// where the installer has always put the launcher.
private func daemonExecutable() throws -> URL {
    let declared = Bundle.main.object(forInfoDictionaryKey: "EXARCHDaemonLauncher") as? String
    let url: URL
    if let declared, declared.hasPrefix("/") {
        url = URL(fileURLWithPath: declared).standardizedFileURL
    } else {
        url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(daemonLauncherPath)
            .standardizedFileURL
    }
    guard FileManager.default.isExecutableFile(atPath: url.path) else {
        throw ServiceError.daemonMissing(url.path)
    }
    return url
}

private func run() throws -> Never {
    let child = Process()
    child.executableURL = try daemonExecutable()
    // The launcher takes no arguments. Anything on this process's command line
    // is a leftover from an older LaunchAgent that named the interpreter and
    // the script; it is deliberately not forwarded.
    child.arguments = []
    child.environment = ProcessInfo.processInfo.environment
    child.standardInput = FileHandle.standardInput
    child.standardOutput = FileHandle.standardOutput
    child.standardError = FileHandle.standardError
    try child.run()

    // launchd signals the responsible EXARCH process. Keep that identity alive
    // while the JavaScript daemon runs, and forward orderly shutdown signals to
    // the child rather than replacing this process with Node via exec(2).
    let signals = [SIGTERM, SIGINT, SIGHUP]
    let signalSources = signals.map { number in
        Darwin.signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler {
            if child.isRunning {
                _ = Darwin.kill(child.processIdentifier, number)
            }
        }
        source.resume()
        return source
    }

    child.waitUntilExit()
    signalSources.forEach { $0.cancel() }
    if child.terminationReason == .exit {
        Darwin.exit(child.terminationStatus)
    }
    Darwin.exit(128 + child.terminationStatus)
}

do {
    try run()
} catch {
    let message = "EXARCH Service: \(error.localizedDescription)\n"
    FileHandle.standardError.write(Data(message.utf8))
    Darwin.exit(64)
}
