import MarkdownUI
import SwiftUI

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// Presents provider-authored Markdown without changing the canonical message
/// text stored on the laptop. Remote images are deliberately resolved only as
/// bundled assets, so displaying an agent response cannot trigger a tracking
/// request or disclose the phone's network address.
public struct MarkdownMessageView: View {
    private let source: String
    private let fontSize: CGFloat
    @State private var copiedCode: String?

    public init(_ source: String, fontSize: CGFloat = 16) {
        self.source = source
        self.fontSize = fontSize
    }

    public var body: some View {
        Markdown(source)
            .markdownTheme(theme)
            .markdownImageProvider(.asset)
            .markdownInlineImageProvider(.asset)
            .markdownBlockStyle(\.codeBlock) { configuration in
                codeBlock(configuration)
            }
            .textSelection(.enabled)
            .environment(\.openURL, OpenURLAction { url in
                guard let scheme = url.scheme?.lowercased(),
                      scheme == "https" || scheme == "http" else {
                    return .discarded
                }
                return .systemAction(url)
            })
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var theme: Theme {
        Theme.gitHub.text {
            ForegroundColor(FocusFlowTheme.ink)
            BackgroundColor(nil)
            FontSize(fontSize)
        }
    }

    private func codeBlock(_ configuration: CodeBlockConfiguration) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(codeLanguage(configuration.language))
                    .font(.system(.caption2, design: .monospaced).weight(.semibold))
                    .textCase(.uppercase)
                    .foregroundStyle(.white.opacity(0.68))
                Spacer()
                Button {
                    copy(configuration.content)
                } label: {
                    Label(
                        copiedCode == configuration.content ? "Copied" : "Copy",
                        systemImage: copiedCode == configuration.content ? "checkmark" : "doc.on.doc"
                    )
                    .font(.caption2.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white.opacity(0.82))
                .accessibilityHint("Copies this code block without Markdown fences")
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 36)

            Divider().overlay(.white.opacity(0.1))

            ScrollView(.horizontal) {
                configuration.label
                    .fixedSize(horizontal: true, vertical: false)
                    .relativeLineSpacing(.em(0.225))
                    .markdownTextStyle {
                        FontFamilyVariant(.monospaced)
                        FontSize(.em(0.85))
                        ForegroundColor(.white.opacity(0.92))
                    }
                    .padding(14)
            }
        }
        .background(FocusFlowTheme.terminal)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .stroke(.white.opacity(0.08))
        }
        .markdownMargin(top: 0, bottom: 16)
    }

    private func codeLanguage(_ language: String?) -> String {
        let trimmed = language?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "Code" : trimmed
    }

    private func copy(_ content: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = content
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(content, forType: .string)
        #endif
        copiedCode = content
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            if copiedCode == content { copiedCode = nil }
        }
    }
}
