import ExarchFoundation
import ExarchUI
import LocalAuthentication
import SwiftUI

#if os(iOS)
@main
struct ExarchApp: App {
    @StateObject private var model = MobileAppModel()
    @StateObject private var privacyLock = AppPrivacyLock()
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var appearance = AppearanceStore()
    @State private var hasStartedModel = false
    @State private var activatingModel = false

    var body: some Scene {
        WindowGroup {
            ZStack {
                Group {
                    if privacyLock.isUnlocked {
                        MobileRootView(model: model, appearance: appearance)
                    } else {
                        AppPrivacyLockView(lock: privacyLock) {
                            Task { await unlockAndActivate() }
                        }
                    }
                }

                // Conceal conversation data in system snapshots without
                // changing authentication state. Face ID can make the scene
                // inactive while the lock view is already covering the app.
                if privacyLock.isUnlocked, scenePhase != .active {
                    AppPrivacyBrandView()
                }
            }
                // Applied at the scene root so the surfaces the app does not
                // draw — keyboard, alerts, menus, share sheets — follow the
                // chosen appearance too. `nil` means follow the device.
                .preferredColorScheme(appearance.preference.colorScheme)
                .task {
                    guard scenePhase == .active else { return }
                    await unlockAndActivate()
                }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        Task { await unlockAndActivate() }
                    case .inactive:
                        model.becameInactive()
                        // Face ID makes the scene inactive while its system UI
                        // is visible. Locking here would cancel that attempt.
                    case .background:
                        model.becameInactive()
                        privacyLock.lock()
                    @unknown default:
                        model.becameInactive()
                        privacyLock.lock()
                    }
                }
        }
    }

    @MainActor
    private func unlockAndActivate() async {
        guard !activatingModel else { return }
        activatingModel = true
        defer { activatingModel = false }
        guard await privacyLock.unlock() else { return }
        if hasStartedModel {
            model.becameActive()
        } else {
            hasStartedModel = true
            await model.start()
        }
    }
}

@MainActor
private final class AppPrivacyLock: ObservableObject {
    enum State: Equatable {
        case locked
        case authenticating
        case unlocked
        case failed(String)
    }

    @Published private(set) var state: State = .locked
    @Published private(set) var biometricName = "Face ID"
    private var context: LAContext?
    private var generation = 0
    private let secureStore = KeychainStore()

    private var authenticationRequired: Bool {
#if DEBUG && targetEnvironment(simulator)
        false
#else
        // Device authentication protects an established laptop relationship
        // and its cached conversations. A new installation has no private
        // laptop state to reveal, so it must be able to reach pairing without
        // first enrolling or completing Face ID.
        do {
            return try secureStore.read(account: "paired-laptop") != nil
        } catch {
            // If Keychain cannot be inspected, fail closed: an inaccessible
            // record may still contain an existing laptop relationship.
            return true
        }
#endif
    }

    init() {
        if !authenticationRequired {
            state = .unlocked
        }
    }

    var isUnlocked: Bool { state == .unlocked }
    var isAuthenticating: Bool { state == .authenticating }
    var failureMessage: String? {
        if case let .failed(message) = state { return message }
        return nil
    }

    func unlock() async -> Bool {
        guard authenticationRequired else {
            state = .unlocked
            return true
        }
        if isUnlocked { return true }
        guard !isAuthenticating else { return false }

        generation += 1
        let attempt = generation
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        context.localizedFallbackTitle = "Use Passcode"
        self.context = context

        var biometricError: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &biometricError) {
            switch context.biometryType {
            case .faceID: biometricName = "Face ID"
            case .touchID: biometricName = "Touch ID"
            case .opticID: biometricName = "Optic ID"
            case .none: biometricName = "device authentication"
            @unknown default: biometricName = "device authentication"
            }
        } else {
            biometricName = "device authentication"
        }

        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            self.context = nil
            state = .failed(authenticationMessage(policyError))
            return false
        }

        state = .authenticating
        do {
            let authenticated = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Unlock your laptop conversations and remote controls."
            )
            guard attempt == generation else { return false }
            self.context = nil
            state = authenticated ? .unlocked : .locked
            return authenticated
        } catch {
            guard attempt == generation else { return false }
            self.context = nil
            let localError = error as? LAError
            if localError?.code == .userCancel || localError?.code == .systemCancel || localError?.code == .appCancel {
                state = .locked
            } else {
                state = .failed(authenticationMessage(error as NSError))
            }
            return false
        }
    }

    func lock() {
        guard authenticationRequired else {
            state = .unlocked
            return
        }
        generation += 1
        context?.invalidate()
        context = nil
        state = .locked
    }

    private func authenticationMessage(_ error: NSError?) -> String {
        guard let error else {
            return "Secure device authentication is unavailable."
        }
        switch LAError.Code(rawValue: error.code) {
        case .biometryNotEnrolled:
            return "Set up Face ID in Settings before using EXARCH."
        case .biometryNotAvailable:
            return "Face ID is unavailable on this device."
        case .passcodeNotSet:
            return "Set a device passcode before using EXARCH."
        case .biometryLockout:
            return "Face ID is locked. Use your device passcode to unlock it."
        default:
            return "Authentication did not complete. Try again."
        }
    }
}

private struct AppPrivacyLockView: View {
    @ObservedObject var lock: AppPrivacyLock
    let authenticate: () -> Void

    var body: some View {
        ZStack {
            AppPrivacyBrandView()
            if let failure = lock.failureMessage {
                VStack(spacing: 14) {
                    Spacer()
                    Text(failure)
                        .font(.callout)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(FocusFlowTheme.secondaryInk)
                        .frame(maxWidth: 340)
                    Button("Try again") { authenticate() }
                        .buttonStyle(.prominentBrass)
                        .controlSize(.large)
                    Spacer().frame(height: 64)
                }
                .padding(24)
            }
        }
        .task {
            guard !lock.isUnlocked, !lock.isAuthenticating else { return }
            authenticate()
        }
    }
}

private struct AppPrivacyBrandView: View {
    var body: some View {
        ZStack {
            FocusFlowTheme.canvas.ignoresSafeArea()
            ExarchWordmark(size: 28, relativeTo: .title)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("EXARCH")
    }
}
#endif
