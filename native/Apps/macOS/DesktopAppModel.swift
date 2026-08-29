import AppKit
import ExarchFoundation
import Foundation

enum HarnessScanPhase: Equatable {
    case idle
    case scanning
    case complete
}

struct HarnessScanResult: Identifiable, Equatable {
    enum State: Equatable {
        case waiting
        case scanning
        case found(String)
        case missing
    }

    var id: Provider { provider }
    let provider: Provider
    var state: State
}

/// Owns laptop-only onboarding state. Harness discovery and phone pairing are
/// presented by the main client window; no separate setup window is required.
@MainActor
final class DesktopAppModel: ObservableObject {
    @Published private(set) var harnessScanPhase: HarnessScanPhase = .idle
    @Published private(set) var harnesses = Provider.allCases.map {
        HarnessScanResult(provider: $0, state: .waiting)
    }
    @Published var logLines = ["Ready to pair a phone when you are."]
    @Published var relayURL = ""
    @Published var administratorToken = ""
    @Published var pairingInvitation: String?
    @Published var pendingSAS: String?
    @Published private(set) var pairingConfigured = false
    @Published private(set) var pairingBusy = false
    @Published var pairingError: String?

    private var setupProcess: Process?
    private var setupInput: Pipe?
    private var outputBuffer = ""
    private var errorBuffer = ""
    private var pairingCompleted = false

    var canStartPairing: Bool {
        !pairingBusy && validRelayURL && normalizedAdministratorToken.count >= 32
    }

    func inspect() async {
        refreshPairingConfiguration()
        await scanHarnesses()
    }

    func refreshPairingConfiguration() {
        pairingConfigured = configurationIsPaired()
    }

    func prepareForPairing() {
        refreshPairingConfiguration()
        pairingError = nil
        if !pairingBusy {
            pairingInvitation = nil
            pendingSAS = nil
        }
    }

    func scanHarnesses() async {
        guard harnessScanPhase != .scanning else { return }
        harnessScanPhase = .scanning
        harnesses = Provider.allCases.map { HarnessScanResult(provider: $0, state: .waiting) }
        for provider in Provider.allCases {
            updateHarness(provider, state: .scanning)
            let path = await Task.detached {
                HarnessExecutableDiscovery.findExecutable(for: provider)
            }.value
            updateHarness(provider, state: path.map(HarnessScanResult.State.found) ?? .missing)
        }
        harnessScanPhase = .complete
    }

    func startPairing() {
        let token = normalizedAdministratorToken
        guard canStartPairing else {
            pairingError = "Enter an exact relay address ending in /v1/relay and a valid administrator token."
            return
        }
        pairingBusy = true
        pairingCompleted = false
        pairingInvitation = nil
        pendingSAS = nil
        pairingError = nil
        outputBuffer = ""
        errorBuffer = ""
        append("[relay] Provisioning one private route")

        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        let input = Pipe()
        process.executableURL = setupExecutable
        process.arguments = ["pair", "--relay-url", relayURL]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        setupProcess = process
        setupInput = input

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
                handle.readabilityHandler = nil
                return
            }
            Task { @MainActor in self?.consume(text, isError: false) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
                handle.readabilityHandler = nil
                return
            }
            Task { @MainActor in self?.consume(text, isError: true) }
        }
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in self?.setupTerminated(status: process.terminationStatus) }
        }
        do {
            try process.run()
            try input.fileHandleForWriting.write(contentsOf: Data("\(token)\n".utf8))
            administratorToken = ""
        } catch {
            setupTerminated(status: -1)
            pairingError = "Could not start pairing: \(error.localizedDescription)"
        }
    }

    func cancelPairing() {
        if pendingSAS != nil {
            confirmPairing(false)
        } else if setupProcess?.isRunning == true {
            setupProcess?.terminate()
        }
        pairingInvitation = nil
        pendingSAS = nil
    }

    func confirmPairing(_ accepted: Bool) {
        guard pendingSAS != nil, let setupInput else { return }
        do {
            try setupInput.fileHandleForWriting.write(contentsOf: Data((accepted ? "yes\n" : "no\n").utf8))
            pendingSAS = nil
            if !accepted { pairingInvitation = nil }
            append(accepted ? "[pair] Code match confirmed on this Mac" : "[pair] Pairing declined")
        } catch {
            pairingError = "Could not answer the pairing process."
        }
    }

    func copyInvitation() {
        guard let pairingInvitation else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(pairingInvitation, forType: .string)
        append("[pair] One-use pairing code copied")
    }

    func copyLogs() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(logLines.joined(separator: "\n"), forType: .string)
    }

    private func consume(_ chunk: String, isError: Bool) {
        if isError { errorBuffer += chunk } else { outputBuffer += chunk }
        var buffer = isError ? errorBuffer : outputBuffer
        while let newline = buffer.firstIndex(of: "\n") {
            let line = String(buffer[..<newline])
            buffer.removeSubrange(...newline)
            handleProcessLine(line, isError: isError)
        }
        if isError { errorBuffer = buffer } else { outputBuffer = buffer }
    }

    private func handleProcessLine(_ line: String, isError: Bool) {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let event = object["event"] as? String
        else {
            if !line.isEmpty { append(isError ? "[pair error] \(line)" : "[pair] \(line)") }
            return
        }
        switch event {
        case "setup.admin_token_required":
            append("[relay] Administrator credential received through the local process pipe")
        case "pair.invitation":
            pairingInvitation = object["invitationText"] as? String
            append("[pair] One-use phone pairing code is ready")
        case "pair.sas":
            pendingSAS = object["sas"] as? String
            append("[pair] Verify the full comparison code on both devices")
        case "pair.complete":
            pairingCompleted = true
            pairingInvitation = nil
            pendingSAS = nil
            pairingConfigured = true
            append("[ok] Phone identity and relay route are paired")
        case "setup.failed":
            pairingInvitation = nil
            pendingSAS = nil
            pairingError = object["error"] as? String ?? "Secure pairing failed."
        default:
            append("[pair] \(event)")
        }
    }

    private func setupTerminated(status: Int32) {
        setupProcess = nil
        setupInput = nil
        pairingBusy = false
        if status == 0, pairingCompleted {
            Task { await restartService() }
        } else if status != 0, pairingError == nil {
            pairingInvitation = nil
            pendingSAS = nil
            pairingError = "Secure pairing exited with status \(status)."
        }
    }

    private func restartService() async {
        append("[service] Restarting the local service with the private relay route")
        _ = await Self.run("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/com.teempai.exarch.daemon"])
    }

    private func updateHarness(_ provider: Provider, state: HarnessScanResult.State) {
        guard let index = harnesses.firstIndex(where: { $0.provider == provider }) else { return }
        harnesses[index].state = state
    }

    private var normalizedAdministratorToken: String {
        administratorToken.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func append(_ line: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        logLines.append("\(formatter.string(from: Date())) \(line)")
    }

    private var validRelayURL: Bool {
        guard let url = URL(string: relayURL), url.path == "/v1/relay",
              url.query == nil, url.fragment == nil else { return false }
        if url.scheme == "wss" { return true }
        return url.scheme == "ws" && ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "")
    }

    private func configurationIsPaired() -> Bool {
        guard let data = try? Data(contentsOf: configurationFile),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["version"] as? Int
        else { return false }
        if version == 1 { return true }
        return version == 2 && object["pairing"] is [String: Any]
    }

    nonisolated private static func run(_ executable: String, _ arguments: [String]) async -> Int32 {
        await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus
            } catch { return -1 }
        }.value
    }

    private var configurationFile: URL { DesktopPaths.applicationSupport.appending(path: "config.json") }
    private var setupExecutable: URL { DesktopPaths.setupExecutable }
}
