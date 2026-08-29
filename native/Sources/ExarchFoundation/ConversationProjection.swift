import Foundation

public struct ChatMessage: Identifiable, Equatable, Sendable {
    public enum Role: Equatable, Sendable { case user, assistant, status }

    public let id: String
    public let role: Role
    public let text: String
    public let provider: Provider?
    public let sequence: Int
    public let clientMessageID: String?

    public init(
        id: String,
        role: Role,
        text: String,
        provider: Provider?,
        sequence: Int,
        clientMessageID: String? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.provider = provider
        self.sequence = sequence
        self.clientMessageID = clientMessageID
    }
}

/// Transient presentation state for the latest message submitted from this
/// client. The canonical conversation remains event-backed; this only lets the
/// UI keep the turn indicator attached to the matching user message.
public struct ConversationTurnStatus: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case working
        case completed(TimeInterval)
    }

    public let clientMessageID: String
    public let phase: Phase

    public init(clientMessageID: String, phase: Phase) {
        self.clientMessageID = clientMessageID
        self.phase = phase
    }
}

public enum ConversationProjection {
    public static func pendingUserMessage(
        clientMessageID: String,
        text: String,
        provider: Provider
    ) -> ChatMessage {
        ChatMessage(
            id: "pending:\(clientMessageID)",
            role: .user,
            text: text,
            provider: provider,
            sequence: .max,
            clientMessageID: clientMessageID
        )
    }

    public static func containsUserMessage(
        clientMessageID: String,
        in events: [CanonicalEvent]
    ) -> Bool {
        events.contains { event in
            guard event.type == "user.message",
                  case let .string(value)? = event.payload["clientMessageId"] else {
                return false
            }
            return value == clientMessageID
        }
    }

    public static func messages(from events: [CanonicalEvent]) -> [ChatMessage] {
        events.compactMap { event in
            switch event.type {
            case "user.message":
                event.visibleText.map {
                    ChatMessage(
                        id: event.id,
                        role: .user,
                        text: $0,
                        provider: event.provider,
                        sequence: event.sequence,
                        clientMessageID: clientMessageID(from: event)
                    )
                }
            case "assistant.message.completed":
                event.visibleText.map {
                    ChatMessage(id: event.id, role: .assistant, text: $0, provider: event.provider, sequence: event.sequence)
                }
            case "provider.handoff.completed":
                ChatMessage(
                    id: event.id,
                    role: .status,
                    text: "Context handed to \(event.provider?.displayName ?? "the selected harness")",
                    provider: event.provider,
                    sequence: event.sequence
                )
            default: nil
            }
        }
    }

    private static func clientMessageID(from event: CanonicalEvent) -> String? {
        guard case let .string(value)? = event.payload["clientMessageId"] else { return nil }
        return value
    }
}
