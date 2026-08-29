import Foundation
import LocalAuthentication
import Security

public protocol SecureValueStore: Sendable {
    func read(account: String) throws -> Data?
    func write(_ data: Data, account: String) throws
    func delete(account: String) throws
}

public struct KeychainStore: SecureValueStore, Sendable {
    private let service: String
    private let legacyServices: [String]

    public init(
        service: String = "com.teempai.exarch",
        legacyServices: [String] = ["com.teempai.mobile-remote-agent"]
    ) {
        self.service = service
        self.legacyServices = legacyServices.filter { $0 != service }
    }

    public func read(account: String) throws -> Data? {
        try read(
            account: account,
            authenticationContext: passiveAuthenticationContext()
        )
    }

    private func read(
        account: String,
        authenticationContext: LAContext?
    ) throws -> Data? {
        if let current = try read(
            account: account,
            service: service,
            authenticationContext: authenticationContext
        ) { return current }
        for legacyService in legacyServices {
            guard let legacy = try read(
                account: account,
                service: legacyService,
                authenticationContext: authenticationContext
            ) else { continue }
            try write(legacy, account: account)
            return legacy
        }
        return nil
    }

    private func read(
        account: String,
        service: String,
        authenticationContext: LAContext?
    ) throws -> Data? {
        var query = baseQuery(account: account, service: service)
        addAuthentication(authenticationContext, to: &query)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        if authenticationContext?.interactionNotAllowed == true,
           status == errSecInteractionNotAllowed || status == errSecAuthFailed {
            // A stale ACL-bound prototype item is not usable during passive
            // startup. Treat it as absent so the caller can establish a fresh
            // data-protection-keychain identity without opening system UI.
            return nil
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw ExarchError.unavailable("Keychain read failed: \(status)")
        }
        return data
    }

    private func passiveAuthenticationContext() -> LAContext? {
#if os(macOS)
        let context = LAContext()
        context.interactionNotAllowed = true
        return context
#else
        return nil
#endif
    }

    private func addAuthentication(_ context: LAContext?, to query: inout [String: Any]) {
#if os(macOS)
        if let context {
            query[kSecUseAuthenticationContext as String] = context
        }
#else
        _ = (context, query)
#endif
    }

    public func write(_ data: Data, account: String) throws {
        let query = baseQuery(account: account, service: service)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updated == errSecItemNotFound {
            var insertion = query
            attributes.forEach { insertion[$0.key] = $0.value }
            let status = SecItemAdd(insertion as CFDictionary, nil)
            guard status == errSecSuccess else {
                throw ExarchError.unavailable("Keychain write failed: \(status)")
            }
        } else if updated != errSecSuccess {
            throw ExarchError.unavailable("Keychain update failed: \(updated)")
        }
    }

    public func delete(account: String) throws {
        for candidate in [service] + legacyServices {
            let status = SecItemDelete(baseQuery(account: account, service: candidate) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw ExarchError.unavailable("Keychain delete failed: \(status)")
            }
            // A key left behind in the other keychain is still a key.
            SecItemDelete(legacyKeychainQuery(account: account, service: candidate) as CFDictionary)
        }
    }

    /// On macOS a generic-password item goes to the file-based login keychain
    /// unless this key asks for the data protection keychain. That matters
    /// because `kSecAttrAccessible` is honoured only by the latter: without
    /// this, `WhenUnlockedThisDeviceOnly` is silently a no-op and the item is
    /// guarded by an ACL bound to the calling code's signature — which, for an
    /// ad-hoc signed build, changes on every rebuild. iOS has only the one
    /// keychain and ignores the key.
    private func baseQuery(account: String, service: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
#if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
#endif
        return query
    }

    /// The same query against the keychain this build no longer writes to.
    /// Items written by an earlier build are still there, and there is no way
    /// to reach them except by asking for that keychain explicitly.
    private func legacyKeychainQuery(account: String, service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }
}
