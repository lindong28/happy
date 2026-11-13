import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

final class HomeMachineFilterTests: XCTestCase {
    private func fixture() -> LegacyHomeSnapshot {
        var snapshot = ApplyPerfFixtures.snapshot(4)
        snapshot.machines.machines = ["book", "mini", "studio"].map { id in
            var machine = ApplyPerfFixtures.machine
            machine.id = id
            machine.metadata = .object(["host": .string(id)])
            return machine
        }
        for (index, id) in ["book", "mini", "studio", "book"].enumerated() {
            var metadata = snapshot.sessions[index].metadata!.objectValue!
            metadata["machineId"] = .string(id)
            snapshot.sessions[index].metadata = .object(metadata)
        }
        snapshot.sessions[3].active = false
        return snapshot
    }

    private func input(_ snapshot: LegacyHomeSnapshot, _ selected: String?) -> HomeDerivation.Input {
        var input = HomeDerivation.Input(snapshot: snapshot, clock: ApplyPerfFixtures.clock)
        input.selectedMachineId = selected
        input.preparesArchives = true
        return input
    }

    func testAllAndEachComputerInBothGroupingsIncludeOnlyTheirHistory() throws {
        for grouping in ["flat", "project"] {
            var snapshot = fixture()
            snapshot.settings.pending["sessionListGrouping"] = .string(grouping)
            snapshot.settings.pending["hideInactiveSessions"] = .bool(false)
            let options = HomeMachineOption.collect(snapshot)
            for (selection, expected) in [(nil, [0, 1, 2, 3]), ("book", [0, 3]), ("mini", [1]), ("studio", [2])] as [(String?, [Int])] {
                let scoped = HomeMachineFilter.snapshot(snapshot, selectedId: selection, options: options)
                XCTAssertEqual(Set(scoped.sessions.map(\.id)), Set(expected.map { snapshot.sessions[$0].id }))
                let update = try XCTUnwrap(HomeDerivation.derive(input(snapshot, selection), applied: .init())).output
                XCTAssertEqual(update.machines.map(\.id), ["book", "mini", "studio"])
                let listed = try XCTUnwrap(update.content.list)
                for index in expected { XCTAssertTrue(listed.rows.compactMap(\.sessionId).contains(snapshot.sessions[index].id), "\(grouping) \(selection ?? "all") \(listed.ids)") }
                for index in (0..<4).filter({ !expected.contains($0) }) { XCTAssertFalse(listed.rows.compactMap(\.sessionId).contains(snapshot.sessions[index].id)) }
            }
        }
    }

    func testArchiveToggleCannotBringBackOtherComputers() throws {
        var snapshot = fixture()
        snapshot.sessions[1].active = false
        let update = try XCTUnwrap(HomeDerivation.derive(input(snapshot, "book"), applied: .init())).output
        let archives = try XCTUnwrap(update.archiveModels)
        XCTAssertTrue(archives.shown.rows.compactMap(\.sessionId).contains(snapshot.sessions[3].id))
        XCTAssertFalse(archives.hidden.rows.compactMap(\.sessionId).contains(snapshot.sessions[3].id))
        XCTAssertFalse(archives.shown.rows.compactMap(\.sessionId).contains(snapshot.sessions[1].id))
    }

    func testOfflineSelectionKeepsHistoryAndDoesNotBorrowAnotherMachinesPresence() throws {
        var snapshot = fixture()
        snapshot.machines.machines[0].active = false
        let update = try XCTUnwrap(HomeDerivation.derive(input(snapshot, "book"), applied: .init())).output
        XCTAssertEqual(update.content.list?.offline?.map(\.id), ["book"])
        XCTAssertTrue(update.content.list?.rows.compactMap(\.sessionId).contains(snapshot.sessions[0].id) == true)
        let missing = try XCTUnwrap(HomeDerivation.derive(input(snapshot, "removed"), applied: .init())).output
        XCTAssertEqual(missing.content.kind, .noSessions)
        XCTAssertEqual(missing.selectedMachineId, "removed")
    }

    func testSiblingRegistrationsGroupButEqualHostNamesDoNot() {
        var snapshot = fixture()
        var sibling = snapshot.machines.machines[0]
        sibling.id = "book-agent"
        sibling.metadata = .object(["host": .string("book"), "machineKind": .string("rig"), "siblingMachineId": .string("book")])
        snapshot.machines.machines.append(sibling)
        snapshot.machines.machines[1].metadata = .object(["host": .string("book")])
        snapshot.sessions[3].metadata = .object(["machineId": .string("book-agent")])
        let options = HomeMachineOption.collect(snapshot)
        XCTAssertEqual(options.count, 3)
        let scoped = HomeMachineFilter.snapshot(snapshot, selectedId: "book-agent", options: options)
        XCTAssertEqual(Set(scoped.machines.machines.map(\.id)), ["book", "book-agent"])
        XCTAssertEqual(scoped.sessions.map(\.id), [snapshot.sessions[0].id, snapshot.sessions[3].id])
    }

    func testNewComputerAppearsWithoutChangingCurrentSelectionAndHeartbeatDoesNotApply() throws {
        var snapshot = fixture()
        let first = try XCTUnwrap(HomeDerivation.derive(input(snapshot, "book"), applied: .init()))
        for index in snapshot.machines.machines.indices { snapshot.machines.machines[index].activeAt += 10 }
        XCTAssertNil(HomeDerivation.derive(input(snapshot, "book"), applied: first.state))
        var new = ApplyPerfFixtures.machine
        new.id = "future"
        snapshot.machines.machines.append(new)
        let added = try XCTUnwrap(HomeDerivation.derive(input(snapshot, "book"), applied: first.state))
        XCTAssertEqual(added.output.machines.count, 4)
        XCTAssertFalse(added.output.contentChanged)
        XCTAssertEqual(added.output.selectedMachineId, "book")
        let all = try XCTUnwrap(HomeDerivation.derive(input(snapshot, nil), applied: added.state))
        XCTAssertTrue(all.output.contentChanged)
    }
}
