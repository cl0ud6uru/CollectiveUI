import SwiftUI
import CollectiveKit

@MainActor
struct DesktopDelegatedApprovalView: View {
    let request: DelegatedApproval
    let model: ChatModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("\(request.botName) needs approval", systemImage: "shield.lefthalf.filled").font(.headline)
            Text(request.tool?.title ?? request.tool?.toolName ?? "Action")
            if let input = request.tool?.input { Text(input.prettyPrinted()).font(.system(.callout, design: .monospaced)).textSelection(.enabled) }
            Text("Assigned by \(request.assignerName)").font(.caption).foregroundStyle(.secondary)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack {
                    Button("Approve") { Task { await model.answerDelegate(request, approved: true) } }.buttonStyle(.borderedProminent)
                    Button("Deny") { Task { await model.answerDelegate(request, approved: false) } }
                    Button("Stop Task") { Task { await model.stopDelegate(request) } }
                }.disabled(model.answeringDelegate || request.expiresAt <= context.date)
            }
        }
        .padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
    }
}
