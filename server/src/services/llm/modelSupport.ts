export interface ClaudeModelVersion {
  family: string;
  major: number;
  minor: number;
}

const CLAUDE_MODEL_RE = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/i;

export function parseClaudeModelVersion(model: string): ClaudeModelVersion | null {
  const m = model.match(CLAUDE_MODEL_RE);
  if (!m) return null;
  return { family: m[1].toLowerCase(), major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 };
}

function isAtLeast(v: ClaudeModelVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

export function supportsEffort(model: string): boolean {
  const v = parseClaudeModelVersion(model);
  return v !== null && isAtLeast(v, 4, 6);
}

export function requiresDataRetention(model: string): boolean {
  return /fable|mythos/i.test(model);
}

export function acceptsTemperature(model: string): boolean {
  const v = parseClaudeModelVersion(model);
  return v !== null && !isAtLeast(v, 4, 7);
}

export function thinksByDefault(model: string): boolean {
  const v = parseClaudeModelVersion(model);
  return v !== null && v.major >= 5;
}
