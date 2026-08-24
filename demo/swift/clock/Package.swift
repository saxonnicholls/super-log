// swift-tools-version: 6.2
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  A path dependency on the SDK next door, so the demo builds from a fresh
//  clone with no registry, no lockfile and no network.
//
//  The package sits one level down, in demo/swift/clock rather than
//  demo/swift, because SwiftPM identifies a package by its directory name:
//  a package in demo/swift and a package in sdk/swift are both "swift", and
//  the second is then read as a self-reference rather than a dependency.
//
import PackageDescription

let package = Package(
    name: "clock",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../../../sdk/swift")
    ],
    targets: [
        .executableTarget(
            name: "clock",
            // SwiftPM identifies a path dependency by its directory name, so
            // the package this product comes from is spelled "swift" even
            // though both the package and the product are called SuperLog.
            dependencies: [.product(name: "SuperLog", package: "swift")],
            path: "Sources/clock"
        )
    ]
)
