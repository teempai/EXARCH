// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ExarchNative",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "ExarchFoundation", targets: ["ExarchFoundation"]),
        .library(name: "ExarchUI", targets: ["ExarchUI"]),
        .executable(name: "exarch-native-interop", targets: ["ExarchNativeInterop"]),
        .executable(name: "exarch-keychain", targets: ["ExarchKeychainHelper"]),
        .executable(name: "exarch-service", targets: ["ExarchService"]),
        .executable(name: "exarch-ios-compile", targets: ["ExarchiOSCompile"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/swift-libp2p/swift-noise.git",
            revision: "0adfd28786322784860fb3c8f228591c6e8fd92f"
        ),
        .package(url: "https://github.com/apple/swift-crypto.git", exact: "4.5.1"),
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui.git", exact: "2.4.1")
    ],
    targets: [
        .target(
            name: "ExarchFoundation",
            dependencies: [
                .product(name: "Noise", package: "swift-noise"),
                .product(name: "Crypto", package: "swift-crypto")
            ]
        ),
        .target(
            name: "ExarchUI",
            dependencies: [
                "ExarchFoundation",
                .product(name: "MarkdownUI", package: "swift-markdown-ui")
            ],
            // Cinzel ships with the module rather than with either app bundle,
            // so both apps and SwiftUI previews resolve it the same way and
            // neither Info.plist needs a font declaration.
            resources: [.process("Resources")]
        ),
        .executableTarget(name: "ExarchNativeInterop", dependencies: ["ExarchFoundation"]),
        .executableTarget(name: "ExarchKeychainHelper", dependencies: ["ExarchFoundation"]),
        .executableTarget(name: "ExarchService"),
        .executableTarget(
            name: "ExarchiOSCompile",
            dependencies: ["ExarchFoundation", "ExarchUI"],
            path: "Apps/iOS",
            exclude: ["Info.plist", "EXARCH.entitlements", "Assets.xcassets"]
        ),
        .testTarget(name: "ExarchFoundationTests", dependencies: ["ExarchFoundation"]),
        .testTarget(name: "ExarchUITests", dependencies: ["ExarchUI"])
    ]
)
