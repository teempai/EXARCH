import Foundation

public enum SpeakableText {
    public static func fromMarkdown(_ markdown: String) -> String {
        markdown
            .replacingOccurrences(of: #"```[\s\S]*?```"#, with: " Code block omitted. ", options: .regularExpression)
            .replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"!\[[^\]]*\]\([^\)]+\)"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\[([^\]]+)\]\([^\)]+\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"(^|\n)\s{0,3}#{1,6}\s*"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"[*_~>]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
