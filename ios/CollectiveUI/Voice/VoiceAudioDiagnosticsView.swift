import SwiftUI
import UniformTypeIdentifiers

struct VoiceAudioDiagnosticsView: View {
    @Bindable var diagnostics: VoiceAudioDiagnostics
    let active: Bool
    @State private var exporting = false
    @State private var document: VoiceAudioDiagnosticsDocument?
    @State private var exportFailed = false

    var body: some View {
        DisclosureGroup("Audio diagnostics") {
            VStack(alignment: .leading, spacing: 12) {
                Button(diagnostics.enabled ? "Stop capture" : "Capture locally") {
                    Task { if diagnostics.enabled { await diagnostics.stop() } else { await diagnostics.start() } }
                }
                .disabled(diagnostics.changing || (!active && !diagnostics.enabled))
                .accessibilityIdentifier("voice.diagnostics.capture")
                HStack {
                    Button("Clear") { Task { await diagnostics.clear() } }.disabled(diagnostics.changing)
                    Button("Export JSON") {
                        Task {
                            do { document = VoiceAudioDiagnosticsDocument(data: try await diagnostics.export()); exporting = true }
                            catch { exportFailed = true }
                        }
                    }.disabled(diagnostics.count == 0)
                }
                Text("\(diagnostics.count) / 180 samples" + (diagnostics.enabled ? " · capturing" : ""))
                    .accessibilityIdentifier("voice.diagnostics.status")
                Text("Capture up to three minutes of numeric playback metrics, kept here until cleared. No audio or transcript is captured or uploaded.")
                if diagnostics.unavailable { Text("Some playback metrics are unavailable and are omitted from the export.") }
                if exportFailed { Text("The diagnostics file could not be saved.") }
            }.padding(.top, 8)
        }
        .font(.footnote).foregroundStyle(.secondary)
        .onChange(of: active) { _, value in if !value { Task { await diagnostics.stop() } } }
        .fileExporter(isPresented: $exporting, document: document, contentType: .json, defaultFilename: "voice-audio-diagnostics") { result in
            if case .failure = result { exportFailed = true }
        }
    }
}

struct VoiceAudioDiagnosticsDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
