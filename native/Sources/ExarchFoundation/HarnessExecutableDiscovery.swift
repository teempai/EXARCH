import Foundation

public enum HarnessExecutableDiscovery {
    public static func candidates(
        for provider: Provider,
        homeDirectory: URL
    ) -> [String] {
        let localBinary = homeDirectory.appending(path: ".local/bin/\(provider.rawValue)").path
        switch provider {
        case .codex:
            return [
                "/Applications/ChatGPT.app/Contents/Resources/codex",
                localBinary,
                "/opt/homebrew/bin/codex",
                "/usr/local/bin/codex"
            ]
        case .claude:
            return [
                localBinary,
                "/opt/homebrew/bin/claude",
                "/usr/local/bin/claude"
            ]
        case .hermes:
            return [
                localBinary,
                "/opt/homebrew/bin/hermes",
                "/usr/local/bin/hermes"
            ]
        }
    }

    public static func findExecutable(
        for provider: Provider,
        homeDirectory: URL,
        fileManager: FileManager = .default
    ) -> String? {
        firstExecutable(
            in: candidates(for: provider, homeDirectory: homeDirectory),
            fileManager: fileManager
        )
    }

    static func firstExecutable(in candidates: [String], fileManager: FileManager) -> String? {
        candidates.first(where: fileManager.isExecutableFile(atPath:))
    }

    #if os(macOS)
    public static func candidates(for provider: Provider) -> [String] {
        candidates(for: provider, homeDirectory: FileManager.default.homeDirectoryForCurrentUser)
    }

    public static func findExecutable(
        for provider: Provider,
        fileManager: FileManager = .default
    ) -> String? {
        findExecutable(
            for: provider,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            fileManager: fileManager
        )
    }
    #endif
}
