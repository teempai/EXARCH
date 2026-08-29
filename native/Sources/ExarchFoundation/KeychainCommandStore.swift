#if os(macOS)
import Foundation

/// Keeps foreground-app secrets behind the installer's stable Keychain helper.
///
/// The desktop application is locally/ad-hoc signed and its signature changes
/// whenever it is rebuilt. If it talks to the login Keychain directly, macOS
/// quite correctly asks the user to authorize every newly signed build. The
/// installer already preserves one narrowly scoped helper binary for exactly
/// this reason. Using that stable executable here keeps Keychain ACL ownership
/// constant while the visible app can be updated independently.
public struct KeychainCommandStore: SecureValueStore, Sendable {
    private let executableURL: URL
    private let accountPrefix: String

    public init(executableURL: URL, accountPrefix: String) {
        self.executableURL = executableURL
        self.accountPrefix = accountPrefix
    }

    public func read(account: String) throws -> Data? {
        let result = try run(command: "get", account: account, input: nil)
        // The existing helper deliberately gives missing items and denied
        // reads the same non-zero result. Treat the read as absent; a required
        // subsequent write will still fail loudly instead of prompting in a
        // reconnect loop.
        guard result.status == 0 else { return nil }
        return result.output
    }

    public func write(_ data: Data, account: String) throws {
        guard !data.isEmpty, data.count <= 8 * 1024 else {
            throw ExarchError.invalidEncoding
        }
        let result = try run(command: "put", account: account, input: data)
        guard result.status == 0 else {
            throw ExarchError.unavailable("EXARCH secure storage could not save this Mac identity")
        }
    }

    public func delete(account: String) throws {
        let result = try run(command: "delete", account: account, input: nil)
        guard result.status == 0 else {
            throw ExarchError.unavailable("EXARCH secure storage could not remove this Mac identity")
        }
    }

    private func qualifiedAccount(_ account: String) throws -> String {
        let value = "\(accountPrefix).\(account)"
        guard value.range(of: #"^[A-Za-z0-9._-]{1,200}$"#, options: .regularExpression) != nil else {
            throw ExarchError.invalidEncoding
        }
        return value
    }

    private func run(
        command: String,
        account: String,
        input: Data?
    ) throws -> (status: Int32, output: Data) {
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw ExarchError.unavailable("The EXARCH secure-storage helper is not installed")
        }

        let process = Process()
        let standardInput = Pipe()
        let standardOutput = Pipe()
        let standardError = Pipe()
        process.executableURL = executableURL
        process.arguments = [command, try qualifiedAccount(account)]
        process.standardInput = standardInput
        process.standardOutput = standardOutput
        process.standardError = standardError

        do {
            try process.run()
        } catch {
            throw ExarchError.unavailable("The EXARCH secure-storage helper could not start")
        }
        if let input {
            try standardInput.fileHandleForWriting.write(contentsOf: input)
        }
        try? standardInput.fileHandleForWriting.close()

        let output = standardOutput.fileHandleForReading.readDataToEndOfFile()
        _ = standardError.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard output.count <= 8 * 1024 else { throw ExarchError.responseTooLarge }
        return (process.terminationStatus, output)
    }
}
#endif
