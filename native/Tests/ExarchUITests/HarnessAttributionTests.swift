import ExarchFoundation
import Testing
@testable import ExarchUI

/// The harness name marks a handoff rather than labelling every reply.
@Suite("Harness attribution")
struct HarnessAttributionTests {
    private func message(
        _ id: String,
        _ role: ChatMessage.Role,
        _ provider: Provider? = nil,
        sequence: Int = 0
    ) -> ChatMessage {
        ChatMessage(id: id, role: role, text: id, provider: provider, sequence: sequence)
    }

    @Test("the first reply is named and a repeat of the same harness is not")
    func firstAndRepeat() {
        let points = harnessAttributionPoints(in: [
            message("u1", .user),
            message("a1", .assistant, .codex),
            message("a2", .assistant, .codex)
        ])
        #expect(points == ["a1"])
    }

    /// A user message between two replies from one harness is not a handoff,
    /// so it must not cause the name to print again.
    @Test("a user message between replies does not reprint the name")
    func userInterleaved() {
        let points = harnessAttributionPoints(in: [
            message("a1", .assistant, .codex),
            message("u1", .user),
            message("a2", .assistant, .codex)
        ])
        #expect(points == ["a1"])
    }

    @Test("a switch is named, and switching back is named again")
    func switchesAreNamed() {
        let points = harnessAttributionPoints(in: [
            message("a1", .assistant, .codex),
            message("a2", .assistant, .claude),
            message("a3", .assistant, .claude),
            message("a4", .assistant, .codex)
        ])
        #expect(points == ["a1", "a2", "a4"])
    }

    @Test("status rows and replies with no provider are never named")
    func unattributable() {
        let points = harnessAttributionPoints(in: [
            message("s1", .status),
            message("a1", .assistant, nil),
            message("a2", .assistant, .codex)
        ])
        #expect(points == ["a2"])
    }
}
