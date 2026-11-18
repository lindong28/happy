import HappyStore
import HappyWire

/// Persistent display projection of native Codex history. Relay records remain
/// on disk; both live updates and older pages pass through the same filter.
struct CodexRewindProjection {
    private let legacyThroughSeq: Double
    private let legacyInputSeq: Double
    private let discardedTurns: Set<String>
    private let discardedCalls: Set<String>
    private let threadId: String?
    private let inputRanges: [ClosedRange<Double>]

    init?(_ metadata: JSONValue?) {
        guard let value = metadata?["codexRewind"], value["version"]?.numberValue == 1,
              let through = value["legacyThroughSeq"]?.numberValue,
              let input = value["legacyInputSeq"]?.numberValue,
              through >= 0, input >= 0,
              let turns = value["discardedTurnIds"]?.arrayValue,
              let ranges = value["discardedInputRanges"]?.arrayValue else { return nil }
        threadId = metadata?["codexThreadId"]?.stringValue
        legacyThroughSeq = through
        legacyInputSeq = input
        discardedTurns = Set(turns.compactMap(\.stringValue))
        discardedCalls = Set(value["discardedCallIds"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        inputRanges = ranges.compactMap { range in
            guard let pair = range.arrayValue, pair.count == 2,
                  let first = pair[0].numberValue, let last = pair[1].numberValue,
                  first >= 0, last >= first else { return nil }
            return first...last
        }
    }

    func agentState(_ state: JSONValue?) -> JSONValue? {
        guard var object = state?.objectValue else { return state }
        for key in ["requests", "completedRequests"] {
            if let requests = object[key]?.objectValue {
                object[key] = .object(requests.filter { id, request in
                    let call = request["toolUseId"]?.stringValue ?? id
                    // The CLI scopes approval IDs as thread:item[:disambiguator].
                    return !discardedCalls.contains(where: { call == $0 || call.hasPrefix($0 + ":") })
                })
            }
        }
        return .object(object)
    }

    func includes(_ record: MessageRecord) -> Bool {
        let raw = record.content
        let content = raw?["content"]
        let envelope = content?["type"]?.stringValue == "session" ? content?["data"] : content
        let turn = raw?["role"]?.stringValue == "session" ? envelope?["turn"]?.stringValue : nil
        let phoneInput = raw?["role"]?.stringValue == "user" ||
            (raw?["role"]?.stringValue == "session" && envelope?["role"]?.stringValue == "user" && turn == nil)
        let seq = Double(record.seq)
        if seq > 0 && seq <= legacyThroughSeq && !(phoneInput && seq > legacyInputSeq) { return false }
        if let turn, discardedTurns.contains(turn) { return false }
        // Older native user text omitted turn, but retained its native item ID.
        // Match the same thread-scoped identity recorded before native revert.
        if raw?["role"]?.stringValue == "session",
           let threadId, let item = envelope?["codexItemId"]?.stringValue,
           discardedCalls.contains("\(threadId):\(item)") { return false }
        if phoneInput && inputRanges.contains(where: { $0.contains(seq) }) { return false }
        return true
    }
}
