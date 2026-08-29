import Foundation

public enum Provider: String, Codable, CaseIterable, Identifiable, Sendable {
    case codex
    case claude
    case hermes

    public var id: String { rawValue }
    public var displayName: String {
        switch self {
        case .codex: "Codex"
        case .claude: "Claude Code"
        case .hermes: "Hermes"
        }
    }
}

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON") }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct ProviderHealth: Codable, Equatable, Sendable {
    public let provider: Provider
    public let available: Bool
    public let version: String?
    public let detail: String
    public let reason: String?

    public var unavailableMessage: String {
        "\(provider.displayName) cannot be used: \(detail)"
    }
}

public struct ProviderModel: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let displayName: String
    public let description: String?

    public init(id: String, displayName: String, description: String? = nil) {
        self.id = id
        self.displayName = displayName
        self.description = description
    }
}

public struct EffectivePolicy: Codable, Equatable, Sendable {
    public struct Normalized: Codable, Equatable, Sendable {
        public let mayExecuteWithoutPrompt: Bool?
        public let sandbox: String?
        public let reviewer: String?
    }

    public let provider: Provider
    public let status: String
    public let revision: String
    public let observedAt: String
    public let source: String
    public let native: [String: JSONValue]
    public let normalized: Normalized
}

public struct ProviderCapacityWindow: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let usedPercent: Double?
    public let remainingPercent: Double?
    public let resetsAt: String?
}

public struct ProviderCapacity: Codable, Equatable, Sendable {
    public let provider: Provider
    public let status: String
    public let observedAt: String
    public let source: String
    public let detail: String
    public let windows: [ProviderCapacityWindow]
}

public struct ProviderSnapshot: Codable, Equatable, Sendable {
    public let health: ProviderHealth
    public let policy: EffectivePolicy
    public let models: [ProviderModel]?
    public let capacity: ProviderCapacity?

    public init(
        health: ProviderHealth,
        policy: EffectivePolicy,
        models: [ProviderModel]? = nil,
        capacity: ProviderCapacity? = nil
    ) {
        self.health = health
        self.policy = policy
        self.models = models
        self.capacity = capacity
    }
}

public struct Project: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let repoRoot: String
    public let allowedPaths: [String]
    public let createdAt: String
}

public struct Conversation: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let projectId: String
    public let title: String
    public let status: String
    public let activeProvider: Provider?
    public let fallbackRoute: [Provider]
    public let pinned: Bool
    public let nextSequence: Int
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String,
        projectId: String,
        title: String,
        status: String,
        activeProvider: Provider?,
        fallbackRoute: [Provider]? = nil,
        pinned: Bool = false,
        nextSequence: Int,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.projectId = projectId
        self.title = title
        self.status = status
        self.activeProvider = activeProvider
        self.fallbackRoute = fallbackRoute ?? activeProvider.map { [$0] } ?? []
        self.pinned = pinned
        self.nextSequence = nextSequence
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, projectId, title, status, activeProvider, fallbackRoute, pinned
        case nextSequence, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        projectId = try values.decode(String.self, forKey: .projectId)
        title = try values.decode(String.self, forKey: .title)
        status = try values.decode(String.self, forKey: .status)
        activeProvider = try values.decodeIfPresent(Provider.self, forKey: .activeProvider)
        fallbackRoute = try values.decodeIfPresent([Provider].self, forKey: .fallbackRoute)
            ?? activeProvider.map { [$0] }
            ?? []
        pinned = try values.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        nextSequence = try values.decode(Int.self, forKey: .nextSequence)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
    }

    public func nextFallback(after provider: Provider) -> Provider? {
        guard let index = fallbackRoute.firstIndex(of: provider),
              fallbackRoute.indices.contains(index + 1) else { return nil }
        return fallbackRoute[index + 1]
    }
}

public struct ConversationListPage: Codable, Equatable, Sendable {
    public let conversations: [Conversation]
    public let nextCursor: String?
    public let hasMore: Bool
}

public struct CanonicalEvent: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let conversationId: String
    public let turnId: String?
    public let sequence: Int
    public let type: String
    public let provider: Provider?
    public let payload: [String: JSONValue]
    public let previousHash: String
    public let eventHash: String
    public let occurredAt: String

    public var visibleText: String? {
        guard case let .string(text)? = payload["text"] else { return nil }
        return text
    }
}

public struct ContextSearchResult: Codable, Identifiable, Equatable, Sendable {
    public var id: String { event.id }
    public let event: CanonicalEvent
    public let snippet: String
    public let rank: Double
}

public struct RepositoryStatusEntry: Codable, Identifiable, Equatable, Sendable {
    public var id: String { "\(status):\(path)" }
    public let status: String
    public let path: String
}

public struct RepositoryUntrackedEntry: Codable, Identifiable, Equatable, Sendable {
    public var id: String { path }
    public let path: String
    public let sizeBytes: Int?
}

public struct RepositoryChanges: Codable, Equatable, Sendable {
    public let repositoryRoot: String
    public let isRepository: Bool
    public let branch: String?
    public let head: String?
    public let statusEntries: [RepositoryStatusEntry]
    public let untracked: [RepositoryUntrackedEntry]
    public let patch: String
    public let patchBytes: Int
    public let truncated: Bool
    public let redacted: Bool
    public let redactionMarkers: [String]
}

public struct Approval: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let conversationId: String
    public let turnId: String
    public let provider: Provider
    public let status: String
    public let request: [String: JSONValue]
    public let decision: [String: JSONValue]?
    public let expiresAt: String
    public let createdAt: String
    public let decidedAt: String?
}
