import axios from 'axios';
import { env } from '../lib/env';
import { logger } from '../lib/logger';

type AIResult = Record<string, any>;

/**
 * Default mock payload used whenever OPENAI_API_KEY is missing or a call fails.
 * This is intentionally generic; callers must tolerate missing fields.
 */
const DEFAULT_MOCK: AIResult = {
  reputation: 8,
  stabilityScore: 7,
  innovationScore: 8,
  overallScore: 7.7,
  summary:
    'Strong professional profile with good technical skills and clear career progression.',
  strengths: ['Technical depth', 'Production impact', 'Solid skill breadth'],
  weaknesses: ['Limited leadership visibility', 'Networking could expand'],
  recommendations: [
    'Pursue targeted certifications',
    'Increase public artifacts (talks, OSS)',
    'Mentor or lead small teams'
  ],
  riskFactors: ['Competitive market dynamics'],
  marketValue: 'Mid to Senior Level',
  confidence: 0.76
};

function useMock(): boolean {
  return !env.OPENAI_API_KEY || env.FORCE_MOCK_AI === 'true';
}

/**
 * Heuristically classify the incoming prompt so we can attach an appropriate schema.
 */
function detectKind(
  prompt: string
): 'profile' | 'company' | 'role' | 'generic' {
  const p = prompt.toLowerCase();
  if (
    p.includes('analyze company') ||
    p.includes('"industry"') ||
    p.includes('overallscore (all 1-10)') ||
    p.includes('company ')
  ) {
    return 'company';
  }
  if (
    p.includes('analyze this profile') ||
    p.includes('"strengths"') ||
    p.includes('riskfactors') ||
    p.includes('marketvalue')
  ) {
    return 'profile';
  }
  if (
    p.includes('analyze job role') ||
    p.includes('impactscore') ||
    p.includes('scopescore') ||
    p.includes('complexityscore')
  ) {
    return 'role';
  }
  return 'generic';
}

/**
 * JSON schemas (expressed in natural language + shape) the model must respect.
 */
function schemaFor(kind: 'profile' | 'company' | 'role' | 'generic'): string {
  if (kind === 'company') {
    return `{
  "industry": string,
  "size": string,
  "reputation": number (1-10),
  "stabilityScore": number (1-10),
  "innovationScore": number (1-10),
  "overallScore": number (1-10),
  "glassdoorRating": number | null,
  "linkedinFollowers": number | null,
  "foundedYear": number | null,
  "revenueRange": string | null,
  "growthRate": number | null,
  "confidence": number (0-1) OPTIONAL,
  "evidence": {
    "signals": string[] OPTIONAL,
    "missing": string[] OPTIONAL
  } OPTIONAL
}`;
  }
  if (kind === 'profile') {
    return `{
  "summary": string,
  "strengths": string[],
  "weaknesses": string[],
  "recommendations": string[],
  "riskFactors": string[],
  "marketValue": string,
  "confidence": number (0-1) OPTIONAL,
  "evidence": {
    "signals": string[] OPTIONAL,
    "missing": string[] OPTIONAL
  } OPTIONAL
}`;
  }
  if (kind === 'role') {
    return `{
  "impactScore": number (1-10),
  "scopeScore": number (1-10),
  "complexityScore": number (1-10),
  "highlights": string[],
  "risks": string[],
  "fitSignals": string[],
  "summary": string,
  "confidence": number (0-1) OPTIONAL,
  "evidence": {
    "signals": string[] OPTIONAL,
    "missing": string[] OPTIONAL
  } OPTIONAL
}`;
  }
  // Generic
  return `{
  "summary": string,
  "confidence": number (0-1) OPTIONAL
}`;
}

/**
 * Build a highly-instructed prompt with robust output constraints.
 */
function buildMessages(userPrompt: string) {
  const kind = detectKind(userPrompt);

  const SYSTEM_PROMPT = `
You are a **Senior Recruiter & Talent Intelligence Partner** with 15+ years of full‑cycle recruiting experience across software engineering, data, and product roles. 
You specialize in evidence‑based evaluation, bias‑aware scoring, and concise decision‑ready reporting.

PRINCIPLES
- Evidence over speculation. If information is insufficient, prefer nulls and list what's missing.
- Calibration: all 1–10 scales must be used consistently (5 = average market baseline; 9–10 are reserved for truly exceptional signals).
- Fairness: never infer protected characteristics; do not use demographic proxies (name, location, school prestige) to inflate/deflate scores.
- Practicality: highlight signals that are predictive of on‑the‑job success (impact, scope, complexity, consistency).
- Brevity with substance: outputs are compact but actionable; avoid fluff.

OUTPUT CONTRACT (HARD REQUIREMENTS)
- Return **exactly one** valid **JSON object**. **No markdown fences**, no commentary, no preamble, no trailing text.
- All numbers must be numeric types (not strings). Unknown values must be **null** (not "unknown").
- Arrays must contain plain strings (no nested JSON unless specified).
- Only include keys requested by the task, plus optional "confidence" (0–1) and optional "evidence": { "signals": string[], "missing": string[] }.
- Do **not** include internal reasoning, chain-of-thought, or analysis notes—only the final JSON fields.

RUBRICS & SCALES
- Reputation/Stability/Innovation/Overall (company): 1–10 where 5 = typical peer; 7–8 = strong; 9–10 = top decile.
- Role scoring: impact = measurable outcomes & ownership; scope = breadth/leadership/stakeholders; complexity = technical or operational difficulty.
- Profile scoring (when asked): weigh recency, impact, scope, and skill-market fit. Penalize vague or unverifiable claims.
- Recommendations: must be concrete, observable next steps (e.g., "publish post‑mortem with KPIs"), not platitudes.

ERROR HANDLING
- If the task conflicts with the schema, prioritize the schema inferred for the task.
- If the prompt is ambiguous, make the smallest safe assumption and set low "confidence".
`.trim();

  const USER_PROMPT = `
TASK
${userPrompt.trim()}

EXPECTED_JSON_SCHEMA
${schemaFor(kind)}

STRICT FORMAT RULES
1) Output a single minified JSON object. No code fences.
2) Only include the keys specified by EXPECTED_JSON_SCHEMA (plus optional "confidence" and optional "evidence").
3) Use null for unknowns; do not invent facts.

BEGIN NOW. RETURN JSON ONLY.
`.trim();

  return [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: USER_PROMPT }
  ];
}

function tryParseJson(raw: string): any | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* no-op */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* no-op */
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = trimmed.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return null;
}

export async function analyzeWithAI(prompt: string): Promise<AIResult> {
  if (useMock()) return DEFAULT_MOCK;

  try {
    const messages = buildMessages(prompt);

    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages
      },
      {
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const raw = (resp.data?.choices?.[0]?.message?.content ?? '').trim();
    const parsed = tryParseJson(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }

    logger.warn({ raw }, 'AI returned non-JSON; falling back to mock');
    return DEFAULT_MOCK;
  } catch (err) {
    logger.error({ err }, 'OpenAI call failed; falling back to mock');
    return DEFAULT_MOCK;
  }
}
