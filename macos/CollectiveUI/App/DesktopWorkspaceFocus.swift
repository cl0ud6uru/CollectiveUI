import SwiftUI

struct WorkspaceKey: FocusedValueKey {
    typealias Value = DesktopWorkspace
}

extension FocusedValues {
    var desktopWorkspace: DesktopWorkspace? {
        get { self[WorkspaceKey.self] }
        set { self[WorkspaceKey.self] = newValue }
    }
}
