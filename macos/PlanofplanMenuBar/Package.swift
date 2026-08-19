// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PlanofplanMenuBar",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "PlanofplanMenuBar", targets: ["PlanofplanMenuBar"]),
    ],
    dependencies: [
        .package(path: "../SweetCookieKit"),
    ],
    targets: [
        .executableTarget(
            name: "PlanofplanMenuBar",
            dependencies: [
                .product(name: "SweetCookieKit", package: "SweetCookieKit"),
            ],
            path: "Sources/PlanofplanMenuBar"
        ),
    ]
)
