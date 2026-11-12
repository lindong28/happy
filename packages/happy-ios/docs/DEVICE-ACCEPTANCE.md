# iPhone session acceptance

Use this guide when an agent verifies a real Happy iPhone session: reading progress, sending another instruction, answering a question or approving a tool. It preserves the distinction between a working relay and a usable phone app. Pairing, signing and build instructions remain in [the iOS README](../README.md); release builds follow [the release workflow](../../../.agents/skills/release/SKILL.md).

## Choose the observation path

| Task | Existing entry | What its result establishes |
| --- | --- | --- |
| Repeatable composer/navigation checks | [HappyChatUITests](../Tests/HappyChatUITests), including ComposeOpenUITests and NewTaskUITests; build/test setup in [AGENTS.md](../AGENTS.md#build-and-test) | The tested UI behavior in the selected fixture and destination; not live account, relay or model connectivity |
| Fictional screenshots and layout captures | [Native capture harness](../../../scripts/mobile-captures/native/README.md) | Fixture rendering on its simulator/emulator; not real phone acceptance |
| An installed app connected to a real session | Direct phone UI observation, or an available macOS iPhone Mirroring controller | Only the actions and visible results actually observed on that device |
| Relay/CLI diagnostics | [Happy CLI](../../happy-cli/README.md) and the affected protocol tests | Backend receipt or processing; pair this with phone observation before claiming that the phone displays the result |

Check the actual controller and its callable operations before choosing a route. An old screenshot, prior tool name or connected USB cable is not evidence of current control. Existing fixture UI tests are not an attach-to-the-installed-app driver. If no current device controller is usable, complete backend checks and identify the specific remaining phone observation; do not report fixture success as a device pass or build a replacement UI driver just to collect a screenshot.

## Prepare one identifiable test

Use a disposable development workspace and a task-owned session. Record the nonsecret app variant/build, relay endpoint, machine, working directory, Happy session ID and native thread ID when available. Several conversations can have the same title; a title alone cannot select the test target. Resolve the mapping through session details and the CLI before sending. Keep production work and existing drafts intact.

Choose a fresh harmless marker for each send, and record it before input. It must not contain a credential or private clipboard content. Preserve the expected visible response and the backend observation to correlate; a previous response is not evidence that a new message arrived. Credentials stay in the app's supported pairing/restore flow, never in test messages or evidence reports.

Arrange one bounded period of Mac/phone availability if the controller needs their input channel. Explain that the agent will perform the ordinary app steps and will explicitly release the devices afterward. Ask the person only for actions the current execution path cannot perform, such as system authentication, trusting a developer certificate, locking the phone for mirroring, or a real cellular/airplane-mode transition. Reuse valid observations; do not repeatedly request completed setup or a successful network test.

## Enter and verify through the intended app

1. Observe the current controller/window, Happy app and target conversation. For mirroring, confirm the actual phone surface, not merely the foreground process name. An app-scoped element operation is preferable to global keyboard input; it still needs conversation and composer checks.
2. Inspect the composer. An existing draft is not permission to delete or send it. If its ownership or contents cannot be safely established, pause this input and preserve the draft. Do not print suspicious contents into the transcript.
3. Enter only the prepared marker. Prefer direct text entry that does not consume the shared clipboard. If the available path requires paste, first establish which clipboard the controller actually consumes and verify that this source contains exactly the nonsecret marker. Mac `pbcopy` success does not establish the iPhone clipboard value: a previous mirroring test pasted an old phone value after the Mac clipboard had been replaced. If the actual source cannot be verified safely, use a verified direct-input path or pause this input step. Do not discover the clipboard source by pasting unknown contents into the app; composer inspection afterward is too late to prevent exposure in a screenshot.
4. Before sending, verify both the target conversation and the complete composer value. A truncated view or uncertain input is insufficient. Recheck after any interruption or focus change. If the controller cannot establish these facts, stop the send; do not assume a preceding focus command made later global keystrokes safe.
5. Send once, then observe the outgoing message and corresponding new response in the phone UI. Correlate with the backend session/turn receipt. On timeout, inspect both sides before retrying: a lost UI acknowledgement can occur after the message was already submitted.

For questions and approvals, match the pending request to the intended session and tool before answering. Record the choice and visible continuation; command approvals also require observing whether the intended operation ran or remained denied. A form on screen, a backend callback or a completed turn alone covers only its own stage. Approval tests must use reversible task-owned operations; the test plan must authorize both outcomes before exercising them.

## Resume after interruption

| Observation | Continuation |
| --- | --- |
| Mac focus moved to another application | Stop global input immediately. Reacquire the phone surface and inspect the draft and session before continuing; do not send cleanup keys to the other app |
| Mirroring reports phone in use, locked-device launch refusal or microphone in use | Save the last confirmed step. Ask for only the system prerequisite still missing; continue independent checks while it is pending |
| No visible acknowledgement after Send | Inspect the existing outgoing message and backend receipt before any resend; preserve uncertainty if neither path distinguishes submission |
| App relaunch or network recovery | Reopen the recorded session, verify its identity and any pending request, then continue from the last confirmed step rather than re-pairing or creating another session |
| Unknown or potentially secret draft | Do not submit. Use a reliable app-local clearing path only for the known test-owned draft; otherwise request the smallest necessary user action without reproducing its contents |

A backend probe that injects test messages/forms must have an explicit timeout and cleanup, use the current project's machine/session registration and message protocol, and preserve task-owned receipts. The CLI's [question-form tests](../../happy-cli/src/codex/questionForms.test.ts) cover the form adapter; they do not certify phone rendering. Do not copy an old probe's absolute paths, account identity or session tag into a new test.

## Report the observed boundary

Record each action, its target and its visible result beside the supporting backend receipt. Separate fixture, real-device, user-reported network and unverified results. Phone reconnection does not test host reboot or sleep. A development build does not establish notification delivery. Keep the minimum evidence needed to resume or audit the test without copying credentials or unrelated conversations.

Finish by releasing the input channel and telling the person that they can use the Mac and iPhone again. Stop only task-owned probes; retain a useful session if the person will continue using it. Missing controller access is a limitation of that test run, not proof that the app cannot be controlled.
