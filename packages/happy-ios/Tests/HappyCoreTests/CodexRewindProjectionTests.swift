import XCTest
import HappyStore
import HappyWire
@testable import HappyCore

final class CodexRewindProjectionTests: XCTestCase {
    private func metadata(legacy: Int = 0, input: Int = 0) -> JSONValue {
        .object(["codexRewind": .object([
            "version": .number(1), "legacyThroughSeq": .number(Double(legacy)),
            "legacyInputSeq": .number(Double(input)),
            "discardedTurnIds": .array([.string("discarded")]),
            "discardedCallIds": .array([.string("thread:removed-call")]),
            "discardedInputRanges": .array([.array([.number(3), .number(4)])]),
        ])])
    }

    private func answer(_ id: String, turn: String, seq: Int) -> MessageRecord {
        ChatRecords.stored(ChatRecords.normalized(id, raw: ChatRecords.session(
            id, turn: turn, event: .object(["t": .string("text"), "text": .string(id)]))), seq: seq)
    }

    func testPersistedProjectionHidesNativeAndPhoneInputsAndKeepsPendingInput() throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession(seq: 6, metadata: metadata())])
        try store.applyMessagePage(sessionId: "s", messages: [
            answer("keep", turn: "retained", seq: 1),
            answer("remove", turn: "discarded", seq: 2),
            ChatRecords.stored(ChatRecords.user("phone", localId: "echo"), seq: 3),
            answer("next", turn: "new", seq: 5),
            ChatRecords.stored(ChatRecords.user("queued"), seq: 6),
        ])
        // Even a stale outbox echo must not resurrect an input hidden by rewind.
        try store.enqueue(OutboxRecord(localId: "echo", kind: .message, sessionId: "s",
                                     payload: ChatRecords.user("phone").raw, createdAt: 100))
        var state = FeedState(sessionId: "s")
        let snapshot = state.apply(try store.chatPage(sessionId: "s"))
        XCTAssertEqual(snapshot.messages.map(\.id), ["keep:0", "next:0", "queued"])
        var reopened = FeedState(sessionId: "s")
        XCTAssertEqual(reopened.apply(try store.chatPage(sessionId: "s")).messages, snapshot.messages)
        XCTAssertEqual(try store.chatPage(sessionId: "s").records.count, 5) // Stored source is untouched.
        // Older pages arriving after rewind use the same projection.
        _ = try store.applyLiveMessage(answer("late-discarded", turn: "discarded", seq: 4))
        XCTAssertEqual(state.apply(try store.chatPage(sessionId: "s", afterRowId: state.lastRowId)).messages, snapshot.messages)
        var image = answer("late-desktop-image", turn: "discarded", seq: 7)
        image.content = ChatRecords.session("late-desktop-image", role: "user", turn: "discarded", event: .object([
            "t": .string("file"), "ref": .string("image-ref"), "name": .string("input.png"),
            "size": .number(9), "mimeType": .string("image/png"),
        ]), extra: ["codexItemId": .string("native-user-item")])
        _ = try store.applyLiveMessage(image)
        XCTAssertEqual(state.apply(try store.chatPage(sessionId: "s", afterRowId: state.lastRowId)).messages, snapshot.messages)
    }

    func testPreviouslyForwardedNativeTextWithoutTurnUsesScopedItemIdentity() throws {
        var value = try XCTUnwrap(metadata().objectValue)
        value["codexThreadId"] = .string("thread")
        let projection = try XCTUnwrap(CodexRewindProjection(.object(value)))
        var record = answer("native-input", turn: "retained", seq: 8)
        record.content = ChatRecords.session("native-input", role: "user", event: .object([
            "t": .string("text"), "text": .string("same text"),
        ]), extra: ["codexItemId": .string("removed-call")])
        XCTAssertFalse(projection.includes(record))
        value["codexThreadId"] = .string("different-thread")
        XCTAssertTrue(try XCTUnwrap(CodexRewindProjection(.object(value))).includes(record))
        record.content = ChatRecords.session("new-input", role: "user", event: .object([
            "t": .string("text"), "text": .string("same text"),
        ]), extra: ["codexItemId": .string("new-call")])
        XCTAssertTrue(projection.includes(record))
    }

    func testMetadataChangeInvalidatesLiveFeedWithoutRewritingStoredMessages() async throws {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([ChatRecords.storeSession(seq: 2)])
        try store.applyMessagePage(sessionId: "s", messages: [
            answer("keep", turn: "retained", seq: 1), answer("remove", turn: "discarded", seq: 2),
        ])
        var iterator = LocalChatFeed(store: store).snapshots(sessionId: "s").makeAsyncIterator()
        let before = await iterator.next()
        XCTAssertEqual(before?.messages.count, 2)
        var session = ChatRecords.storeSession(seq: 2, metadata: metadata())
        session.metadataVersion = 2
        try store.upsertSessions([session])
        let after = await iterator.next()
        XCTAssertEqual(after?.messages.map(\.id), ["keep:0"])
        XCTAssertEqual(after?.windowEpoch, 1)
    }

    func testLegacyResetKeepsUnconsumedInputsAndFiltersFilesAndNestedEnvelopes() throws {
        let projection = try XCTUnwrap(CodexRewindProjection(metadata(legacy: 10, input: 5)))
        XCTAssertFalse(projection.includes(ChatRecords.stored(ChatRecords.user("old"), seq: 5)))
        XCTAssertTrue(projection.includes(ChatRecords.stored(ChatRecords.user("waiting"), seq: 6)))
        XCTAssertFalse(projection.includes(answer("old-answer", turn: "retained", seq: 9)))
        XCTAssertTrue(projection.includes(answer("new-answer", turn: "retained", seq: 11)))
        var file = answer("file", turn: "discarded", seq: 12)
        file.content = .object(["role": .string("session"), "content": .object([
            "type": .string("session"), "data": .object(["role": .string("user"), "ev": .object(["t": .string("file")])]),
        ])])
        XCTAssertTrue(projection.includes(file))
        file.seq = 4
        XCTAssertFalse(projection.includes(file))
        file.content = .object(["role": .string("session"), "content": .object([
            "type": .string("session"), "data": .object(["role": .string("agent"), "turn": .string("discarded")]),
        ])])
        file.seq = 12
        XCTAssertFalse(projection.includes(file))
    }

    func testDiscardedApprovalsAndLegacyCompletedStubsDoNotReappear() throws {
        let store = try LocalStore.inMemory()
        let permissions = ChatRecords.json(#"{"requests":{"thread:removed-call:approval":{"tool":"Bash","createdAt":100},"new-call":{"tool":"Bash","createdAt":101}},"completedRequests":{"old-call":{"tool":"Bash","createdAt":99,"status":"approved"}}}"#)
        try store.upsertSessions([ChatRecords.storeSession(metadata: metadata(), agentState: permissions)])
        var state = FeedState(sessionId: "s")
        let snapshot = state.apply(try store.chatPage(sessionId: "s"))
        XCTAssertEqual(snapshot.messages.map(\.id), ["permission:new-call"])
    }
}
