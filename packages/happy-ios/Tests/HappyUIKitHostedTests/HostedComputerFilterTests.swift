#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct FilterNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}
private struct FilterNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

@MainActor
final class HostedComputerFilterTests: XCTestCase {
    private func until(_ condition: () -> Bool) async throws {
        let end = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition())
    }

    func testComputerMenuFeedsComposeAndAllRestoresTheAccountList() async throws {
        LegacyFonts.registerBundledFonts()
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: FilterNoNetwork(), connector: FilterNoSockets())
        await account.restore()
        try await account.signIn(Credentials(token: "filter-fixture", secret: Data(repeating: 17, count: 32)))
        let session = try XCTUnwrap(account.session)
        let store = session.store
        try await Task.detached {
            try SeededAccount.seed(store)
            var second = try store.homeSnapshot().machines.machines[0]
            second.id = "filter-mini"
            second.metadata = .object(["host": .string("Mac mini")])
            try store.upsertMachine(second)
            var rig = second
            rig.id = "filter-rig"
            rig.metadata = .object(["host": .string("Task computer"), "machineKind": .string("rig"), "capabilities": .object(["newSession": .bool(true), "bots": .bool(true), "tasks": .bool(true)])])
            try store.upsertMachine(rig)
        }.value
        let context = AppContext(account: account, variant: .development, version: "test")
        let home = LegacyHomeViewController(context: context, session: session)
        let navigation = UINavigationController(rootViewController: home)
        let scene = try await hostedActiveScene()
        let previous = scene.keyWindow
        let window = UIWindow(windowScene: scene)
        window.rootViewController = navigation
        window.makeKeyAndVisible()
        addTeardownBlock { @MainActor in window.isHidden = true; previous?.makeKey() }
        try await until { (home.filterMenuElements().first as? UIMenu)?.children.count == 4 }
        let header = try XCTUnwrap(home.navigationItem.leftBarButtonItem?.customView as? AccountSwitcherButton)
        home.headerState = .online
        XCTAssertEqual(header.accessibilityIdentifier, "computer-filter")
        XCTAssertEqual(header.title, Strings.ComputerFilter.all)
        XCTAssertEqual(home.navigationItem.rightBarButtonItems?.compactMap(\.accessibilityIdentifier), ["settings"])
        let menu = try XCTUnwrap(home.filterMenuElements().first as? UIMenu)
        let mini = try XCTUnwrap(menu.children.compactMap { $0 as? UIAction }.first { $0.identifier.rawValue == "computer-filter-filter-mini" })
        UIButton(primaryAction: mini).sendActions(for: .primaryActionTriggered)
        try await until { home.children.contains { $0 is NoSessionsViewController } }
        let selected = home.filterMenuElements().first as? UIMenu
        XCTAssertEqual(selected?.children.compactMap { $0 as? UIAction }.first { $0.state == .on }?.title, "Mac mini")
        navigation.view.layoutIfNeeded()
        XCTAssertEqual(header.bounds.width, header.sizeThatFits(.zero).width, "Changing the computer must resize while online")
        for kind in ["session", "bot", "task"] {
            let drafts = NewSessionDraftStore.shared(for: account.localSettings)
            drafts.setCreatesBot(kind == "bot")
            drafts.setCreatesTask(kind == "task")
            home.compose()
            try await until { navigation.topViewController is LegacyChatViewController }
            let chat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
            let compose = try XCTUnwrap(chat.composeStart)
            await compose.composer.waitForIdle()
            XCTAssertEqual(compose.composer.choices.currentTarget?.id, "filter-mini", kind)
            XCTAssertEqual(drafts.draft.selectedMachineId, "filter-mini", kind)
            XCTAssertFalse(drafts.createsBot)
            XCTAssertFalse(drafts.createsTask)
            navigation.popViewController(animated: false)
            try await Task.sleep(for: .milliseconds(300))
        }
        let all = try XCTUnwrap((home.filterMenuElements().first as? UIMenu)?.children.first as? UIAction)
        UIButton(primaryAction: all).sendActions(for: .primaryActionTriggered)
        try await until { home.children.contains { $0 is SessionListViewController } }
        XCTAssertEqual((home.filterMenuElements().first as? UIMenu)?.children.compactMap { $0 as? UIAction }.first { $0.state == .on }?.title, Strings.ComputerFilter.all)
        navigation.view.layoutIfNeeded()
        XCTAssertEqual(header.bounds.width, header.sizeThatFits(.zero).width, "Returning to All computers must resize while online")
        home.compose()
        try await until { home.presentedViewController is UIAlertController }
        let picker = try XCTUnwrap(home.presentedViewController as? UIAlertController)
        XCTAssertEqual(picker.actions.map(\.title).compactMap { $0 }, ["Harness Mac", "Mac mini", "Task computer", Strings.Common.cancel])
        XCTAssertTrue(navigation.topViewController === home, "All computers must not reuse the last target silently")
        await withCheckedContinuation { continuation in
            picker.dismiss(animated: false) { continuation.resume() }
        }
        let options = HomeMachineOption.collect(try store.homeSnapshot())
        home.compose(on: try XCTUnwrap(options.first { $0.id == "filter-rig" }))
        try await until { navigation.topViewController is LegacyChatViewController }
        let chosenChat = try XCTUnwrap(navigation.topViewController as? LegacyChatViewController)
        let chosenCompose = try XCTUnwrap(chosenChat.composeStart)
        await chosenCompose.composer.waitForIdle()
        XCTAssertEqual(chosenCompose.composer.choices.currentTarget?.id, "filter-rig")
    }
}
#endif
