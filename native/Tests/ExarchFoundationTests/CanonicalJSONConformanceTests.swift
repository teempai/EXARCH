import Foundation
import Testing
@testable import ExarchFoundation

/// Verifies the Swift encoder against the same fixture the TypeScript test uses.
///
/// This is the check that makes signature payloads interoperable. Without it the
/// two encoders agree only where their standard libraries happen to: Foundation's
/// `.sortedKeys` compares case-insensitively and numerically, so `{"A":…,"a":…}`
/// and `{"item9":…,"item10":…}` would come out in the other order.
@Suite("Canonical JSON conformance")
struct CanonicalJSONConformanceTests {
    private struct Fixture: Decodable {
        struct Vector: Decodable {
            let name: String
            let value: JSONValue
            let encoded: String
        }
        let vectors: [Vector]
    }

    @Test("the Swift encoder reproduces the shared conformance vectors")
    func matchesSharedVectors() throws {
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("tests/fixtures/canonical-json-vectors.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        #expect(fixture.vectors.isEmpty == false)

        for vector in fixture.vectors {
            let encoded = try CanonicalJSON.encode(vector.value.foundationObject)
            #expect(String(decoding: encoded, as: UTF8.self) == vector.encoded, "\(vector.name)")
        }
    }

    @Test("key ordering follows UTF-16 code units rather than Foundation's collation")
    func keyOrderingIsCodeUnitOrder() throws {
        let encoded = try CanonicalJSON.encode(["a": 1, "B": 2, "A": 3, "b": 4] as [String: Any])
        #expect(String(decoding: encoded, as: UTF8.self) == #"{"A":3,"B":2,"a":1,"b":4}"#)
    }

    @Test("number formatting matches JSON.stringify thresholds and never narrows through Int64")
    func numberFormattingMatchesECMAScript() throws {
        let values: [String: Any] = [
            "negativeZero": -0.0,
            "belowFixedThreshold": 1e-7,
            "fixedThreshold": 1e-6,
            "largeFixed": 1e20,
            "scientificThreshold": 1e21,
            "largeRoundedInteger": 1_000_000_000_000_000_100.0,
            "smallest": Double.leastNonzeroMagnitude,
            "largest": Double.greatestFiniteMagnitude
        ]
        let encoded = String(decoding: try CanonicalJSON.encode(values), as: UTF8.self)
        #expect(encoded == #"{"belowFixedThreshold":1e-7,"fixedThreshold":0.000001,"largeFixed":100000000000000000000,"largeRoundedInteger":1000000000000000100,"largest":1.7976931348623157e+308,"negativeZero":0,"scientificThreshold":1e+21,"smallest":5e-324}"#)
    }
}

private extension JSONValue {
    /// The fixture decodes into `JSONValue`; the encoder takes Foundation types.
    var foundationObject: Any {
        switch self {
        case .null: NSNull()
        case let .bool(value): value
        case let .number(value): value == value.rounded() && abs(value) < 1e15 ? Int(value) : value
        case let .string(value): value
        case let .array(values): values.map(\.foundationObject)
        case let .object(values): values.mapValues(\.foundationObject)
        }
    }
}
