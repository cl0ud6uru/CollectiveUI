// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "CollectiveKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "CollectiveKit", targets: ["CollectiveKit"]),
    ],
    targets: [
        .target(name: "CollectiveKit"),
        .testTarget(name: "CollectiveKitTests", dependencies: ["CollectiveKit"]),
    ]
)
