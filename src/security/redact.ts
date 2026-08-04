import type { JsonObject } from "../types.js";

type RedactionResult<T> = {
  value: T;
  redacted: boolean;
  reasons: string[];
};

const secretAssignmentPattern =
  /(\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi;
const privateKeyPattern =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const jwtPattern =
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g;

export function redactText(input: string): RedactionResult<string> {
  const reasons = new Set<string>();
  let value = input;

  value = value.replace(privateKeyPattern, () => {
    reasons.add("private key");
    return "[REDACTED PRIVATE KEY]";
  });
  value = value.replace(jwtPattern, () => {
    reasons.add("JWT");
    return "[REDACTED JWT]";
  });
  value = value.replace(secretAssignmentPattern, (prefix) => {
    const label = prefix.slice(
      0,
      prefix.indexOf(":") >= 0
        ? prefix.indexOf(":") + 1
        : prefix.indexOf("=") + 1,
    );
    reasons.add("secret assignment");
    return `${label}[REDACTED]`;
  });

  return {
    value,
    redacted: reasons.size > 0,
    reasons: [...reasons],
  };
}

function looksSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token)/i.test(
    key,
  );
}

export function redactJson(
  input: unknown,
  depth = 0,
): RedactionResult<unknown> {
  if (depth > 8) {
    return {
      value: "[REDACTED NESTED VALUE]",
      redacted: true,
      reasons: ["nested value too deep"],
    };
  }

  if (typeof input === "string") {
    return redactText(input);
  }

  if (Array.isArray(input)) {
    let redacted = false;
    const reasons = new Set<string>();
    const value = input.map((item) => {
      const result = redactJson(item, depth + 1);
      redacted ||= result.redacted;
      result.reasons.forEach((reason) => reasons.add(reason));
      return result.value;
    });
    return { value, redacted, reasons: [...reasons] };
  }

  if (input && typeof input === "object") {
    let redacted = false;
    const reasons = new Set<string>();
    const value: JsonObject = {};

    for (const [key, item] of Object.entries(input)) {
      if (looksSensitiveKey(key)) {
        value[key] = "[REDACTED]";
        redacted = true;
        reasons.add(`sensitive field: ${key}`);
        continue;
      }

      const result = redactJson(item, depth + 1);
      value[key] = result.value;
      redacted ||= result.redacted;
      result.reasons.forEach((reason) => reasons.add(reason));
    }

    return { value, redacted, reasons: [...reasons] };
  }

  return { value: input, redacted: false, reasons: [] };
}
