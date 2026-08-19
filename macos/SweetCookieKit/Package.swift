// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SweetCookieKit",
    platforms: [.macOS(.v13)],
    products: [.library(name: "SweetCookieKit", targets: ["SweetCookieKit"])],
    targets: [
        .target(
            name: "SweetCookieKit",
            path: "Sources/SweetCookieKit",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
    ]
)
