# happy-ios

The native iOS client for Happy: Swift, UIKit and GRDB.
Read [AGENTS.md](AGENTS.md) before changing anything.
It has the rules, the target layout and how to build on Linux (with `swift`
and `xtool`) and on macOS (with XcodeGen and Xcode).

The app requires iOS 26 and Swift 6.2. Home's list and both chats draw on
UltraView's UltraList; see [Home list](docs/HOME-RENDERERS.md) and
[Chat list](docs/CHAT-RENDERERS.md) for the implementation and checks.

```sh
swift test --build-system native   # Linux or macOS: crypto, wire, store, sync, layout
xtool dev build                    # Linux: the dev app bundle, needs `xtool sdk`
xcodegen && open Happy.xcodeproj   # macOS
```

## Codex native configuration development

The personal downstream fork adds a read-only view for Happy CLI sessions started with `happy codex --native-config`. The composer reads the model, reasoning effort and permission values published from Codex's resolved thread response. It ignores old composer picks and account defaults for those sessions, and sends prompts without model, effort or permission overrides. Other session modes keep their existing behavior. See the [CLI development status](../happy-cli/README.md#codex-手机接续开发分支验证状态) for the remaining end-to-end checks.

This is development work, not a released iPhone build. Core tests run on macOS with `swift test --build-system native --filter NativeConfigComposerTests`; they do not compile UIKit or prove device behavior. A simulator runtime is required for the Xcode simulator build. Device installation additionally needs a signing team and Developer Mode. Use a separate, developer-owned bundle identity for a personal build so it does not replace the official app.

An Apple Personal Team can test on a personal device, but its provisioning expires after seven days; see [Apple's account overview](https://developer.apple.com/help/account/basics/about-your-developer-account/). Apple's [capability table](https://developer.apple.com/help/account/reference/supported-capabilities-ios/) does not provide remote push or Sign in with Apple to free accounts. The `Happy Personal` scheme uses `com.lindong28.happy.personal`, an empty entitlement set and a separate app named Happy Personal. It leaves the upstream variants intact, omits the official `happy` URL scheme, and pairs through its own in-app scanner. It does not register for remote push; its notification settings report Unsupported. Long-term notification delivery remains unverified: the upstream app exchanges APNs tokens through its Expo project, so changing only a bundle identifier does not establish fork notification delivery.

From this directory, generate and build the development variant:

```sh
xcodegen
xcodebuild -project Happy.xcodeproj -scheme 'Happy Personal' \
  -configuration Personal -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build-personal CODE_SIGNING_ALLOWED=NO build
```

The simulator build completed on Xcode 26.6 with the iOS 26.5 runtime. A Personal Team build was also signed, installed and opened on an iPhone 14 running iOS 27.2. That device completed pairing, prompt exchange, native blocking/asynchronous questions, an ask-user MCP form, full local configuration details and session resume after a native Codex CLI round. Reinstalling the updated build preserved its account and conversation. These are development checks on one phone and one Mac; remote notifications, cellular recovery and multiple machines remain unverified.

`Personal` uses release compilation conditions consistently with its Swift packages, while keeping automatic development signing. On-device builds require your own `DEVELOPMENT_TEAM`, a connected trusted iPhone with Developer Mode enabled, and an Apple Account signed into Xcode. Trust your own developer certificate in iPhone Settings if first launch requires it. Other adopters must supply their own `PRODUCT_BUNDLE_IDENTIFIER` as an Xcode build setting. Do not use this development scheme for App Store distribution.

## Production continuation

The native iOS app continues the existing `com.ex3ndr.happy` App Store Connect
listing, following the React Native app's 1.8.0 (154) and the first native
2.0.0 builds (155–157). The next production build is **2026.11.1 (158)**, for
TestFlight. Development and preview keep their separate bundle identities and
share the same version. The version is set once in `project.yml` (see
[Versioning](AGENTS.md#versioning)); production's build number is set in
`App/Info-Production.plist` and the Happy target's Release settings. The
client header reads the bundled version. Keep the existing signing team and
default Keychain access group so the RN credentials and Expo installation ID
survive an in-place upgrade.

Follow [the release skill](../../.agents/skills/release/SKILL.md) from a clean
local `main` matching freshly fetched `origin/main`. Production signs manually
with the distribution certificate and profile and uploads with the App Store
Connect API key: the Xcode account on the release Mac has no access to this
app. App Review submission and public release each need separate user
authorization. An upload gets no tag: report its upload ID and binary
SHA-256. When a build is released publicly on the App Store, tag its exact
source commit `native-ios-<version>-build<build>`; that moves the version
on (see [Versioning](AGENTS.md#versioning)). Never move an existing tag. No
GitHub Release is needed for a native build.

## Native Mac app

`HappyMac` is a genuine **AppKit / macOS SDK** target, not Catalyst,
"Designed for iPad", SwiftUI, or the Tauri client. UIKit and AppKit share
account composition, SQLite, crypto, sync and presentation models through
`HappyClientKit`, while keeping their views separate. Requires macOS 14+
and Xcode 26+ (Swift 6.2). This is a functional relay-client port, not yet
full mobile feature parity.
See [Mac build and behavior](docs/MAC.md) for building, testing and limitations.

```sh
xcodegen
xcodebuild -project Happy.xcodeproj -scheme 'Happy Mac' \
  -destination 'platform=macOS' \
  -derivedDataPath .build-mac build
open .build-mac/Build/Products/Debug/HappyMac.app
```

The chat fixtures (`Sources/HappyUI/Chat/Fixtures`) are built in Debug and
where `HAPPY_FIXTURES` is set, never in the shipped app. The hosted tests use
them, so to run those in Preview:

```sh
xcodebuild test -scheme HappyUIKitHosted -configuration Preview ENABLE_TESTABILITY=YES \
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS=\$(inherited) HAPPY_FIXTURES" ...
```
