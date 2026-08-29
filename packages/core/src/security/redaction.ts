/**
 * Best-effort secret removal applied before provider output is persisted and
 * before a repository patch is shown on a paired device.
 *
 * This is a denylist. It reliably removes the shapes it knows and cannot
 * promise anything about the ones it does not, so it is a reduction in exposure
 * rather than a boundary. Anything that depends on a secret never reaching the
 * canonical store needs a control that does not rely on recognizing the secret.
 */

const SENSITIVE_KEY =
  /(?:api[_-]?key|access[_-]?key|secret|passwd|password|passphrase|credential|token|authorization|cookie|private[_-]?key|client[_-]?secret|connection[_-]?string|session[_-]?id)/i;

interface SecretPattern {
  /** Appears in the redaction marker and in the placeholder, so it must be stable. */
  name: string;
  pattern: RegExp;
  /**
   * When true, the pattern uses named `prefix` and `suffix` groups and only the
   * text between them is replaced, so `PASSWORD=hunter2` becomes
   * `PASSWORD=[REDACTED:…]` rather than losing the name that leaked.
   */
  keepsSurroundingText?: boolean;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // Whole PEM blocks first: a later single-line pattern must not carve one up.
  //
  // The body is restricted to base64 and whitespace, and bounded. An
  // unterminated BEGIN marker used to send the engine scanning to the end of
  // the input from every marker it found, which is quadratic in the number of
  // markers: a megabyte of repeated BEGIN lines took seven seconds on the
  // daemon's only thread. A character class that cannot cross a non-base64
  // byte stops at the first line the block does not own.
  {
    name: "private-key-block",
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,20000}-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g
  },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { name: "google-api-key", pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe-key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "github-token", pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: "openai-style-key", pattern: /\bsk-(?:[A-Za-z0-9_-]+-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "bearer-credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  // Credentials embedded in a URL, e.g. postgres://user:password@host/db.
  {
    name: "url-credential",
    pattern: /(?<prefix>[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:)[^\s/?#@]+(?<suffix>@)/gi,
    keepsSurroundingText: true
  },
  // Assignments in .env dumps, shell transcripts, and config files.
  {
    name: "assigned-credential",
    pattern:
      /(?<prefix>(?:api[_-]?key|access[_-]?key|secret[_-]?(?:key|access[_-]?key)?|passwd|password|passphrase|token|credential)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
    keepsSurroundingText: true
  }
];

export interface RedactionResult<T> {
  value: T;
  redacted: boolean;
  markers: string[];
}

export function redactPayload<T>(value: T): RedactionResult<T> {
  const markers = new Set<string>();

  const visit = (item: unknown, key?: string): unknown => {
    if (key !== undefined && SENSITIVE_KEY.test(key)) {
      markers.add(`key:${key.toLowerCase()}`);
      return `[REDACTED:${key.toUpperCase()}]`;
    }
    if (typeof item === "string") {
      return redactString(item, markers);
    }
    if (Array.isArray(item)) {
      return item.map((entry) => visit(entry));
    }
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([entryKey, entryValue]) => [
          entryKey,
          visit(entryValue, entryKey)
        ])
      );
    }
    return item;
  };

  const redactedValue = visit(value) as T;
  return {
    value: redactedValue,
    redacted: markers.size > 0,
    markers: [...markers].sort()
  };
}

/** Exposed so callers can redact a plain string without wrapping it in an object. */
export function redactText(value: string): RedactionResult<string> {
  const markers = new Set<string>();
  const redacted = redactString(value, markers);
  return { value: redacted, redacted: markers.size > 0, markers: [...markers].sort() };
}

function redactString(value: string, markers: Set<string>): string {
  let result = value;
  for (const { name, pattern, keepsSurroundingText } of SECRET_PATTERNS) {
    const placeholder = `[REDACTED:${name.toUpperCase().replaceAll("-", "_")}]`;
    result = result.replace(pattern, (...args: unknown[]) => {
      markers.add(`pattern:${name}`);
      if (keepsSurroundingText !== true) return placeholder;
      // With named groups the final argument is the groups object. Reading the
      // names avoids depending on positional arity, where the argument after
      // the last capture group is the match offset rather than a group.
      const groups = args.at(-1) as { prefix?: string; suffix?: string } | undefined;
      return `${groups?.prefix ?? ""}${placeholder}${groups?.suffix ?? ""}`;
    });
  }
  return result;
}
