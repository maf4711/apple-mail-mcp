// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AppleMailAI",
    platforms: [
        .macOS(.v26),
    ],
    products: [
        .executable(name: "apple-mail-ai", targets: ["AppleMailAI"]),
    ],
    targets: [
        .executableTarget(
            name: "AppleMailAI",
            path: "Sources/AppleMailAI"
        ),
    ]
)
