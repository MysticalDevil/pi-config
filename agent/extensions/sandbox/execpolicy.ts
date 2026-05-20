/**
 * ExecPolicy Engine — JSON-based declarative command policy
 *
 * Inspired by Codex's Starlark execpolicy. Rules are defined in JSON files
 * with prefix matching, alternatives, and allow/prompt/forbidden decisions.
 *
 * Rule files (merged in order):
 * - ~/.pi/agent/extensions/sandbox/default.rules    (default, always loaded)
 * - <cwd>/.pi/rules/*.rules                          (project-specific)
 *
 * Format:
 * {
 *   "rules": [
 *     {
 *       "pattern": ["git", "reset", "--hard"],
 *       "decision": "forbidden",
 *       "justification": "destructive operation"
 *     },
 *     {
 *       "pattern": ["rm", ["-rf", "-r", "--recursive"]],
 *       "decision": "prompt",
 *       "justification": "recursive delete requires approval"
 *     }
 *   ],
 *   "banned_prefixes": [
 *     ["python3", "-c"],
 *     ["bash", "-c"]
 *   ]
 * }
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────

export type Decision = "allow" | "prompt" | "forbidden";

export interface RuleDef {
  pattern: (string | string[])[];
  decision?: Decision; // defaults to "allow"
  justification?: string;
}

export interface PolicyFile {
  rules?: RuleDef[];
  banned_prefixes?: string[][];
}

export interface RuleMatch {
  rule: RuleDef;
  matchedPrefix: string[];
  decision: Decision;
  justification?: string;
}

export interface Evaluation {
  matchedRules: RuleMatch[];
  decision: Decision | null; // null when no rules matched
}

// ── Tokenization ──────────────────────────────────────────────────────

/**
 * Tokenize a command string into args using simple shell-like splitting.
 * Handles single/double quotes and backslash escaping.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const ch of command) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') { inDouble = false; continue; }
      current += ch;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === " " || ch === "\t") {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

// ── Pattern matching ──────────────────────────────────────────────────

/**
 * Check if a single token matches a pattern element.
 * If the pattern element is a string, exact match.
 * If it's an array, any element matches.
 * Special: "*" matches any single token.
 */
function tokenMatches(token: string, patternElem: string | string[]): boolean {
  if (typeof patternElem === "string") {
    return patternElem === "*" || token === patternElem;
  }
  return patternElem.some((alt) => token === alt);
}

/**
 * Check if command tokens match a rule's prefix pattern.
 */
function matchRule(tokens: string[], rule: RuleDef): { matched: boolean; prefix: string[] } {
  if (rule.pattern.length === 0) return { matched: false, prefix: [] };
  if (tokens.length < rule.pattern.length) return { matched: false, prefix: [] };

  for (let i = 0; i < rule.pattern.length; i++) {
    if (!tokenMatches(tokens[i], rule.pattern[i])) {
      return { matched: false, prefix: [] };
    }
  }
  return { matched: true, prefix: tokens.slice(0, rule.pattern.length) };
}

// ── Evaluation ────────────────────────────────────────────────────────

function decisionSeverity(d: Decision): number {
  switch (d) {
    case "forbidden": return 3;
    case "prompt": return 2;
    case "allow": return 1;
  }
}

/**
 * Evaluate command tokens against a list of rules.
 * Returns all matching rules and the strictest decision.
 */
export function evaluateTokens(tokens: string[], rules: RuleDef[]): Evaluation {
  const matched: RuleMatch[] = [];

  for (const rule of rules) {
    const result = matchRule(tokens, rule);
    if (result.matched) {
      matched.push({
        rule,
        matchedPrefix: result.prefix,
        decision: rule.decision ?? "allow",
        justification: rule.justification,
      });
    }
  }

  if (matched.length === 0) {
    return { matchedRules: [], decision: null };
  }

  // Strictest decision across all matches
  const strictest = matched.reduce((a, b) =>
    decisionSeverity(a.decision) >= decisionSeverity(b.decision) ? a : b
  );

  return {
    matchedRules: matched,
    decision: strictest.decision,
  };
}

/**
 * Check if command tokens match any banned prefix.
 */
export function matchesBannedPrefix(
  tokens: string[],
  bannedPrefixes: string[][],
): string[] | null {
  for (const bp of bannedPrefixes) {
    if (bp.length === 0) continue;
    if (tokens.length < bp.length) continue;
    let match = true;
    for (let i = 0; i < bp.length; i++) {
      if (tokens[i] !== bp[i]) { match = false; break; }
    }
    if (match) return bp;
  }
  return null;
}

/**
 * Evaluate a command string end-to-end.
 */
export function evaluateCommand(
  command: string,
  policy: { rules: RuleDef[]; bannedPrefixes: string[][] },
): { evaluation: Evaluation; bannedBy: string[] | null } {
  const tokens = tokenize(command);
  if (tokens.length === 0) {
    return { evaluation: { matchedRules: [], decision: null }, bannedBy: null };
  }
  const evaluation = evaluateTokens(tokens, policy.rules);
  const bannedBy = matchesBannedPrefix(tokens, policy.bannedPrefixes);
  return { evaluation, bannedBy };
}

// ── Loading ───────────────────────────────────────────────────────────

const DEFAULT_RULES: PolicyFile = {
  rules: [
    {
      pattern: ["rm", ["-rf", "-r", "--recursive"]],
      decision: "prompt",
      justification: "Recursive delete — check before proceeding",
    },
    {
      pattern: ["sudo"],
      decision: "prompt",
      justification: "Privilege escalation via sudo",
    },
    {
      pattern: ["chmod", "*", "777"],
      decision: "prompt",
      justification: "World-writable permissions",
    },
    {
      pattern: ["git", "push", "--force"],
      decision: "prompt",
      justification: "Force push rewrites remote history",
    },
    {
      pattern: ["git", "push", ["-f", "--force"]],
      decision: "prompt",
      justification: "Force push rewrites remote history",
    },
    {
      pattern: ["shutdown"],
      decision: "forbidden",
      justification: "System shutdown — use sudo shutdown manually",
    },
    {
      pattern: ["reboot"],
      decision: "forbidden",
      justification: "System reboot — use sudo reboot manually",
    },
    {
      pattern: ["dd", "if="],
      decision: "forbidden",
      justification: "Raw disk copy is destructive",
    },
    {
      pattern: ["mkfs"],
      decision: "forbidden",
      justification: "Filesystem creation is destructive",
    },
    {
      pattern: [":(){ :|:& };:"],
      decision: "forbidden",
      justification: "Fork bomb pattern",
    },
  ],
  banned_prefixes: [
    ["python3"],
    ["python3", "-c"],
    ["python"],
    ["python", "-c"],
    ["bash"],
    ["bash", "-c"],
    ["sh"],
    ["sh", "-c"],
    ["zsh"],
    ["zsh", "-c"],
  ],
};

export interface LoadedPolicy {
  rules: RuleDef[];
  bannedPrefixes: string[][];
  sources: string[];
}

export function loadPolicy(cwd: string): LoadedPolicy {
  const rules: RuleDef[] = [];
  const bannedPrefixes: string[][] = [];
  const sources: string[] = [];

  // 1. Default rules
  for (const r of DEFAULT_RULES.rules ?? []) rules.push(r);
  for (const bp of DEFAULT_RULES.banned_prefixes ?? []) bannedPrefixes.push(bp);
  sources.push("builtin");

  // 2. Global rules: ~/.pi/agent/extensions/sandbox/default.rules
  const globalPath = join(getAgentDir(), "extensions", "sandbox", "default.rules");
  if (existsSync(globalPath)) {
    try {
      const parsed = JSON.parse(readFileSync(globalPath, "utf-8")) as PolicyFile;
      for (const r of parsed.rules ?? []) rules.push(r);
      for (const bp of parsed.banned_prefixes ?? []) bannedPrefixes.push(bp);
      sources.push("global");
    } catch (e) {
      console.error(`Warning: Could not parse ${globalPath}: ${e}`);
    }
  }

  // 3. Project rules: <cwd>/.pi/rules/*.rules
  const projectRulesDir = join(cwd, ".pi", "rules");
  if (existsSync(projectRulesDir)) {
    try {
      for (const entry of readdirSync(projectRulesDir)) {
        if (!entry.endsWith(".rules")) continue;
        const path = join(projectRulesDir, entry);
        try {
          const parsed = JSON.parse(readFileSync(path, "utf-8")) as PolicyFile;
          for (const r of parsed.rules ?? []) rules.push(r);
          for (const bp of parsed.banned_prefixes ?? []) bannedPrefixes.push(bp);
          sources.push(`project:${entry}`);
        } catch (e) {
          console.error(`Warning: Could not parse ${path}: ${e}`);
        }
      }
    } catch {
      // dir doesn't exist or can't read
    }
  }

  return { rules, bannedPrefixes, sources };
}
