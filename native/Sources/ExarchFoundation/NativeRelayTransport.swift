import Foundation

public actor NativeRelayTransport: RemoteRequestTransport {
    private let route: RelayRouteConfiguration
    private let identityStore: LibP2PIdentityStore
    private let session: URLSession
    private var connection: NativeNoiseConnection?
    private var decoder = RelayApplicationCodec()

    public init(
        route: RelayRouteConfiguration,
        identityStore: LibP2PIdentityStore = LibP2PIdentityStore(),
        session: URLSession? = nil
    ) {
        self.route = route
        self.identityStore = identityStore
        self.session = session ?? URLSession(
            configuration: .ephemeral,
            delegate: RejectRedirectURLSessionDelegate.shared,
            delegateQueue: nil
        )
    }

    public func request(
        method: String,
        path: String,
        headers: [String: String],
        body: Data
    ) async throws -> (Int, Data) {
        let requestID = "request_\(UUID().uuidString.lowercased())"
        let frame = try RelayHTTPRequest(
            requestId: requestID,
            method: method,
            path: path,
            headers: headers,
            body: body
        )
        let encoded = try RelayApplicationCodec.encode(frame)
        let active = try await connected()
        do {
            for start in stride(from: 0, to: encoded.count, by: NativeNoiseConnection.maximumPlaintextFrameBytes) {
                let end = min(start + NativeNoiseConnection.maximumPlaintextFrameBytes, encoded.count)
                try await active.send(encoded.subdata(in: start..<end))
            }
            while true {
                for payload in try decoder.append(try await active.receive()) {
                    let response = try JSONDecoder().decode(RelayHTTPResponse.self, from: payload)
                    guard response.version == 1,
                          response.type == "http.response",
                          response.requestId == requestID,
                          (100...599).contains(response.status),
                          response.contentType.count <= 200,
                          let decodedBody = response.decodedBody,
                          decodedBody.count <= RelayApplicationCodec.maximumBodyBytes
                    else { throw ExarchError.invalidPayload("Invalid relay response") }
                    return (response.status, decodedBody)
                }
            }
        } catch {
            await active.close()
            connection = nil
            decoder = RelayApplicationCodec()
            throw error
        }
    }

    public func disconnect() async {
        await connection?.close()
        connection = nil
        decoder = RelayApplicationCodec()
    }

    private func connected() async throws -> NativeNoiseConnection {
        if let connection { return connection }
        let ticket = try await requestTicket()
        let identity = try await identityStore.identity()
        let created = try await NativeNoiseConnection.connect(
            route: route,
            ticket: ticket,
            identity: identity,
            session: session
        )
        connection = created
        return created
    }

    private func requestTicket() async throws -> String {
        // Check the endpoint before the access token leaves the device. This
        // used to run only inside NativeNoiseConnection.connect, which happens
        // after the token has already been sent in an Authorization header.
        try NativeNoiseConnection.validateRelayURL(route.relayWebSocketURL)
        guard route.accessToken.count >= 32, route.accessToken.count <= 4096 else {
            throw ExarchError.authenticationFailed
        }
        var components = URLComponents(url: route.relayWebSocketURL, resolvingAgainstBaseURL: false)
        components?.scheme = route.relayWebSocketURL.scheme == "wss" ? "https" : "http"
        components?.path = "/v1/tickets"
        guard let endpoint = components?.url else { throw ExarchError.invalidEncoding }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 10
        request.setValue("Bearer \(route.accessToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 201,
              http.url == endpoint,
              (http.expectedContentLength < 0 || http.expectedContentLength <= 8192),
              data.count <= 8192
        else { throw ExarchError.authenticationFailed }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["routingId", "role", "ticket"])
        else { throw ExarchError.invalidPayload("Invalid relay ticket response") }
        let credential = try JSONDecoder().decode(RelayTicketResponse.self, from: data)
        guard credential.routingId == route.routingID,
              credential.role == "device",
              credential.ticket.count >= 32,
              credential.ticket.count <= 4096
        else { throw ExarchError.authenticationFailed }
        return credential.ticket
    }
}

final class RejectRedirectURLSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = RejectRedirectURLSessionDelegate()

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

private struct RelayTicketResponse: Codable {
    let routingId: String
    let role: String
    let ticket: String
}
