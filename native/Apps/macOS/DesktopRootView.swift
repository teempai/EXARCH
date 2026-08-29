import AppKit
import CoreImage.CIFilterBuiltins
import ExarchUI
import SwiftUI

struct DesktopRootView: View {
    @ObservedObject var model: DesktopAppModel
    @Environment(\.dismiss) private var dismiss
    @State private var showingActivity = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Label("Pair a phone", systemImage: "iphone.and.arrow.forward")
                    .font(.title2.weight(.semibold))
                Spacer()
                Button("Close") { dismiss() }
            }

            Text("EXARCH creates one private relay route, then verifies the phone with a one-time high-entropy comparison code.")
                .font(.callout)
                .foregroundStyle(FocusFlowTheme.secondaryInk)

            pairingContent

            DisclosureGroup("Pairing activity", isExpanded: $showingActivity) {
                ScrollView {
                    Text(model.logLines.joined(separator: "\n"))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(FocusFlowTheme.terminalInk)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
                .frame(height: 130)
                .background(FocusFlowTheme.terminal, in: RoundedRectangle(cornerRadius: 8))
                HStack {
                    Spacer()
                    Button("Copy redacted activity", action: model.copyLogs)
                        .buttonStyle(.plain)
                        .font(.caption)
                }
            }

            if let error = model.pairingError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout)
                    .foregroundStyle(FocusFlowTheme.danger)
            }
        }
        .padding(24)
        .frame(width: 570)
        .background(FocusFlowTheme.canvas)
        .onDisappear {
            if model.pairingBusy { model.cancelPairing() }
        }
    }

    @ViewBuilder
    private var pairingContent: some View {
        if model.pairingConfigured, !model.pairingBusy {
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(FocusFlowTheme.success)
                Text("Pairing successful").font(.headline)
                Text("The phone can now reach this Mac through its private encrypted route.")
                    .font(.callout)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 22)
        } else if let sas = model.pendingSAS {
            VStack(alignment: .leading, spacing: 14) {
                Text("Do both devices show this code?").font(.headline)
                Text(sas)
                    .font(.system(size: 28, weight: .semibold, design: .monospaced))
                    .tracking(2)
                HStack {
                    Button("Codes match") { model.confirmPairing(true) }
                        .buttonStyle(.prominentBrass)
                    Button("Decline") { model.confirmPairing(false) }
                }
            }
        } else if let invitation = model.pairingInvitation {
            HStack(alignment: .top, spacing: 20) {
                if let image = qrCodeImage(for: invitation) {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 180, height: 180)
                        .padding(10)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityLabel("One-use phone pairing QR code")
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Ready to pair").font(.headline)
                    Text("Scan this code from EXARCH on your phone. It expires in five minutes and works once.")
                        .font(.callout)
                        .foregroundStyle(FocusFlowTheme.secondaryInk)
                    Button("Copy pairing code", action: model.copyInvitation)
                    Button("Cancel pairing", role: .cancel, action: model.cancelPairing)
                        .buttonStyle(.plain)
                        .foregroundStyle(FocusFlowTheme.secondaryInk)
                }
            }
        } else {
            Form {
                TextField("Relay address", text: $model.relayURL, prompt: Text("wss://relay.example/v1/relay"))
                    .font(.system(.body, design: .monospaced))
                SecureField("One-time administrator token", text: $model.administratorToken)
                Text("The token is passed directly to the local pairing process, used to create one route, and never saved.")
                    .font(.caption)
                    .foregroundStyle(FocusFlowTheme.secondaryInk)
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Create pairing code", action: model.startPairing)
                    .buttonStyle(.prominentBrass)
                    .disabled(!model.canStartPairing)
            }
        }
    }

    private func qrCodeImage(for value: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "L"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let context = CIContext()
        guard let image = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}
