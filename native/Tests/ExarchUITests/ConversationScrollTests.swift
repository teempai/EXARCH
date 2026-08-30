import Testing
@testable import ExarchUI

@Suite("Conversation scrolling")
struct ConversationScrollTests {
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
