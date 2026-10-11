import SwiftUI

struct BotDirectoryStatus: View {
    let status: String?

    static func label(for status: String?) -> String? {
        switch status {
        case "working": "Working"
        case "waiting": "Needs your approval"
        default: nil
        }
    }

    var body: some View {
        if let label = Self.label(for: status) {
            Label(label, systemImage: status == "waiting" ? "hand.raised" : "clock")
                .font(.footnote)
                .foregroundStyle(status == "waiting" ? PortalTheme.warning : PortalTheme.working)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(PortalTheme.surfaceSecondary, in: .capsule)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
