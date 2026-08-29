import CryptoKit
import Foundation
import LocalAuthentication
import Security

public protocol P256PayloadSigner: Sendable {
    var encodedPublicKey: String { get }
    var hardwareBacked: Bool { get }
    func sign(_ payload: Data, reason: String?) async throws -> Data
}

public actor DeviceKeyManager {
    public enum Purpose: String, Sendable {
        case request
        case approval
        case hostIdentity
    }

    private let store: any SecureValueStore

    public init(store: any SecureValueStore = KeychainStore()) {
        self.store = store
    }

    public func signer(for purpose: Purpose) throws -> any P256PayloadSigner {
        let account = "p256.\(purpose.rawValue)"
        if let stored = try store.read(account: account) {
#if targetEnvironment(simulator)
            // Simulator can persist a Secure Enclave key reference and then
            // reject its Local Authentication operation. Replace that key
            // with a Simulator-only software key. Device builds never enter
            // this branch.
            if stored.first == 1 {
                let signer = try create(purpose: purpose)
                try store.write(try representation(of: signer), account: account)
                return signer
            }
#endif
            return try decode(stored, purpose: purpose)
        }
        let signer = try create(purpose: purpose)
        try store.write(try representation(of: signer), account: account)
        return signer
    }

    private func create(purpose: Purpose) throws -> any P256PayloadSigner {
#if targetEnvironment(simulator)
        return SoftwareP256Signer(key: P256.Signing.PrivateKey(), requiresPresence: false)
#else
#if os(macOS)
        // Request authentication is unattended and does not gain a user-
        // presence property from Secure Enclave storage. Keeping this key in
        // the data-protection Keychain avoids Secure Enclave creation prompts
        // for locally built/ad-hoc-signed OSS desktop apps. Approval keys keep
        // their biometric, hardware-backed path below.
        if purpose == .request {
            return SoftwareP256Signer(key: P256.Signing.PrivateKey(), requiresPresence: false)
        }
#endif
        if SecureEnclave.isAvailable {
            var flags: SecAccessControlCreateFlags = [.privateKeyUsage]
            if purpose == .approval { flags.insert(.biometryCurrentSet) }
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                flags,
                &error
            ) else {
                throw error!.takeRetainedValue()
            }
            return SecureEnclaveSigner(
                key: try SecureEnclave.P256.Signing.PrivateKey(accessControl: access),
                requiresPresence: purpose == .approval
            )
        }
        return SoftwareP256Signer(key: P256.Signing.PrivateKey(), requiresPresence: purpose == .approval)
#endif
    }

    private func decode(_ stored: Data, purpose: Purpose) throws -> any P256PayloadSigner {
        guard let marker = stored.first else { throw ExarchError.invalidEncoding }
        let keyData = stored.dropFirst()
        switch marker {
        case 1:
            return SecureEnclaveSigner(
                dataRepresentation: Data(keyData),
                requiresPresence: purpose == .approval
            )
        case 2:
            return SoftwareP256Signer(
                key: try P256.Signing.PrivateKey(rawRepresentation: keyData),
                requiresPresence: requiresPresence(for: purpose)
            )
        default:
            throw ExarchError.invalidEncoding
        }
    }

    private func requiresPresence(for purpose: Purpose) -> Bool {
#if targetEnvironment(simulator)
        false
#else
        purpose == .approval
#endif
    }

    private func representation(of signer: any P256PayloadSigner) throws -> Data {
        if let secure = signer as? SecureEnclaveSigner { return Data([1]) + secure.dataRepresentation }
        if let software = signer as? SoftwareP256Signer { return Data([2]) + software.key.rawRepresentation }
        throw ExarchError.invalidEncoding
    }
}

public struct SecureEnclaveSigner: P256PayloadSigner, @unchecked Sendable {
    let dataRepresentation: Data
    let requiresPresence: Bool

    init(key: SecureEnclave.P256.Signing.PrivateKey, requiresPresence: Bool) {
        self.dataRepresentation = key.dataRepresentation
        self.requiresPresence = requiresPresence
    }

    init(dataRepresentation: Data, requiresPresence: Bool) {
        self.dataRepresentation = dataRepresentation
        self.requiresPresence = requiresPresence
    }

    public var encodedPublicKey: String {
        get {
            guard let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation) else {
                return "p256:unavailable"
            }
            return "p256:\(key.publicKey.x963Representation.base64URLEncodedString)"
        }
    }
    public var hardwareBacked: Bool { true }

    public func sign(_ payload: Data, reason: String?) async throws -> Data {
        let context: LAContext? = requiresPresence ? LAContext() : nil
        context?.localizedReason = reason ?? "Approve this action"
        let key = try SecureEnclave.P256.Signing.PrivateKey(
            dataRepresentation: dataRepresentation,
            authenticationContext: context
        )
        return try key.signature(for: payload).derRepresentation
    }
}

public struct SoftwareP256Signer: P256PayloadSigner, Sendable {
    let key: P256.Signing.PrivateKey
    let requiresPresence: Bool

    public init(key: P256.Signing.PrivateKey = .init(), requiresPresence: Bool = false) {
        self.key = key
        self.requiresPresence = requiresPresence
    }

    public var encodedPublicKey: String { "p256:\(key.publicKey.x963Representation.base64URLEncodedString)" }
    public var hardwareBacked: Bool { false }

    public func sign(_ payload: Data, reason: String?) async throws -> Data {
        if requiresPresence {
            let context = LAContext()
            let prompt = reason ?? "Approve this action"
            guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: prompt) else {
                throw ExarchError.authenticationFailed
            }
        }
        return try key.signature(for: payload).derRepresentation
    }
}

public func verifyP256Signature(_ signature: Data, payload: Data, encodedPublicKey: String) -> Bool {
    guard encodedPublicKey.hasPrefix("p256:"),
          let raw = try? Data(canonicalBase64URL: String(encodedPublicKey.dropFirst(5))),
          let key = try? P256.Signing.PublicKey(x963Representation: raw),
          let parsed = try? P256.Signing.ECDSASignature(derRepresentation: signature)
    else { return false }
    return key.isValidSignature(parsed, for: payload)
}
