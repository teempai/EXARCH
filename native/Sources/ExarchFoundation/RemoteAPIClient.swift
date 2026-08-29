import Foundation

public protocol RemoteRequestTransport: Sendable {
    func request(method: String, path: String, headers: [String: String], body: Data) async throws -> (Int, Data)
}

public protocol RequestCounterStore: Sendable {
    func next() async throws -> UInt64
}

public struct RemoteAPIError: Error, Sendable, CustomStringConvertible {
    public let statusCode: Int
    public let code: String
    public let message: String
    public let provider: Provider?
    public let health: ProviderHealth?
    public let policy: EffectivePolicy?
    public let capacity: ProviderCapacity?
    public let retrySafe: Bool

    public var description: String { message }
}

private struct RemoteAPIErrorBody: Decodable {
    let error: String
    let message: String?
    let provider: Provider?
    let health: ProviderHealth?
    let policy: EffectivePolicy?
    let capacity: ProviderCapacity?
    let retrySafe: Bool?
}

public actor KeychainRequestCounter: RequestCounterStore {
    private let store: any SecureValueStore
    private let account: String

    public init(deviceID: String, store: any SecureValueStore = KeychainStore()) {
        self.store = store
        self.account = "request-counter.\(deviceID)"
    }

    public func next() throws -> UInt64 {
        let current: UInt64
        if let data = try store.read(account: account) {
            guard data.count == 8 else { throw ExarchError.invalidEncoding }
            current = data.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        } else {
            current = 0
        }
        guard current < UInt64.max else { throw ExarchError.authenticationFailed }
        let next = current + 1
        var bigEndian = next.bigEndian
        try store.write(withUnsafeBytes(of: &bigEndian) { Data($0) }, account: account)
        return next
    }
}

/// The replay counter is integrity-sensitive but not secret. Keeping it in a
/// mode-0600 file avoids a Keychain authorization dialog on every API call.
public actor ProtectedFileRequestCounter: RequestCounterStore {
    private let url: URL
    private var current: UInt64?
    private let minimum: UInt64

    public init(url: URL, minimum: UInt64 = 0) {
        self.url = url
        self.minimum = minimum
    }

    public func next() throws -> UInt64 {
        if current == nil {
            let stored: UInt64
            if let data = try? Data(contentsOf: url), data.count == 8 {
                stored = data.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            } else {
                stored = 0
            }
            current = max(stored, minimum)
        }
        guard let value = current, value < UInt64.max else {
            throw ExarchError.authenticationFailed
        }
        let next = value + 1
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        var bigEndian = next.bigEndian
        try Data(bytes: &bigEndian, count: MemoryLayout<UInt64>.size).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        current = next
        return next
    }
}

public actor RemoteAPIClient {
    private let transport: any RemoteRequestTransport
    private let authenticator: RequestAuthenticator
    private var counter: UInt64
    private let counterStore: (any RequestCounterStore)?
    private let decoder = JSONDecoder()

    public init(
        transport: any RemoteRequestTransport,
        authenticator: RequestAuthenticator,
        initialCounter: UInt64 = 0,
        counterStore: (any RequestCounterStore)? = nil
    ) {
        self.transport = transport
        self.authenticator = authenticator
        self.counter = initialCounter
        self.counterStore = counterStore
    }

    public func get<T: Decodable & Sendable>(_ path: String, as type: T.Type) async throws -> T {
        try await authenticated(method: "GET", path: path, body: Data(), as: type)
    }

    public func post<Input: Encodable & Sendable, Output: Decodable & Sendable>(
        _ path: String,
        input: Input,
        as type: Output.Type
    ) async throws -> Output {
        let body = try CanonicalJSON.encode(input)
        return try await authenticated(method: "POST", path: path, body: body, as: type)
    }

    private func authenticated<T: Decodable & Sendable>(
        method: String,
        path: String,
        body: Data,
        as type: T.Type
    ) async throws -> T {
        let challengeBody = try CanonicalJSON.encode(["deviceId": authenticator.deviceId])
        let challengeResponse = try await transport.request(
            method: "POST",
            path: "/api/v1/auth/challenge",
            headers: ["content-type": "application/json"],
            body: challengeBody
        )
        guard challengeResponse.0 == 200 else { throw ExarchError.authenticationFailed }
        let challenge = try decoder.decode(AuthenticationChallenge.self, from: challengeResponse.1)
        if let counterStore {
            counter = try await counterStore.next()
        } else {
            guard counter < UInt64.max else { throw ExarchError.authenticationFailed }
            counter += 1
        }
        let signed = try await authenticator.signedHeaders(
            method: method,
            path: path,
            body: body,
            challenge: challenge,
            counter: counter
        )
        var headers = signed.wireHeaders
        if method == "POST" { headers["content-type"] = "application/json" }
        let response = try await transport.request(method: method, path: path, headers: headers, body: body)
        guard (200..<300).contains(response.0) else {
            let body = try? decoder.decode(RemoteAPIErrorBody.self, from: response.1)
            throw RemoteAPIError(
                statusCode: response.0,
                code: body?.error ?? "http_error",
                message: body?.message ?? "Laptop returned status \(response.0)",
                provider: body?.provider,
                health: body?.health,
                policy: body?.policy,
                capacity: body?.capacity,
                retrySafe: body?.retrySafe ?? false
            )
        }
        return try decoder.decode(type, from: response.1)
    }
}
