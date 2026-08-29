import Foundation
import Testing
@testable import ExarchFoundation

@Suite("Loopback transport")
struct LoopbackTransportTests {
    /// The transport carries signed device credentials. A status file that named
    /// somewhere other than loopback would send them off the machine, so the
    /// address is checked before anything is sent rather than trusted.
    @Test("refuses any address that is not plain HTTP on loopback")
    func rejectsNonLoopback() {
        for rejected in [
            "http://example.com:32146",
            "https://127.0.0.1:32146",
            "http://127.0.0.1",                 // no port
            "http://user:pass@127.0.0.1:32146",
            "http://127.0.0.1:32146/api",       // carries a path
            "http://127.0.0.1:32146?a=1"
        ] {
            #expect(throws: (any Error).self, "\(rejected)") {
                try LoopbackTransport.validate(URL(string: rejected)!)
            }
        }
    }

    @Test("accepts the address the daemon actually reports")
    func acceptsLoopback() throws {
        try LoopbackTransport.validate(URL(string: "http://127.0.0.1:32146")!)
        try LoopbackTransport.validate(URL(string: "http://127.0.0.1:32146/")!)
    }

    @Test("reads the daemon's reported address, and reports when it is not up")
    func readsStatus() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // Never started.
        #expect(try DaemonRuntimeStatus.read(dataDirectory: directory) == nil)

        try Data(#"{"version":1,"state":"online","pid":42,"apiBaseUrl":"http://127.0.0.1:32146"}"#.utf8)
            .write(to: directory.appendingPathComponent("runtime-status.json"))
        let online = try #require(try DaemonRuntimeStatus.read(dataDirectory: directory))
        #expect(online.isOnline)
        #expect(online.apiBaseUrl == "http://127.0.0.1:32146")

        // Stopped: the daemon rewrites the file on shutdown without an address.
        try Data(#"{"version":1,"state":"offline","pid":42,"apiBaseUrl":null}"#.utf8)
            .write(to: directory.appendingPathComponent("runtime-status.json"))
        let offline = try #require(try DaemonRuntimeStatus.read(dataDirectory: directory))
        #expect(!offline.isOnline)
    }

    @Test("strips the wire prefix from keys before enrolment")
    func stripsKeyPrefix() {
        #expect(LocalDeviceEnrollment.rawKey("p256:AAAA") == "AAAA")
        #expect(LocalDeviceEnrollment.rawKey("AAAA") == "AAAA")
    }
}
