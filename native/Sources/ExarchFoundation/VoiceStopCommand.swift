import Foundation

public enum VoiceStopCommand {
    /// If a finalized transcript ends in the spoken word "stop", returns the
    /// transcript with that trailing word removed (trimmed, so a bare "stop"
    /// yields an empty string).
    ///
    /// Callers must not use this parser to act on provisional speech-recognition
    /// hypotheses. A partial sentence can temporarily end in "stop" before the
    /// recognizer appends the words that follow it.
    /// Returns `nil` when the transcript does not end in the stop word.
    public static func remainder(afterTrailingStopWordIn transcript: String) -> String? {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        var words = trimmed.split(separator: " ")
        guard let lastWord = words.last else { return nil }
        let normalized = lastWord.lowercased().trimmingCharacters(in: .punctuationCharacters)
        guard normalized == "stop" else { return nil }
        words.removeLast()
        return words.joined(separator: " ")
    }
}
