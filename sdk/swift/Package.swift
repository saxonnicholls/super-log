// swift-tools-version: 6.2
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
//
//  No dependencies, and there never will be: a debugging tool that needs its
//  own dependency graph resolved before it can tell you why the dependency
//  graph broke is not much of a debugging tool. That rules out swift-log too
//  - see README.md for the five-line LogHandler you write in your own app if
//  you want the bridge.
//
//  Tools version 6.2 means the Swift 6 language mode: strict concurrency
//  checking is on, so the client's thread-safety claims are checked by the
//  compiler rather than asserted in a comment.
//
import PackageDescription

let package = Package(
    name: "SuperLog",
    platforms: [.macOS(.v13), .iOS(.v16), .tvOS(.v16), .watchOS(.v9)],
    products: [
        .library(name: "SuperLog", targets: ["SuperLog"])
    ],
    targets: [
        .target(name: "SuperLog", path: "Sources/SuperLog")
    ]
)
