import Foundation

/// Keeps cached desktop state out of the authoritative UI until the local
/// daemon has answered the first complete refresh. A missing launchd service
/// gets one automatic recovery attempt per foreground connection attempt.
public struct DesktopStartupGate: Equatable, Sendable {
    public enum OfflineAction: Equatable, Sendable {
        case restoreService
        case showOffline
    }

    public private(set) var recoveryAttempted = false
    public private(set) var authoritativeRefreshComplete = false

    public init() {}

    public mutating func actionForOfflineService() -> OfflineAction {
        guard !recoveryAttempted else { return .showOffline }
        recoveryAttempted = true
        return .restoreService
    }

    public mutating func recordAuthoritativeRefresh() {
        authoritativeRefreshComplete = true
    }

    public var mayPresentServiceState: Bool { authoritativeRefreshComplete }
}
