import Testing
import ExarchFoundation
@testable import ExarchUI

@Suite("Conversation scrolling")
struct ConversationScrollTests {
    @Test("working status stays below the sent message until later output arrives")
    func workingIndicatorPlacement() {
        let status = ConversationTurnStatus(clientMessageID: "message_local_1", phase: .working)
        let user = ChatMessage(
            id: "user_1",
            role: .user,
            text: "Do the work",
            provider: .codex,
            sequence: 1,
            clientMessageID: "message_local_1"
        )
        let assistant = ChatMessage(
            id: "assistant_1",
            role: .assistant,
            text: "First update",
            provider: .codex,
            sequence: 2
        )

        #expect(!shouldShowPersistentWorkingIndicator(messages: [user], turnStatus: status))
        #expect(shouldShowPersistentWorkingIndicator(messages: [user, assistant], turnStatus: status))
        #expect(!shouldShowPersistentWorkingIndicator(
            messages: [user, assistant],
            turnStatus: ConversationTurnStatus(clientMessageID: "message_local_1", phase: .completed(3))
        ))
    }

    @Test("initial cache and laptop reconciliation never issue competing scrolls")
    func loadingOwnsItsBottomAnchor() {
        #expect(!shouldFollowLatestMessage(
            isLoadingMessages: true,
            followingLatest: true,
            latestMessageID: "message-30"
        ))
        #expect(!shouldFollowLatestMessage(
            isLoadingMessages: true,
            followingLatest: false,
            latestMessageID: "pending:local-1"
        ))
    }

    @Test("live messages follow only when the reader is already at the bottom")
    func liveUpdatesRespectReadingPosition() {
        #expect(shouldFollowLatestMessage(
            isLoadingMessages: false,
            followingLatest: true,
            latestMessageID: "message-31"
        ))
        #expect(!shouldFollowLatestMessage(
            isLoadingMessages: false,
            followingLatest: false,
            latestMessageID: "message-31"
        ))
    }

    @Test("a locally submitted message returns the transcript to the bottom")
    func pendingMessageFollows() {
        #expect(shouldFollowLatestMessage(
            isLoadingMessages: false,
            followingLatest: false,
            latestMessageID: "pending:local-1"
        ))
    }
}
