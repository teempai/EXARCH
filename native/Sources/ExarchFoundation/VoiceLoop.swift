import Foundation

public enum VoiceLoopState: String, Equatable, Sendable {
    case text
    case idle
    case listening
    case transcribing
    case submitting
    case awaitingFinal
    case approvalBlocked
    case speaking
}

public enum VoiceLoopEvent: Equatable, Sendable {
    case enableVoice
    case disableVoice
    case beginListening
    case utteranceEnded
    case transcriptReady
    case submitted
    case approvalRequired
    case approvalResolved
    case finalReceived(hasText: Bool)
    case speechFinished
    case cancel
    case fail
}

public struct VoiceLoop: Equatable, Sendable {
    public private(set) var state: VoiceLoopState = .text

    public init() {}

    @discardableResult
    public mutating func handle(_ event: VoiceLoopEvent) -> VoiceLoopState {
        switch (state, event) {
        case (.text, .enableVoice): state = .idle
        case (_, .disableVoice): state = .text
        case (.idle, .beginListening), (.speaking, .speechFinished): state = .listening
        case (.listening, .utteranceEnded): state = .transcribing
        case (.transcribing, .transcriptReady): state = .submitting
        case (.submitting, .submitted): state = .awaitingFinal
        case (.awaitingFinal, .approvalRequired): state = .approvalBlocked
        case (.approvalBlocked, .approvalResolved): state = .awaitingFinal
        case (.awaitingFinal, .finalReceived(hasText: true)): state = .speaking
        case (.awaitingFinal, .finalReceived(hasText: false)), (_, .fail): state = .idle
        case (_, .cancel): state = state == .text ? .text : .idle
        default: break
        }
        return state
    }
}
