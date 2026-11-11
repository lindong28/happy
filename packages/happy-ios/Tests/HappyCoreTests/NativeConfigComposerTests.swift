import Foundation
import HappyCore
import HappyStore
import HappyWire
import XCTest

final class NativeConfigComposerTests: XCTestCase {
    private func metadata(_ native: Bool = true, model: String = "gpt-native-a", effort: String = "high") -> JSONValue {
        .object([
            "flavor": .string("codex"), "codexNativeConfig": .bool(native),
            "models": .array([.object(["code": .string(model), "value": .string(model)])]),
            "currentModelCode": .string(model),
            "operatingModes": .array([.object(["code": .string("native-config"), "value": .string("Local settings"), "description": .string("Approval: granular\nSandbox: readOnly")])]),
            "currentOperatingModeCode": .string("native-config"),
            "thoughtLevels": .array([.object(["code": .string(effort), "value": .string(effort)])]),
            "currentThoughtLevelCode": .string(effort),
        ])
    }

    private func record(_ metadata: JSONValue) -> SessionRecord {
        SessionRecord(id: "native", seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
                      projectId: nil, metadataVersion: 1, metadataCipher: "", metadata: metadata,
                      agentStateVersion: 0, agentStateCipher: nil, agentState: nil,
                      dataKeyCipher: nil, decryptable: true, thinking: false)
    }

    func testPublishedSettingsWinOverStalePicksAndDefaults() {
        for (model, effort) in [("gpt-native-a", "high"), ("gpt-native-b", "low")] {
            let meta = metadata(model: model, effort: effort)
            let modes = ComposerModes(metadata: meta,
                picks: ComposerPicks(permissionMode: "yolo", modelMode: "stale-model", effortLevel: "medium"),
                agentDefaultOverrides: ["codex": .object(["modelMode": .string("default-model")])])
            XCTAssertEqual(modes.permissionMode?.key, "native-config")
            XCTAssertEqual(modes.modelMode?.key, model)
            XCTAssertEqual(modes.effortLevel?.key, effort)
            let chips = ComposerChipSet(modes: modes, record: record(meta), titles: .init(
                permission: "Permissions", codexPermission: "Codex permissions", geminiPermission: "Gemini permissions", model: "Model", effort: "Effort"))
            XCTAssertEqual(chips.permission?.label, "Local")
            XCTAssertEqual(chips.permission?.sections?.first?.options.first?.subtitle, "Approval: granular\nSandbox: readOnly")
            XCTAssertEqual(chips.model.selectedKey, model)
            XCTAssertEqual(chips.effort?.label, effort)
            XCTAssertFalse(chips.settings.isEmpty)
            XCTAssertTrue(chips.settings.flatMap(\.options).allSatisfy(\.isDisabled))
        }
    }

    func testUnknownNativeSettingsDoNotFallBackToPresets() {
        let meta: JSONValue = .object(["flavor": .string("codex"), "codexNativeConfig": .bool(true)])
        let modes = ComposerModes(metadata: meta, picks: ComposerPicks(permissionMode: "auto", effortLevel: "medium"), agentDefaultOverrides: [:])
        XCTAssertNil(modes.permissionMode)
        XCTAssertNil(modes.modelMode)
        XCTAssertNil(modes.effortLevel)
    }

    func testSessionInfoUsesTheSameNativeModelAsTheComposer() {
        for name in ["gpt-native-a", "gpt-native-b"] {
            let info = SessionInfoModel(session: record(metadata(model: name)), machine: nil,
                settings: AccountSettings(SettingsSnapshot()), gitStatus: nil, permissionMode: nil)
            XCTAssertEqual(info.metadata?.model, name)
        }
    }

    func testNativeMessageDoesNotSendStaleOverridesButDefaultModeStillDoes() throws {
        for native in [true, false] {
            for source in [OutgoingMessage.Source.chat, .newSession] {
                let encoded = try UserMessageEncoder.encode(OutgoingMessage(text: "continue", source: source),
                    session: record(metadata(native)), composer: .object([
                        "permissionMode": .string("yolo"), "modelMode": .string("stale-model"), "effortLevel": .string("medium")]))
                XCTAssertEqual(encoded["content"]?["text"]?.stringValue, "continue")
                for field in ["permissionMode", "model", "effort"] {
                    XCTAssertEqual(encoded["meta"]?[field] == nil, native, field)
                }
            }
        }
    }
}
