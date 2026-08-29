#if os(iOS)
import SwiftUI
import UIKit

/// Puts back the swipe-from-the-left-edge gesture that
/// `navigationBarBackButtonHidden(true)` takes away.
///
/// UIKit installs `interactivePopGestureRecognizer` with the navigation
/// controller as its delegate, and that delegate refuses to begin when the
/// navigation bar's back item is missing. Replacing the delegate with one that
/// only asks whether there is something to pop restores the gesture without
/// touching anything else.
///
/// Scoped deliberately: the delegate is installed when this screen appears and
/// the original is put back when it goes away, so no other screen inherits the
/// change. That is why this is not an extension on `UINavigationController`,
/// which is the usual shortcut and applies process-wide.
private struct InteractivePopGestureRestorer: UIViewControllerRepresentable {
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        weak var navigationController: UINavigationController?
        weak var originalDelegate: (any UIGestureRecognizerDelegate)?
        var didInstall = false

        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            // Beginning a pop on the root view controller is what crashes, so
            // this is the one condition worth checking.
            (navigationController?.viewControllers.count ?? 0) > 1
        }

        /// Let the gesture coexist with the scroll view underneath it.
        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            false
        }

        func install(on controller: UINavigationController) {
            guard !didInstall else { return }
            navigationController = controller
            originalDelegate = controller.interactivePopGestureRecognizer?.delegate
            controller.interactivePopGestureRecognizer?.delegate = self
            controller.interactivePopGestureRecognizer?.isEnabled = true
            didInstall = true
        }

        func restore() {
            guard didInstall, let controller = navigationController else { return }
            controller.interactivePopGestureRecognizer?.delegate = originalDelegate
            didInstall = false
        }
    }

    final class Host: UIViewController {
        var onAppear: ((UINavigationController) -> Void)?
        var onDisappear: (() -> Void)?

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            if let controller = navigationController ?? parent?.navigationController {
                onAppear?(controller)
            }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            onDisappear?()
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> Host {
        let host = Host()
        host.view.isUserInteractionEnabled = false
        host.onAppear = { [coordinator = context.coordinator] controller in
            coordinator.install(on: controller)
        }
        host.onDisappear = { [coordinator = context.coordinator] in
            coordinator.restore()
        }
        return host
    }

    func updateUIViewController(_ host: Host, context: Context) {}

    static func dismantleUIViewController(_ host: Host, coordinator: Coordinator) {
        coordinator.restore()
    }
}

public extension View {
    /// Restores swipe-to-pop on a screen that hides the system back button.
    ///
    /// Attach it wherever `navigationBarBackButtonHidden(true)` is used with a
    /// replacement back control, or the screen becomes reachable only by
    /// tapping.
    func interactivePopGestureRestored() -> some View {
        background(InteractivePopGestureRestorer().frame(width: 0, height: 0).accessibilityHidden(true))
    }
}
#endif
