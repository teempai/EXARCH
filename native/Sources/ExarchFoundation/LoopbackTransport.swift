import Foundation

/// Where the daemon is listening, as it reports itself.
///
/// The daemon writes `runtime-status.json` beside its data on every start and
/// stop, so the Mac client discovers the port rather than assuming one. The
/// port is chosen from configuration and can change between installs.
public struct DaemonRuntimeStatus: Codable, Equatable, Sendable {
    public let version: Int
    public let state: String
    public let apiBaseUrl: String?
    public let pid: Int?

    public var isOnline: Bool { state == "online" && apiBaseUrl != nil }

    /// Reads the status file, returning `nil` when the daemon has never run.
    public static func read(dataDirectory: URL) throws -> DaemonRuntimeStatus? {
        let url = dataDirectory.appendingPathComponent("runtime-status.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard data.count <= 64 * 1024 else { throw ExarchError.responseTooLarge }
        return try JSONDecoder().decode(DaemonRuntimeStatus.self, from: data)
    }
}

/// Carries signed API calls to the daemon on this machine.
///
/// The phone reaches the same API through the encrypted relay; the Mac is
/// already on the other side of it, so it talks to loopback directly. Requests
/// are signed exactly as the phone signs them — the daemon authenticates every
/// caller as a registered device regardless of how it arrived.
public actor LoopbackTransport: RemoteRequestTransport {
    private let baseURL: URL
    private let session: URLSession

    /// - Throws: when the URL is not plain HTTP on loopback. The daemon binds
    ///   127.0.0.1 only, and this refuses to send signed requests anywhere else
    ///   even if a status file were tampered with.
    public init(baseURL: URL, session: URLSession? = nil) throws {
        try Self.validate(baseURL)
        self.baseURL = baseURL
        self.session = session ?? URLSession(
            configuration: .ephemeral,
            delegate: RejectRedirectURLSessionDelegate.shared,
            delegateQueue: nil
        )
    }

    public static func validate(_ url: URL) throws {
        let loopback = url.host == "127.0.0.1" || url.host == "localhost" || url.host == "::1"
        guard url.scheme == "http",
              loopback,
              url.user == nil,
              url.password == nil,
              url.port != nil,
              url.path.isEmpty || url.path == "/",
              url.query == nil,
              url.fragment == nil
        else { throw ExarchError.invalidPayload("Daemon API URL must be an unauthenticated loopback address") }
    }

    public func request(
        method: String,
        path: String,
        headers: [String: String],
        body: Data
    ) async throws -> (Int, Data) {
        guard path.hasPrefix("/api/v1/"), !path.contains(".."), !path.contains("\\") else {
            throw ExarchError.invalidPayload("Only /api/v1 paths may be requested")
        }
        guard let url = URL(string: path, relativeTo: baseURL),
              url.absoluteURL.host == baseURL.host,
              url.absoluteURL.port == baseURL.port
        else { throw ExarchError.invalidPayload("Request escaped the daemon API boundary") }

        var request = URLRequest(url: url.absoluteURL)
        request.httpMethod = method
        request.timeoutInterval = 30
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if method == "POST" { request.httpBody = body }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ExarchError.unavailable("The daemon returned no HTTP response")
        }
        guard data.count <= 1024 * 1024 else { throw ExarchError.responseTooLarge }
        return (http.statusCode, data)
    }
}
