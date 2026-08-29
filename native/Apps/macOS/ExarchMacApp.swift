import ExarchFoundation
import ExarchUI
import SwiftUI

@main
struct ExarchMacApp: App {
    @StateObject private var onboarding = DesktopAppModel()
    @StateObject private var appearance = AppearanceStore()
    @StateObject private var client = DesktopClientModel(
        enrollment: LocalDeviceEnrollment(executable: DesktopPaths.setupExecutable),
        dataDirectory: DesktopPaths.dataDirectory
    )

    var body: some Scene {
        WindowGroup {
            DesktopClientView(model: client, onboarding: onboarding, appearance: appearance)
                .frame(minWidth: 900, minHeight: 560)
                .preferredColorScheme(appearance.preference.colorScheme)
                .task { await onboarding.inspect() }
        }
        .defaultSize(width: 1280, height: 800)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Conversation") { client.showNewConversation = true }
                    .keyboardShortcut("n")
            }
        }

    }
}

/// Where the daemon keeps its configuration and where the installer puts the
/// command-line tools. Both are fixed by the installer.
enum DesktopPaths {
    static var applicationSupport: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/EXARCH")
    }
    static var dataDirectory: URL { applicationSupport.appendingPathComponent("data") }
    static var setupExecutable: URL {
        applicationSupport.appendingPathComponent("runtime/bin/exarch-setup")
    }
}
