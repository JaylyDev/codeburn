import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Menubar remote command")
struct MenubarRemoteCommandTests {
    @Test("unknown strings and the empty string do not parse")
    func rejectsUnknownStrings() {
        #expect(MenubarRemoteCommand(rawValue: "") == nil)
        #expect(MenubarRemoteCommand(rawValue: "nonsense") == nil)
    }

    @Test("quit terminates without touching the login item")
    func quitTerminatesOnly() {
        let command = MenubarRemoteCommand(rawValue: "quit")
        #expect(command?.terminates == true)
        #expect(command?.unregistersLoginItem == false)
    }

    @Test("uninstall terminates and unregisters the login item")
    func uninstallTerminatesAndUnregisters() {
        let command = MenubarRemoteCommand(rawValue: "uninstall")
        #expect(command?.terminates == true)
        #expect(command?.unregistersLoginItem == true)
    }

    @Test("relaunch does not terminate for good and leaves the login item alone")
    func relaunchNeitherTerminatesNorUnregisters() {
        let command = MenubarRemoteCommand(rawValue: "relaunch")
        #expect(command == .relaunch)
        #expect(command?.terminates == false)
        #expect(command?.unregistersLoginItem == false)
    }

    @Test("settings neither terminates nor unregisters the login item")
    func settingsNeitherTerminatesNorUnregisters() {
        let command = MenubarRemoteCommand(rawValue: "settings")
        #expect(command?.terminates == false)
        #expect(command?.unregistersLoginItem == false)
    }
}
