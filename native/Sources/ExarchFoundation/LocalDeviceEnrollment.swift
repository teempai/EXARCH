import Foundation

// Runs the setup command-line tool, which only exists on the machine hosting
// the daemon. The phone reaches the same daemon over the relay and never
// enrols locally.
#if os(macOS)

/// Registers this Mac with its own daemon, and remembers the result.
///
/// The loopback API authenticates every caller as a registered device, so the
/// Mac client needs an identity. It does not pair: it already holds the
/// configuration and the Keychain, so it enrols directly by running
/// `exarch-setup enroll-local`, the same way `DesktopAppModel` already shells
/// out for pairing.
///
/// The keys come from `DeviceKeyManager`, which keeps them in the Keychain and
/// in the Secure Enclave where one is available. Enrolment is therefore
/// idempotent across launches: the same key presents, the same device comes
/// back.
public struct LocalDeviceEnrollment: Sendable {
    public struct Enrolled: Codable, Equatable, Sendable {
        public let deviceId: String
        public let displayName: String
        public let lastCounter: UInt64
    }

    private let executable: URL
    private let configPath: URL?
    private let cacheURL: URL

    public init(
        executable: URL,
        configPath: URL? = nil,
        cacheURL: URL? = nil
    ) {
        self.executable = executable
        self.configPath = configPath
        self.cacheURL = cacheURL ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/EXARCH/local-device.json")
    }

    private struct CachedEnrollment: Codable {
        let signingPublicKey: String
        let enrolled: Enrolled
    }

    public func cachedEnrollment(signingPublicKey: String) -> Enrolled? {
        guard let data = try? Data(contentsOf: cacheURL),
              let cached = try? JSONDecoder().decode(CachedEnrollment.self, from: data),
              cached.signingPublicKey == signingPublicKey else { return nil }
        return cached.enrolled
    }

    public func remember(_ enrolled: Enrolled, signingPublicKey: String) throws {
        try FileManager.default.createDirectory(
            at: cacheURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try JSONEncoder().encode(CachedEnrollment(
            signingPublicKey: signingPublicKey,
            enrolled: enrolled
        )).write(to: cacheURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cacheURL.path)
    }

    /// Enrols, returning the device the daemon accepted.
    ///
    /// Always runs the command rather than trusting the cache. Enrolment is
    /// idempotent for the complete key pair. A revoked or changed identity is
    /// refused and must go through the explicit repair flow.
    public func enroll(
        signingPublicKey: String,
        approvalPublicKey: String,
        displayName: String
    ) async throws -> Enrolled {
        var arguments = [
            "enroll-local",
            "--signing-key", Self.rawKey(signingPublicKey),
            "--approval-key", Self.rawKey(approvalPublicKey),
            "--display-name", displayName
        ]
        if let configPath { arguments.append(contentsOf: ["--config", configPath.path]) }

        let output = try await run(arguments)
        guard let line = output
            .split(separator: "\n")
            .compactMap({ try? JSONDecoder().decode(EnrollEvent.self, from: Data($0.utf8)) })
            .first(where: { $0.event == "device.enrolled" })
        else { throw ExarchError.unavailable("Enrolment did not report a device") }

        return Enrolled(deviceId: line.id, displayName: line.displayName, lastCounter: line.lastCounter)
    }

    /// Replaces only the daemon's loopback Mac-client identity. The caller
    /// must obtain explicit local-owner authentication before invoking this.
    public func repair(
        signingPublicKey: String,
        approvalPublicKey: String,
        displayName: String
    ) async throws -> Enrolled {
        var arguments = [
            "repair-local",
            "--signing-key", Self.rawKey(signingPublicKey),
            "--approval-key", Self.rawKey(approvalPublicKey),
            "--display-name", displayName
        ]
        if let configPath { arguments.append(contentsOf: ["--config", configPath.path]) }

        let output = try await run(arguments)
        guard let line = output
            .split(separator: "\n")
            .compactMap({ try? JSONDecoder().decode(EnrollEvent.self, from: Data($0.utf8)) })
            .first(where: { $0.event == "device.repaired" })
        else { throw ExarchError.unavailable("Repair did not report a Mac identity") }
        return Enrolled(deviceId: line.id, displayName: line.displayName, lastCounter: line.lastCounter)
    }

    /// `DeviceKeyManager` returns keys prefixed for the wire; the CLI validates
    /// and adds the prefix itself, so it is stripped here.
    static func rawKey(_ encoded: String) -> String {
        encoded.hasPrefix("p256:") ? String(encoded.dropFirst(5)) : encoded
    }

    /// One paired device as the daemon knows it.
    public struct KnownDevice: Codable, Identifiable, Equatable, Sendable {
        public let id: String
        public let displayName: String
        public let status: String
        public let capabilities: [String]
        public let createdAt: String
        public let lastCounter: UInt64
        public let signingPublicKey: String?
        public let approvalPublicKey: String?

        public var isActive: Bool { status == "active" }
    }

    /// Every device registered against this Mac, including itself.
    public func listDevices() async throws -> [KnownDevice] {
        var arguments = ["devices"]
        if let configPath { arguments.append(contentsOf: ["--config", configPath.path]) }
        let output = try await run(arguments)
        guard let line = output
            .split(separator: "\n")
            .compactMap({ try? JSONDecoder().decode(DevicesEvent.self, from: Data($0.utf8)) })
            .first(where: { $0.event == "devices.listed" })
        else { throw ExarchError.unavailable("Could not read the paired devices") }
        return line.devices
    }

    /// Finds the already-enrolled loopback identity using its public signing
    /// key. Public keys and counters are safe to read from the local admin CLI.
    public func existingDevice(signingPublicKey: String) async throws -> Enrolled? {
        let encoded = signingPublicKey.hasPrefix("p256:")
            ? signingPublicKey
            : "p256:\(signingPublicKey)"
        guard let device = try await listDevices().first(where: {
            $0.isActive && $0.capabilities.contains("mac-client") && $0.signingPublicKey == encoded
        }) else { return nil }
        return Enrolled(
            deviceId: device.id,
            displayName: device.displayName,
            lastCounter: device.lastCounter
        )
    }

    /// Retires the paired phone and its private relay route while preserving
    /// this Mac client's loopback identity and every canonical conversation.
    public func unpair() async throws {
        var arguments = ["unpair"]
        if let configPath { arguments.append(contentsOf: ["--config", configPath.path]) }
        let output = try await run(arguments)
        guard output
            .split(separator: "\n")
            .contains(where: { line in
                guard let event = try? JSONDecoder().decode(UnpairEvent.self, from: Data(line.utf8)) else {
                    return false
                }
                return event.event == "pairing.revoked" && event.contextPreserved
            })
        else { throw ExarchError.unavailable("Pairing removal was not confirmed") }
    }

    private struct DevicesEvent: Decodable {
        let event: String
        let devices: [KnownDevice]
    }

    private struct EnrollEvent: Decodable {
        let event: String
        let id: String
        let displayName: String
        let lastCounter: UInt64
    }

    private struct UnpairEvent: Decodable {
        let event: String
        let contextPreserved: Bool
    }

    /// Runs the CLI and collects its output.
    ///
    /// Both pipes are drained while the child runs. Reading them from the
    /// termination handler instead deadlocks as soon as the child writes more
    /// than the pipe buffer holds — roughly 64 KB: the child blocks on the
    /// write, so it never terminates, so the handler that would have drained
    /// the pipe never runs and the continuation is never resumed. `devices`
    /// grows with the number of enrolled devices and sits on the client's
    /// startup path, which is where that would have shown up as a hang.
    private func run(_ arguments: [String]) async throws -> String {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors

        try process.run()

        async let collectedOutput = Self.drain(output)
        async let collectedErrors = Self.drain(errors)
        let text = await collectedOutput
        let failure = await collectedErrors
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let message = failure.trimmingCharacters(in: .whitespacesAndNewlines)
            throw ExarchError.unavailable(message.isEmpty ? "Enrolment failed" : message)
        }
        return text
    }

    private static func drain(_ pipe: Pipe) async -> String {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: String(decoding: data, as: UTF8.self))
            }
        }
    }
}
#endif
