import Foundation

/// Deterministic JSON used for signature payloads.
///
/// The laptop encodes with `JSON.stringify` over keys sorted by
/// `Array.prototype.sort()`, which orders by UTF-16 code unit. Foundation's
/// `.sortedKeys` does not: on Darwin it compares with `.caseInsensitive`,
/// `.numeric`, and `.widthInsensitive`, so `{"a10":…,"a9":…}` and any pair of
/// keys differing only in case come out in a different order. Today's payloads
/// happen to sort the same under both, which is luck rather than a property —
/// and a signature that verifies only by luck is worth removing from the
/// authorization path.
///
/// This encoder therefore does the ordering and the escaping itself, matching
/// `JSON.stringify`: UTF-16 code-unit key order, no escaped forward slashes, no
/// escaped non-ASCII, and the short escapes for the control characters that
/// have them.
public enum CanonicalJSON {
    public static func encode(_ value: Any) throws -> Data {
        guard JSONSerialization.isValidJSONObject(value) else {
            throw ExarchError.invalidPayload("Value is not valid JSON")
        }
        var output = String()
        try write(value, into: &output)
        return Data(output.utf8)
    }

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        // Re-encode through the deterministic writer so both entry points agree.
        let intermediate = try encoder.encode(value)
        let object = try JSONSerialization.jsonObject(with: intermediate, options: [.fragmentsAllowed])
        return try encode(object)
    }

    private static func write(_ value: Any, into output: inout String) throws {
        switch value {
        case is NSNull:
            output += "null"
        case let number as NSNumber:
            output += canonicalNumber(number)
        case let string as String:
            writeString(string, into: &output)
        case let array as [Any]:
            output += "["
            for (index, element) in array.enumerated() {
                if index > 0 { output += "," }
                try write(element, into: &output)
            }
            output += "]"
        case let object as [String: Any]:
            output += "{"
            for (index, key) in object.keys.sorted(by: precedesInUTF16Order).enumerated() {
                if index > 0 { output += "," }
                writeString(key, into: &output)
                output += ":"
                try write(object[key] as Any, into: &output)
            }
            output += "}"
        default:
            throw ExarchError.invalidPayload("Value is not valid JSON")
        }
    }

    /// Matches `Array.prototype.sort()` on strings, which compares UTF-16 code
    /// units. Swift's `<` compares Unicode scalars after canonical
    /// equivalence, which is not the same relation.
    private static func precedesInUTF16Order(_ left: String, _ right: String) -> Bool {
        var leftUnits = left.utf16.makeIterator()
        var rightUnits = right.utf16.makeIterator()
        while true {
            switch (leftUnits.next(), rightUnits.next()) {
            case (nil, nil): return false
            case (nil, _): return true
            case (_, nil): return false
            case let (leftUnit?, rightUnit?):
                if leftUnit != rightUnit { return leftUnit < rightUnit }
            }
        }
    }

    private static func canonicalNumber(_ number: NSNumber) -> String {
        if CFGetTypeID(number) == CFBooleanGetTypeID() {
            return number.boolValue ? "true" : "false"
        }
        let double = number.doubleValue
        guard double.isFinite else { return "null" }
        if double == 0 { return "0" } // JSON.stringify(-0) is also "0".
        return ecmaScriptNumber(double)
    }

    /// Swift's `Double.description` supplies shortest round-trip digits, but it
    /// chooses scientific notation at different thresholds and pads exponents
    /// (`1e-07`). Re-render those digits using the thresholds from ECMAScript's
    /// `Number::toString`, which is what `JSON.stringify` uses.
    private static func ecmaScriptNumber(_ value: Double) -> String {
        let negative = value < 0
        let raw = String(abs(value)).lowercased()
        let parts = raw.split(separator: "e", maxSplits: 1).map(String.init)
        let mantissa = parts[0]
        let explicitExponent = parts.count == 2 ? Int(parts[1]) ?? 0 : nil
        let decimalParts = mantissa
            .split(separator: ".", omittingEmptySubsequences: false)
            .map(String.init)
        let integer = decimalParts[0]
        let fraction = decimalParts.count == 2 ? decimalParts[1] : ""

        var digits: String
        let exponent: Int
        if let explicitExponent {
            digits = integer + fraction
            exponent = explicitExponent + integer.count - 1
        } else if let first = integer.firstIndex(where: { $0 != "0" }) {
            let significantInteger = String(integer[first...])
            digits = significantInteger + fraction
            exponent = significantInteger.count - 1
        } else if let first = fraction.firstIndex(where: { $0 != "0" }) {
            digits = String(fraction[first...])
            exponent = -(fraction.distance(from: fraction.startIndex, to: first) + 1)
        } else {
            return "0"
        }
        while digits.last == "0" { digits.removeLast() }

        let n = exponent + 1
        let k = digits.count
        let unsigned: String
        if k <= n && n <= 21 {
            unsigned = digits + String(repeating: "0", count: n - k)
        } else if 0 < n && n <= 21 {
            let point = digits.index(digits.startIndex, offsetBy: n)
            unsigned = String(digits[..<point]) + "." + String(digits[point...])
        } else if -6 < n && n <= 0 {
            unsigned = "0." + String(repeating: "0", count: -n) + digits
        } else {
            let tail = String(digits.dropFirst())
            let coefficient = tail.isEmpty
                ? String(digits.prefix(1))
                : "\(digits.prefix(1)).\(tail)"
            let scientificExponent = n - 1
            let sign = scientificExponent >= 0 ? "+" : "-"
            unsigned = "\(coefficient)e\(sign)\(abs(scientificExponent))"
        }
        return negative ? "-" + unsigned : unsigned
    }

    private static func writeString(_ value: String, into output: inout String) {
        output += "\""
        for unit in value.unicodeScalars {
            switch unit {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\u{08}": output += "\\b"
            case "\u{0C}": output += "\\f"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            default:
                if unit.value < 0x20 {
                    output += String(format: "\\u%04x", unit.value)
                } else {
                    output.unicodeScalars.append(unit)
                }
            }
        }
        output += "\""
    }
}
