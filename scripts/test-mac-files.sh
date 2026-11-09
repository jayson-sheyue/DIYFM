#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build/tests
xcrun swiftc -swift-version 5 -module-cache-path build/swift-cache clients/macos/NativeFiles.swift clients/macos/tests/main.swift -o build/tests/native-files
build/tests/native-files
