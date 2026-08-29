import Foundation

#if os(macOS)
import Darwin

/// Restores a stopped or unregistered local daemon without touching daemon
/// credentials. The foreground app only asks launchd to bootstrap and restart
/// the fixed per-user service installed by EXARCH.
public struct LocalServiceRecovery: Sendable {
    private let applicationSupport: URL

    public init(applicationSupport: URL) {
        self.applicationSupport = applicationSupport
    }

    public func restore() async throws {
        try await Task.detached(priority: .userInitiated) {
            try restoreSynchronously()
        }.value
    }

    private func restoreSynchronously() throws {
        let userDomain = "gui/\(getuid())"
        let label = "com.teempai.exarch.daemon"
        let serviceTarget = "\(userDomain)/\(label)"
        let launchAgent = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")

        if Self.runLaunchctl(["print", serviceTarget]) != 0 {
            guard Self.runLaunchctl(["bootstrap", userDomain, launchAgent.path]) == 0 else {
                throw ExarchError.unavailable("EXARCH could not register its local service")
            }
        }
        guard Self.runLaunchctl(["kickstart", "-k", serviceTarget]) == 0 else {
            throw ExarchError.unavailable("EXARCH could not restart its local service")
        }

        let dataDirectory = applicationSupport.appendingPathComponent("data")
        for _ in 0..<40 {
            if let status = try? DaemonRuntimeStatus.read(dataDirectory: dataDirectory),
               status.isOnline,
               let pid = status.pid,
               pid > 0,
               kill(pid_t(pid), 0) == 0 {
                return
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        throw ExarchError.unavailable(
            "EXARCH still could not start. Its local diagnostic log has been preserved."
        )
    }

    private static func runLaunchctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }
}
#endif
