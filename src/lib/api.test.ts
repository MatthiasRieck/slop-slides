// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../test/tauri";

import { api, errorMessage } from "./api";
import { DEFAULT_VIDEO_OPTIONS } from "./video";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue("result");
});

// Command names and argument keys must match the #[tauri::command]s in src-tauri/src/lib.rs.
const CASES = [
  ["openWorkspace", () => api.openWorkspace("/ws"), "open_workspace", { path: "/ws" }],
  ["closeWorkspace", () => api.closeWorkspace(), "close_workspace", undefined],
  ["recentWorkspaces", () => api.recentWorkspaces(), "recent_workspaces", undefined],
  ["forgetWorkspace", () => api.forgetWorkspace("/ws"), "forget_workspace", { path: "/ws" }],
  ["recentDecks", () => api.recentDecks(), "recent_decks", undefined],
  ["forgetDeck", () => api.forgetDeck("/ws/deck.html"), "forget_deck", { path: "/ws/deck.html" }],
  ["libraryFolder", () => api.libraryFolder(), "library_folder", undefined],
  ["deckGallery", () => api.deckGallery(), "deck_gallery", undefined],
  ["deckWorkspace", () => api.deckWorkspace("/w/q3/deck.html"), "deck_workspace", { path: "/w/q3/deck.html" }],
  ["createExampleDeck", () => api.createExampleDeck(), "create_example_deck", undefined],
  ["duplicateDeck", () => api.duplicateDeck("talk"), "duplicate_deck", { id: "talk" }],
  ["trashDeck", () => api.trashDeck("talk"), "trash_deck", { id: "talk" }],
  ["deckVersions", () => api.deckVersions("talk"), "deck_versions", { id: "talk" }],
  ["restoreVersion", () => api.restoreVersion("talk", "v2"), "restore_version", { id: "talk", version: "v2" }],
  ["listDir", () => api.listDir("talks"), "list_dir", { path: "talks" }],
  ["openFile", () => api.openFile("talks/q3.html"), "open_file", { path: "talks/q3.html" }],
  ["searchFiles", () => api.searchFiles("q3"), "search_files", { query: "q3" }],
  ["renameEntry", () => api.renameEntry("talks/q3", "q4"), "rename_entry", { path: "talks/q3", name: "q4" }],
  ["createFolder", () => api.createFolder("talks"), "create_folder", { parent: "talks" }],
  ["trashEntry", () => api.trashEntry("talks/old.md"), "trash_entry", { path: "talks/old.md" }],
  ["readTextFile", () => api.readTextFile("talks/notes.md"), "read_text_file", { path: "talks/notes.md" }],
  ["openInDefaultApp", () => api.openInDefaultApp("talks/q3.pdf"), "open_in_default_app", { path: "talks/q3.pdf" }],
  ["createDeck", () => api.createDeck("Talk"), "create_deck", { title: "Talk", template: null }],
  ["openDeck", () => api.openDeck("talk"), "open_deck", { id: "talk", keepChat: false, quiet: false }],
  ["closeDeck", () => api.closeDeck(), "close_deck", undefined],
  ["moveChatToDeck", () => api.moveChatToDeck(), "move_chat_to_deck", undefined],
  ["loadDeck", () => api.loadDeck("talk"), "load_deck", { id: "talk" }],
  ["renameDeck", () => api.renameDeck("talk", "New"), "rename_deck", { id: "talk", title: "New" }],
  [
    "saveReview",
    () => api.saveReview("talk", { intro: [{ tool: "pen", color: "#fff", points: [[0.5, 0.5]] }] }),
    "save_review",
    { id: "talk", review: { intro: [{ tool: "pen", color: "#fff", points: [[0.5, 0.5]] }] } },
  ],
  [
    "saveComments",
    () => api.saveComments("talk", { intro: [{ id: "a", text: "Bigger", x: 0.5, y: 0.5 }] }),
    "save_comments",
    { id: "talk", comments: { intro: [{ id: "a", text: "Bigger", x: 0.5, y: 0.5 }] } },
  ],
  ["reorderSlides", () => api.reorderSlides("talk", ["b", "a"]), "reorder_slides", { id: "talk", slides: ["b", "a"] }],
  ["addSlide", () => api.addSlide("talk", null), "add_slide", { id: "talk", after: null }],
  ["duplicateSlides", () => api.duplicateSlides("talk", ["a"]), "duplicate_slides", { id: "talk", slides: ["a"] }],
  [
    "setSlidesHidden",
    () => api.setSlidesHidden("talk", ["a"], true),
    "set_slides_hidden",
    { id: "talk", slides: ["a"], hidden: true },
  ],
  [
    "setSlideLocked",
    () => api.setSlideLocked("talk", "a", true),
    "set_slide_locked",
    { id: "talk", slide: "a", locked: true },
  ],
  [
    "setSlidesLocked",
    () => api.setSlidesLocked("talk", ["a", "b"], true),
    "set_slides_locked",
    { id: "talk", slides: ["a", "b"], locked: true },
  ],
  [
    "setSlideNarration",
    () => api.setSlideNarration("talk", "a", "Hello"),
    "set_slide_narration",
    { id: "talk", slide: "a", text: "Hello" },
  ],
  [
    "setSlideSize",
    () => api.setSlideSize("talk", { width: 21, height: 29.7, unit: "cm" }),
    "set_slide_size",
    { id: "talk", size: { width: 21, height: 29.7, unit: "cm" } },
  ],
  [
    "addSection",
    () => api.addSection("talk", "b", "Part two"),
    "add_section",
    { id: "talk", before: "b", title: "Part two" },
  ],
  [
    "renameSection",
    () => api.renameSection("talk", 1, "Wrap up"),
    "rename_section",
    { id: "talk", index: 1, title: "Wrap up" },
  ],
  ["deleteSection", () => api.deleteSection("talk", 1), "delete_section", { id: "talk", index: 1 }],
  [
    "deleteSectionSlides",
    () => api.deleteSectionSlides("talk", 1, ["a"]),
    "delete_section_slides",
    { id: "talk", index: 1, slides: ["a"] },
  ],
  ["deleteSlides", () => api.deleteSlides("talk", ["a"]), "delete_slides", { id: "talk", slides: ["a"] }],
  [
    "setSlideNotes",
    () => api.setSlideNotes("talk", "a", "Pause here"),
    "set_slide_notes",
    { id: "talk", slide: "a", text: "Pause here" },
  ],
  [
    "updateSlide",
    () => api.updateSlide("talk", "a", "<section>", "h1"),
    "update_slide",
    { id: "talk", slide: "a", markup: "<section>", base: "h1" },
  ],
  [
    "updateSlide",
    () => api.updateSlide("talk", "a", "<section>", "h1", "nudge:0.2"),
    "update_slide",
    { id: "talk", slide: "a", markup: "<section>", base: "h1", group: "nudge:0.2" },
  ],
  [
    "setBackgroundOfAll",
    () => api.setBackgroundOfAll("talk", "#ff0000"),
    "set_background_of_all",
    { id: "talk", color: "#ff0000" },
  ],
  [
    "setBackgroundOfAll",
    () => api.setBackgroundOfAll("talk", null),
    "set_background_of_all",
    { id: "talk", color: null },
  ],
  [
    "forgetThumbnail",
    () => api.forgetThumbnail("slop://localhost/.thumb/x"),
    "forget_thumbnail",
    { url: "slop://localhost/.thumb/x" },
  ],
  ["slideSource", () => api.slideSource("talk", "a"), "slide_source", { id: "talk", slide: "a" }],
  ["deckHistory", () => api.deckHistory("talk"), "deck_history", { id: "talk" }],
  ["undoDeck", () => api.undoDeck("talk"), "undo_deck", { id: "talk" }],
  ["redoDeck", () => api.redoDeck("talk"), "redo_deck", { id: "talk" }],
  [
    "restoreSlides",
    () => api.restoreSlides("talk", "v1", ["a"]),
    "restore_slides",
    { id: "talk", since: "v1", slides: ["a"] },
  ],
  ["rewindChat", () => api.rewindChat("/ws", "m1", "Note"), "rewind_chat", { id: "/ws", message: "m1", note: "Note" }],
  [
    "saveDeckSource",
    () => api.saveDeckSource("talk", "<html>", "<old>"),
    "save_deck_source",
    { id: "talk", source: "<html>", base: "<old>" },
  ],
  ["importAssets", () => api.importAssets("talk", ["/a.png"]), "import_assets", { id: "talk", paths: ["/a.png"] }],
  [
    "saveAsset",
    () => api.saveAsset("talk", "shot.png", "aGk="),
    "save_asset",
    { id: "talk", name: "shot.png", data: "aGk=" },
  ],
  [
    "copyToClipboard",
    () => api.copyToClipboard("<p>Hi</p>", "Hi"),
    "copy_to_clipboard",
    { html: "<p>Hi</p>", text: "Hi", id: null },
  ],
  [
    "copyToClipboard",
    () => api.copyToClipboard("<p>Hi</p>", "Hi", "/w/talk/deck.html"),
    "copy_to_clipboard",
    { html: "<p>Hi</p>", text: "Hi", id: "/w/talk/deck.html" },
  ],
  ["copySlides", () => api.copySlides("talk", ["a", "b"]), "copy_slides", { id: "talk", slides: ["a", "b"] }],
  ["pasteSlides", () => api.pasteSlides("talk", "a"), "paste_slides", { id: "talk", after: "a" }],
  ["setSlideTime", () => api.setSlideTime("talk", "a", 90), "set_slide_time", { id: "talk", slide: "a", seconds: 90 }],
  [
    "setSlideTiming",
    () => api.setSlideTiming("talk", [{ slide: "a", duration: 4, narrationStart: null }]),
    "set_slide_timing",
    { id: "talk", timing: [{ slide: "a", duration: 4, narrationStart: null }] },
  ],
  ["narrationPeaks", () => api.narrationPeaks("talk", "a"), "narration_peaks", { id: "talk", slide: "a" }],
  ["timeNarration", () => api.timeNarration("talk", null), "time_narration", { id: "talk", slides: null }],
  ["timeNarration", () => api.timeNarration("talk", ["a"]), "time_narration", { id: "talk", slides: ["a"] }],
  ["narrationWords", () => api.narrationWords("talk", "a"), "narration_words", { id: "talk", slide: "a" }],
  ["newWindow", () => api.newWindow(), "new_window", undefined],
  [
    "setMenuState",
    () => api.setMenuState({ disabled: ["edit.undo"], checked: ["view.sidebar"] }),
    "set_menu_state",
    { state: { disabled: ["edit.undo"], checked: ["view.sidebar"] } },
  ],
  ["restoreShowWindow", () => api.restoreShowWindow(), "restore_show_window", undefined],
  ["keepAwake", () => api.keepAwake(true), "keep_awake", { on: true }],
  ["listScreens", () => api.listScreens(), "list_screens", undefined],
  ["screenPreviews", () => api.screenPreviews(() => {}), "screen_previews", { grabbed: expect.anything() }],
  ["presentOn", () => api.presentOn(1, 0), "present_on", { audience: 1, presenter: 0 }],
  ["presentOn", () => api.presentOn(1, null), "present_on", { audience: 1, presenter: null }],
  ["presentInWindows", () => api.presentInWindows(), "present_in_windows", undefined],
  ["closePresenterView", () => api.closePresenterView(), "close_presenter_view", undefined],
  ["takePendingFolder", () => api.takePendingFolder(), "take_pending_folder", undefined],
  ["pasteSlides", () => api.pasteSlides("talk", null), "paste_slides", { id: "talk", after: null }],
  ["pasteFromClipboard", () => api.pasteFromClipboard("talk"), "paste_from_clipboard", { id: "talk" }],
  ["readClipboardText", () => api.readClipboardText(), "read_clipboard_text", undefined],
  [
    "findInDeck",
    () => api.findInDeck("talk", "plan", { matchCase: true, wholeWord: false }),
    "find_in_deck",
    { id: "talk", query: "plan", options: { matchCase: true, wholeWord: false } },
  ],
  [
    "replaceInDeck",
    () => api.replaceInDeck("talk", "plan", "goal", { matchCase: false, wholeWord: true }, ["a"]),
    "replace_in_deck",
    { id: "talk", query: "plan", replacement: "goal", options: { matchCase: false, wholeWord: true }, slides: ["a"] },
  ],
  [
    "replaceMatchInDeck",
    () => api.replaceMatchInDeck("talk", "plan", "goal", { matchCase: false, wholeWord: true }, "a", 2),
    "replace_match_in_deck",
    {
      id: "talk",
      query: "plan",
      replacement: "goal",
      options: { matchCase: false, wholeWord: true },
      slide: "a",
      nth: 2,
    },
  ],
  [
    "exportDeck",
    () => api.exportDeck("talk", "/out.html", { includeHidden: false, notes: true, narration: false, review: false }),
    "export_deck",
    {
      id: "talk",
      dest: "/out.html",
      options: { includeHidden: false, notes: true, narration: false, review: false },
    },
  ],
  [
    "exportPdf",
    () => api.exportPdf("talk", "/out.pdf", "job-1", { slides: ["a"], includeHidden: true, notes: true }),
    "export_pdf",
    { id: "talk", dest: "/out.pdf", jobId: "job-1", options: { slides: ["a"], includeHidden: true, notes: true } },
  ],
  [
    "exportPptx",
    () => api.exportPptx("talk", "/out.pptx", "job-2", { includeHidden: false }),
    "export_pptx",
    { id: "talk", dest: "/out.pptx", jobId: "job-2", scope: { includeHidden: false } },
  ],
  [
    "exportSlideImages",
    () => api.exportSlideImages("talk", "/out", "job-3", { includeHidden: false, format: "jpeg", scale: 2 }),
    "export_slide_images",
    { id: "talk", dest: "/out", jobId: "job-3", options: { includeHidden: false, format: "jpeg", scale: 2 } },
  ],
  ["cancelExport", () => api.cancelExport("job-3"), "cancel_export", { jobId: "job-3" }],
  ["importPptx", () => api.importPptx("/in.pptx"), "import_pptx", { path: "/in.pptx" }],
  [
    "exportVideo",
    () =>
      api.exportVideo(
        "talk",
        "/out.mp4",
        { ...DEFAULT_VIDEO_OPTIONS },
        { includeHidden: false, height: 1080, captions: "srt" },
      ),
    "export_video",
    {
      id: "talk",
      dest: "/out.mp4",
      options: DEFAULT_VIDEO_OPTIONS,
      output: { includeHidden: false, height: 1080, captions: "srt" },
    },
  ],
  ["cancelVideoExport", () => api.cancelVideoExport(), "cancel_video_export", undefined],
  ["deckInRepository", () => api.deckInRepository("talk"), "deck_in_repository", { id: "talk" }],
  ["deckChanges", () => api.deckChanges("talk"), "deck_changes", { id: "talk" }],
  [
    "stageChange",
    () => api.stageChange("talk", { kind: "styles" }),
    "stage_change",
    { id: "talk", change: { kind: "styles" } },
  ],
  [
    "unstageChange",
    () => api.unstageChange("talk", { kind: "styles" }),
    "unstage_change",
    { id: "talk", change: { kind: "styles" } },
  ],
  [
    "restoreChange",
    () => api.restoreChange("talk", { kind: "move", id: "a", oldId: "a" }),
    "restore_change",
    { id: "talk", change: { kind: "move", id: "a", oldId: "a" } },
  ],
  ["restoreAllChanges", () => api.restoreAllChanges("talk"), "restore_all_changes", { id: "talk" }],
  ["stageAll", () => api.stageAll("talk"), "stage_all", { id: "talk" }],
  ["unstageAll", () => api.unstageAll("talk"), "unstage_all", { id: "talk" }],
  ["commitChanges", () => api.commitChanges("talk", "Fix"), "commit_changes", { id: "talk", message: "Fix" }],
  ["lintDeck", () => api.lintDeck("talk"), "lint_deck", { id: "talk" }],
  [
    "captureSketch",
    () => api.captureSketch("talk", { x: 1, y: 2, width: 300, height: 168.75 }, { width: 1480, height: 920 }),
    "capture_sketch",
    { id: "talk", rect: { x: 1, y: 2, width: 300, height: 168.75 }, viewport: { width: 1480, height: 920 } },
  ],
  [
    "captureArea",
    () =>
      api.captureArea("talk", { x: 1, y: 2, width: 30, height: 20 }, { width: 1480, height: 920 }, [
        [0, 0],
        [1, 0],
        [0, 1],
      ]),
    "capture_area",
    {
      id: "talk",
      rect: { x: 1, y: 2, width: 30, height: 20 },
      viewport: { width: 1480, height: 920 },
      outline: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    },
  ],
  ["sessionProvider", () => api.sessionProvider("talk"), "session_provider", { id: "talk" }],
  ["loadChat", () => api.loadChat("talk"), "load_chat", { id: "talk" }],
  ["saveChat", () => api.saveChat("talk", [1]), "save_chat", { id: "talk", chat: [1] }],
  ["resetChat", () => api.resetChat("talk"), "reset_chat", { id: "talk" }],
  ["listChatThreads", () => api.listChatThreads("/ws"), "list_chat_threads", { id: "/ws" }],
  ["chatTitle", () => api.chatTitle("talk"), "chat_title", { id: "talk" }],
  [
    "renameChatThread",
    () => api.renameChatThread("t1", "Pricing"),
    "rename_chat_thread",
    { thread: "t1", title: "Pricing" },
  ],
  ["deleteChatThread", () => api.deleteChatThread("talk", "t1"), "delete_chat_thread", { id: "talk", thread: "t1" }],
  [
    "discardAttachment",
    () => api.discardAttachment("talk", "assets/a.pdf"),
    "discard_attachment",
    { id: "talk", path: "assets/a.pdf" },
  ],
  [
    "selectChatThread",
    () => api.selectChatThread("/ws", "past-thread"),
    "select_chat_thread",
    { id: "/ws", thread: "past-thread" },
  ],
  [
    "sendMessage",
    () =>
      api.sendMessage("talk", "talk/deck.html", "Hi", {
        provider: "claude",
        model: "claude-opus-5-5",
        effort: "high",
        contextWindow: "1m",
      }),
    "send_message",
    {
      args: {
        workspace: "talk",
        chat: "talk/deck.html",
        prompt: "Hi",
        provider: "claude",
        model: "claude-opus-5-5",
        effort: "high",
        contextWindow: "1m",
        compact: false,
      },
    },
  ],

  [
    "permissionModes",
    () => api.permissionModes("copilot", "talk"),
    "permission_modes",
    { provider: "copilot", id: "talk" },
  ],
  [
    "setPermissionMode",
    () => api.setPermissionMode("talk", "fullAccess"),
    "set_permission_mode",
    { id: "talk", mode: "fullAccess" },
  ],
  [
    "respondApproval",
    () => api.respondApproval("talk", "request-1", "decline"),
    "respond_approval",
    { chat: "talk", id: "request-1", decision: "decline" },
  ],
  ["interruptAgent", () => api.interruptAgent("talk"), "interrupt_agent", { id: "talk" }],
  [
    "steerAgent",
    () => api.steerAgent("talk", "Bluer", "m1"),
    "steer_agent",
    { chat: "talk", prompt: "Bluer", message: "m1" },
  ],
  ["agentRunning", () => api.agentRunning("talk"), "agent_running", { id: "talk" }],
  ["listProviders", () => api.listProviders(), "list_providers", undefined],
  ["listTemplates", () => api.listTemplates(), "list_templates", undefined],
  ["stageTemplate", () => api.stageTemplate("talk", "swiss"), "stage_template", { id: "talk", template: "swiss" }],
  ["applyTemplate", () => api.applyTemplate("talk", "swiss"), "apply_template", { id: "talk", template: "swiss" }],
  [
    "addTemplateSlide",
    () => api.addTemplateSlide("talk", "swiss", "quote", "intro"),
    "add_template_slide",
    { id: "talk", template: "swiss", slide: "quote", after: "intro" },
  ],
  ["createTemplate", () => api.createTemplate("talk", "Mine"), "create_template", { id: "talk", name: "Mine" }],
  ["voiceStatus", () => api.voiceStatus(), "voice_status", undefined],
  ["downloadVoiceModel", () => api.downloadVoiceModel(), "download_voice_model", undefined],
  ["cancelVoiceDownload", () => api.cancelVoiceDownload(), "cancel_voice_download", undefined],
  ["startRecording", () => api.startRecording(), "start_recording", undefined],
  ["followSpeech", () => api.followSpeech(), "follow_speech", undefined],
  ["stopRecording", () => api.stopRecording(), "stop_recording", undefined],
  ["cancelRecording", () => api.cancelRecording(), "cancel_recording", undefined],
  [
    "startNarrationRecording",
    () => api.startNarrationRecording("talk", "a", "audio"),
    "start_narration_recording",
    { id: "talk", slide: "a", mode: "audio", replace: false },
  ],
  [
    "startNarrationRecording",
    () => api.startNarrationRecording("talk", "a", "audio", true),
    "start_narration_recording",
    { id: "talk", slide: "a", mode: "audio", replace: true },
  ],
  ["narrationRecordingSlide", () => api.narrationRecordingSlide("b"), "narration_recording_slide", { slide: "b" }],
  ["stopNarrationRecording", () => api.stopNarrationRecording(), "stop_narration_recording", undefined],
  [
    "deleteRecordedNarration",
    () => api.deleteRecordedNarration("talk", "a"),
    "delete_recorded_narration",
    { id: "talk", slide: "a" },
  ],
  ["speechStatus", () => api.speechStatus(), "speech_status", undefined],
  ["narrationAudio", () => api.narrationAudio("talk"), "narration_audio", { id: "talk" }],
  ["renderNarration", () => api.renderNarration("talk", ["a"]), "render_narration", { id: "talk", slides: ["a"] }],
  ["renderNarration", () => api.renderNarration("talk", null), "render_narration", { id: "talk", slides: null }],
  ["cancelNarration", () => api.cancelNarration(), "cancel_narration", undefined],
  ["narrationWav", () => api.narrationWav("talk", "a"), "narration_wav", { id: "talk", slide: "a" }],
  [
    "setNarrationVoice",
    () => api.setNarrationVoice("talk", "aiden"),
    "set_narration_voice",
    { id: "talk", voice: "aiden" },
  ],
  [
    "setNarrationProvider",
    () => api.setNarrationProvider("talk", "openai"),
    "set_narration_provider",
    { id: "talk", provider: "openai" },
  ],
  ["setSpeechKey", () => api.setSpeechKey("openai", "sk-x"), "set_speech_key", { provider: "openai", key: "sk-x" }],
  ["setSpeechKey", () => api.setSpeechKey("openai", null), "set_speech_key", { provider: "openai", key: null }],
  ["speechVoices", () => api.speechVoices("elevenlabs"), "speech_voices", { provider: "elevenlabs" }],
  [
    "setNarrationLanguage",
    () => api.setNarrationLanguage("talk", "de"),
    "set_narration_language",
    { id: "talk", language: "de" },
  ],
  ["cancelNarrationTiming", () => api.cancelNarrationTiming(), "cancel_narration_timing", undefined],
  ["narrationSettings", () => api.narrationSettings("talk"), "narration_settings", { id: "talk" }],
  [
    "setNarrationTiming",
    () => api.setNarrationTiming("talk", { secondsPerSlide: 4, pauseBefore: 0, pauseAfter: 1 }),
    "set_narration_timing",
    { id: "talk", timing: { secondsPerSlide: 4, pauseBefore: 0, pauseAfter: 1 } },
  ],
  [
    "setNarrationDelivery",
    () => api.setNarrationDelivery("talk", "slower", "warm"),
    "set_narration_delivery",
    { id: "talk", pace: "slower", style: "warm" },
  ],
  [
    "previewNarrationVoice",
    () => api.previewNarrationVoice("openai", "marin", "en"),
    "preview_narration_voice",
    { provider: "openai", voice: "marin", language: "en" },
  ],
] as const;

it("tells when the screens are captured", () => {
  const onGrabbed = vi.fn();
  void api.screenPreviews(onGrabbed);
  expect(invoke.mock.calls[0]?.[0]).toBe("screen_previews");
  invoke.mock.calls[0]?.[1].grabbed.onmessage();
  expect(onGrabbed).toHaveBeenCalled();
});

describe("api", () => {
  it.each(CASES)("%s invokes %s", async (_, call, command, args) => {
    await expect(call()).resolves.toBe("result");
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]).toEqual(args === undefined ? [command] : [command, args]);
  });

  it("createDeck passes the chosen template", async () => {
    await api.createDeck("Talk", "synthwave");
    expect(invoke).toHaveBeenLastCalledWith("create_deck", { title: "Talk", template: "synthwave" });
  });

  it("sendMessage can ask for a compaction instead of a prompt", async () => {
    invoke.mockResolvedValue(undefined);
    await api.sendMessage(
      "talk",
      "talk",
      "/compact",
      { provider: "copilot", model: "gpt-x", effort: "", contextWindow: null },
      true,
    );
    expect(invoke).toHaveBeenLastCalledWith("send_message", {
      args: {
        workspace: "talk",
        chat: "talk",
        prompt: "/compact",
        provider: "copilot",
        model: "gpt-x",
        effort: "",
        contextWindow: null,
        compact: true,
      },
    });
  });

  it("sendMessage names the chat message its turn answers", async () => {
    invoke.mockResolvedValue(undefined);
    await api.sendMessage(
      "talk",
      "talk/deck.html",
      "[context]…",
      { provider: "claude", model: "m", effort: "", contextWindow: null },
      false,
      {
        message: "m1",
        label: "Bigger title",
      },
    );
    expect(invoke).toHaveBeenLastCalledWith("send_message", {
      args: expect.objectContaining({ prompt: "[context]…", message: "m1", label: "Bigger title" }),
    });
  });

  it("covers every api function", () => {
    expect([...new Set(CASES.map(([name]) => name))].sort()).toEqual(Object.keys(api).sort());
  });

  it("openDeck can keep the folder's chat on show, and pass over a deck open elsewhere quietly", async () => {
    await api.openDeck("talk", { keepChat: true, quiet: true });
    expect(invoke).toHaveBeenLastCalledWith("open_deck", { id: "talk", keepChat: true, quiet: true });
  });

  it("passes backend rejections through", async () => {
    invoke.mockRejectedValue("deck not found: x");
    await expect(api.openDeck("x")).rejects.toBe("deck not found: x");
  });
});

describe("errorMessage", () => {
  it("shows backend string errors as-is", () => {
    expect(errorMessage("deck not found: x")).toBe("deck not found: x");
  });

  it("uses an Error's message", () => {
    expect(errorMessage(new TypeError("boom"))).toBe("boom");
  });

  it("stringifies anything else", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
