import XCTest
@testable import CollectiveKit

final class PetAppearanceTests: XCTestCase {
    func testOlderServerKeepsExistingBotIdentity() throws {
        let shell = try JSONDecoder().decode(ShellResponse.self, from: Data(#"{"bots":[{"id":"b1","kind":"bot","name":"Moss"}]}"#.utf8))
        XCTAssertTrue(shell.pets.isEmpty)
        XCTAssertFalse(shell.hasPetMetadata)
        XCTAssertEqual(shell.bots.first?.id, "b1")
    }

    func testDisplayContractHandlesBuiltinsAndBothAtlasVersions() throws {
        let json = #"""
        {"pets":{
          "moss":{"enabled":true,"appearance":"moss","motion":"still","spriteUrl":null,"spriteVersionNumber":null},
          "v1":{"enabled":true,"appearance":"custom","motion":"auto","spriteUrl":"/api/mobile/v1/bots/v1/pet/avatar?v=r1","spriteVersionNumber":1},
          "v2":{"enabled":true,"appearance":"catalog","motion":"auto","spriteUrl":"/api/mobile/v1/bots/v2/pet/avatar?v=r2","spriteVersionNumber":2},
          "off":{"enabled":false,"appearance":"moss","motion":"auto"}
        }}
        """#
        let shell = try JSONDecoder().decode(ShellResponse.self, from: Data(json.utf8))
        XCTAssertEqual(shell.pets.count, 4)
        XCTAssertEqual(shell.pets["moss"]?.motion, "still")
        XCTAssertNil(shell.pets["moss"]?.spriteUrl)
        XCTAssertEqual(shell.pets["v1"]?.spriteVersionNumber, 1)
        XCTAssertEqual(shell.pets["v2"]?.spriteVersionNumber, 2)
        XCTAssertEqual(shell.pets["off"]?.enabled, false)
    }

    func testFuturePetAppearanceDoesNotDiscardChatData() throws {
        let shell = try JSONDecoder().decode(ShellResponse.self, from: Data(#"{"bots":[{"id":"b1"}],"pets":{"b1":{"enabled":true,"appearance":"future-format","motion":"auto","futureField":true}}}"#.utf8))
        XCTAssertEqual(shell.bots.count, 1)
        XCTAssertEqual(shell.pets["b1"]?.appearance, "future-format")
    }
    func testNestedWebManifestAndMissingMotionRemainCompatible() throws {
        let data = Data(#"{"enabled":true,"appearance":"custom","spriteUrl":"/api/bots/b1/pet/avatar?v=r1","custom":{"spriteVersionNumber":2}}"#.utf8)
        let pet = try JSONDecoder().decode(PetAppearance.self, from: data)
        XCTAssertEqual(pet.spriteVersionNumber, 2)
        XCTAssertEqual(pet.motion, "auto")
        XCTAssertEqual(pet.avatarPath(for: "b1"), "/api/mobile/v1/bots/b1/pet/avatar?v=r1")
    }

    func testAvatarCannotNameAnotherBotOrExternalDestination() throws {
        for path in ["https://evil.test/api/mobile/v1/bots/b1/pet/avatar?v=r1", "//evil.test/avatar", "/api/mobile/v1/bots/b2/pet/avatar?v=r1", "/api/mobile/v1/bots/b1/pet/avatar?v=r1#fragment", "/api/mobile/v1/bots/b1/pet/avatar", "/api/mobile/v1/bots/b1/pet/avatar?v="] {
            let data = try JSONSerialization.data(withJSONObject: ["enabled": true, "appearance": "custom", "spriteUrl": path])
            XCTAssertNil(try JSONDecoder().decode(PetAppearance.self, from: data).avatarPath(for: "b1"), path)
        }
    }

    func testOneIncompletePetDoesNotDiscardOtherIdentities() throws {
        let shell = try JSONDecoder().decode(ShellResponse.self, from: Data(#"{"pets":{"incomplete":{},"valid":{"enabled":true,"appearance":"custom","spriteUrl":"/api/mobile/v1/bots/valid/pet/avatar?v=abc"}}}"#.utf8))
        XCTAssertEqual(shell.pets.count, 2)
        XCTAssertEqual(shell.pets["valid"]?.avatarPath(for: "valid"), "/api/mobile/v1/bots/valid/pet/avatar?v=abc")
        XCTAssertTrue(shell.hasPetMetadata)
    }
}
