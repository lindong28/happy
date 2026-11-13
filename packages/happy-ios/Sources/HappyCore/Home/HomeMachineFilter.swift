import HappyStore

/// The home menu shows physical computers, using the same sibling grouping
/// as the new-session picker. Only rendered fields participate in equality.
public struct HomeMachineOption: Equatable, Sendable {
    public var id: String
    public var name: String
    public var machineIds: [String]
    public var online: Bool

    public static func collect(_ snapshot: LegacyHomeSnapshot) -> [Self] {
        MachineChoice.collect(snapshot.machines.machines).map {
            Self(id: $0.id, name: $0.name, machineIds: $0.machineIds.sorted(), online: $0.online)
        }.sorted {
            $0.name == $1.name ? $0.id < $1.id : $0.name < $1.name
        }
    }
}

public enum HomeMachineFilter {
    /// Nil shows the whole account, including sessions without a machine.
    /// An unavailable selection never silently broadens to other computers.
    public static func snapshot(_ snapshot: LegacyHomeSnapshot, selectedId: String?, options: [HomeMachineOption]) -> LegacyHomeSnapshot {
        guard let selectedId else { return snapshot }
        let ids = Set(options.first { $0.machineIds.contains(selectedId) }?.machineIds ?? [selectedId])
        var scoped = snapshot
        scoped.machines.machines = snapshot.machines.machines.filter { ids.contains($0.id) }
        scoped.sessions = snapshot.sessions.filter {
            guard let id = $0.metadata?["machineId"]?.stringValue else { return false }
            return ids.contains(id)
        }
        return scoped
    }
}
