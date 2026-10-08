import XCTest
@testable import CollectiveKit

final class SettingsDestinationTests: XCTestCase {
    func testMembersCannotDiscoverOrOpenAdministratorDestinations() {
        let member = SettingsDestination.available(isAdmin: false)
        XCTAssertEqual(member.map(\.id), ["general", "security", "personalization", "memory", "approvals", "connectedAccounts", "workspace", "dataControls"])
        XCTAssertFalse(member.contains { $0.isAdminOnly })
        XCTAssertNil(SettingsDestination.users.url(server: URL(string: "https://example.test")!, isAdmin: false))
    }

    func testDestinationsPreserveInstallationPathAndOriginWithoutSecrets() throws {
        let base = URL(string: "https://example.test:8443/portal")!
        let url = try XCTUnwrap(SettingsDestination.connectedAccounts.url(server: base, isAdmin: false))
        XCTAssertEqual(url.absoluteString, "https://example.test:8443/portal/settings?tab=connected-accounts")
        XCTAssertEqual(SettingsDestination.organization.url(server: base, isAdmin: true)?.absoluteString, "https://example.test:8443/portal/admin/settings")
        for destination in SettingsDestination.allCases {
            let components = URLComponents(url: try XCTUnwrap(destination.url(server: base, isAdmin: true)), resolvingAgainstBaseURL: false)!
            XCTAssertEqual(components.host, "example.test")
            XCTAssertEqual(components.port, 8443)
            XCTAssertNil(components.user)
            XCTAssertNil(components.fragment)
            XCTAssertTrue((components.queryItems ?? []).allSatisfy { $0.name == "tab" })
        }
    }

    func testUnsafeServerBasesCannotBecomeBrowserDestinations() {
        for base in ["https://user:secret@example.test", "https://example.test/?token=secret", "https://example.test/#token", "file:///portal", "javascript:alert(1)", "https://example.test/portal/../other", "https://example.test/portal/%2e%2e/other", "https://example.test/portal%2fother"] {
            XCTAssertNil(SettingsDestination.general.url(server: URL(string: base)!, isAdmin: true), base)
        }
    }

    func testSessionValidationFailsClosedAndIgnoresOldResponses() {
        var access = SettingsSessionAccess()
        XCTAssertFalse(access.isAdmin)
        let generation = access.generation
        let first = access.beginValidation()
        XCTAssertTrue(access.completeValidation(isAdmin: true, generation: generation, request: first))
        XCTAssertTrue(access.isAdmin)
        let second = access.beginValidation()
        XCTAssertFalse(access.isAdmin, "Do not trust cached roles during validation")
        XCTAssertFalse(access.completeValidation(isAdmin: true, generation: generation, request: first))
        XCTAssertTrue(access.completeValidation(isAdmin: false, generation: generation, request: second))
        XCTAssertFalse(access.isAdmin)
        let third = access.beginValidation()
        access.invalidate()
        XCTAssertFalse(access.completeValidation(isAdmin: true, generation: generation, request: third))
        XCTAssertFalse(access.isAdmin, "A late response cannot repopulate a signed-out session")
    }

    func testAdministratorsHaveTheFullWebsiteControlSurface() {
        let admin = SettingsDestination.available(isAdmin: true)
        XCTAssertEqual(admin.filter(\.isAdminOnly).map(\.path), ["/admin", "/admin/apps", "/admin/hermes", "/admin/groups", "/admin/users", "/admin/bots", "/admin/pets", "/admin/tools", "/admin/mcp", "/admin/sandboxes", "/admin/activity", "/admin/settings"])
    }
}
