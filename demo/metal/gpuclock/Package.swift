// swift-tools-version: 6.2
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  A path dependency on the SDK next door, so the demo builds from a fresh
//  clone with no registry, no lockfile and no network.
//
//  Nested one level down, in demo/metal/gpuclock, for the same reason the
//  Swift clock is: SwiftPM identifies a package by its DIRECTORY name, and a
//  flatter layout collides with the SDK's own.
//
//  macOS only, and only because Metal is. There is deliberately no Metal
//  code in the SDK itself - this demo exists to show that none is needed.
//
import PackageDescription

let package = Package(
    name: "gpuclock",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../../../sdk/swift")
    ],
    targets: [
        .executableTarget(
            name: "gpuclock",
            // The package is spelled by its directory name, "swift", even
            // though both the package and the product are called SuperLog.
            dependencies: [.product(name: "SuperLog", package: "swift")],
            path: "Sources/gpuclock"
        )
    ]
)
