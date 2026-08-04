/**
 * Server-side tag derivation.
 *
 * Recall is lexical, so a memory is only findable through words it contains.
 * Deriving canonical domain tags from title and content keeps memories
 * reachable by domain queries and by the `tags` filter even when the writing
 * agent supplied no useful tags.
 */

export const MAX_DERIVED_TAGS = 8;
export const MAX_TOTAL_TAGS = 20;

type TagRule = {
  tag: string;
  aliases: readonly string[];
};

export const TAG_RULES: readonly TagRule[] = [
  { tag: "spark", aliases: ["spark", "pyspark"] },
  { tag: "etl", aliases: ["etl", "etls"] },
  { tag: "airflow", aliases: ["airflow", "dag", "dags"] },
  { tag: "databricks", aliases: ["databricks"] },
  { tag: "firebolt", aliases: ["firebolt"] },
  { tag: "sql", aliases: ["sql", "postgres", "postgresql", "mysql"] },
  { tag: "python", aliases: ["python"] },
  { tag: "typescript", aliases: ["typescript", "tsx"] },
  { tag: "javascript", aliases: ["javascript", "nodejs", "node.js", "npm"] },
  { tag: "docker", aliases: ["docker", "dockerfile"] },
  { tag: "kubernetes", aliases: ["kubernetes", "k8s", "helm"] },
  { tag: "terraform", aliases: ["terraform"] },
  {
    tag: "git",
    aliases: [
      "git",
      "github",
      "gitlab",
      "commit",
      "merge request",
      "pull request",
    ],
  },
  {
    tag: "testing",
    aliases: ["test", "tests", "testing", "pytest", "vitest", "unittest"],
  },
  { tag: "s3", aliases: ["s3"] },
  { tag: "aws", aliases: ["aws"] },
  { tag: "slack", aliases: ["slack"] },
  { tag: "datadog", aliases: ["datadog"] },
  { tag: "jira", aliases: ["jira"] },
  { tag: "react", aliases: ["react"] },
  { tag: "api", aliases: ["api"] },
  {
    tag: "security",
    aliases: ["secret", "secrets", "credential", "credentials", "token"],
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function aliasPattern(alias: string): RegExp {
  const escaped = escapeRegExp(alias);
  const prefix = /^[\p{L}\p{N}_]/u.test(alias) ? "\\b" : "";
  const suffix = /[\p{L}\p{N}_]$/u.test(alias) ? "\\b" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "iu");
}

const COMPILED_RULES: ReadonlyArray<{ tag: string; patterns: RegExp[] }> =
  TAG_RULES.map((rule) => ({
    tag: rule.tag,
    patterns: rule.aliases.map(aliasPattern),
  }));

/** Canonical domain tags present in free text, in rule order. */
export function deriveTags(text: string, max = MAX_DERIVED_TAGS): string[] {
  if (!text.trim()) {
    return [];
  }

  const derived: string[] = [];
  for (const rule of COMPILED_RULES) {
    if (derived.length >= max) {
      break;
    }
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      derived.push(rule.tag);
    }
  }
  return derived;
}

/** Explicit tags win over derived tags; comparison ignores case. */
export function mergeTags(
  explicit: readonly string[],
  derived: readonly string[],
  max = MAX_TOTAL_TAGS,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const tag of [...explicit, ...derived]) {
    const trimmed = tag.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(trimmed);
    if (merged.length >= max) {
      break;
    }
  }

  return merged;
}

/** Final tag list for a stored memory: explicit tags plus derived domain tags. */
export function tagsWithDerived(input: {
  title: string;
  content: string;
  tags: readonly string[];
}): string[] {
  const derived = deriveTags(`${input.title}\n${input.content}`);
  return mergeTags(input.tags, derived);
}
