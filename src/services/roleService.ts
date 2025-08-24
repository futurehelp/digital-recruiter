import { CompanyRating, RoleAnalysis, WorkExperience } from '../types';
import { analyzeWithAI } from './openaiClient';

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function monthIndex(m: string): number | null {
  const map: Record<string, number> = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };
  const key = m.trim().toLowerCase();
  return key in map ? map[key] : null;
}

function parseMonthYear(input?: string): Date | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (!s || s === 'present' || s === 'current') return new Date();
  // Try "Jan 2022" or "January 2022"
  const m1 = s.match(/^([a-z]{3,9})\s+(\d{4})$/i);
  if (m1) {
    const mi = monthIndex(m1[1]);
    const year = parseInt(m1[2], 10);
    if (mi !== null && Number.isFinite(year)) return new Date(year, mi, 1);
  }
  // Try "2022"
  const m2 = s.match(/^(\d{4})$/);
  if (m2) {
    const year = parseInt(m2[1], 10);
    if (Number.isFinite(year)) return new Date(year, 0, 1);
  }
  return null;
}

function monthsBetween(a: Date, b: Date): number {
  const years = b.getFullYear() - a.getFullYear();
  const months = b.getMonth() - a.getMonth();
  return years * 12 + months + (b.getDate() >= a.getDate() ? 0 : -1);
}

function tenureMonthsFrom(ex: WorkExperience): number {
  const start = parseMonthYear(ex.startDate);
  const end = parseMonthYear(ex.endDate || 'present') || new Date();
  if (!start) return 0;
  const diff = monthsBetween(start, end);
  return Math.max(0, diff);
}

function heuristicRoleAnalysis(
  ex: WorkExperience,
  company?: CompanyRating
): RoleAnalysis {
  const desc = (ex.description || '').toLowerCase();
  const len = ex.description ? ex.description.length : 0;

  const has = (...ks: string[]) => ks.some((k) => desc.includes(k));

  let impact = 3 + Math.min(len / 250, 4);
  if (has('led', 'delivered', 'launched', 'shipped', 'drove')) impact += 1.5;
  if (has('kpi', 'revenue', 'growth', 'adoption', 'retention', 'nps')) impact += 1;
  if (/\b\d{1,3}k\b|\b\d{1,3}m\b|\b\d{1,3}%\b/.test(desc)) impact += 0.5;

  let scope = 3;
  if (has('team', 'managed', 'manager', 'lead')) scope += 1.5;
  if (has('cross-functional', 'stakeholder', 'executive', 'c-level')) scope += 1;
  if (company && company.size && /([1-9]\d{2,})/.test(company.size)) scope += 0.5; // bigger org

  let complexity = 3;
  if (has('distributed', 'scalable', 'microservices', 'concurrency')) complexity += 1;
  if (has('ml', 'machine learning', 'nlp', 'cv')) complexity += 1;
  if (has('kubernetes', 'k8s', 'docker', 'aws', 'gcp', 'azure')) complexity += 0.5;
  if (has('security', 'compliance', 'pci', 'soc2', 'hipaa')) complexity += 0.5;

  const tenureMonths = tenureMonthsFrom(ex);

  const highlights: string[] = [];
  if (has('led', 'launched', 'delivered')) highlights.push('Delivered/led key initiatives');
  if (has('scaled', 'performance', 'reliability')) highlights.push('Scaled performance/reliability');
  if (has('aws', 'gcp', 'azure', 'kubernetes')) highlights.push('Modern cloud-native stack');
  if (/\b\d{2,}%\b/.test(desc)) highlights.push('Quantified outcomes');

  const risks: string[] = [];
  if (len < 80) risks.push('Sparse role description');
  if (tenureMonths < 6) risks.push('Short tenure (<6 months)');
  if (!/\b(react|node|python|java|go|rust|aws|gcp|azure|ml)\b/.test(desc))
    risks.push('Few verifiable tech signals');

  const fitSignals: string[] = [];
  if (has('ownership', 'end-to-end', 'accountable')) fitSignals.push('Ownership mindset');
  if (has('mentor', 'mentored', 'coached')) fitSignals.push('Mentorship/leadership capacity');
  if (has('data-driven', 'experiment', 'ab test')) fitSignals.push('Evidence-based decision-making');

  return {
    impactScore: clamp(impact, 1, 10),
    scopeScore: clamp(scope, 1, 10),
    complexityScore: clamp(complexity, 1, 10),
    tenureMonths,
    highlights: highlights.slice(0, 5),
    risks: risks.slice(0, 5),
    fitSignals: fitSignals.slice(0, 5),
    summary:
      'Role analyzed using heuristic signals due to limited/uncertain AI response.'
  };
}

/**
 * Analyze a single job role. Uses AI when available; falls back to heuristics.
 */
export async function analyzeJobRole(
  experience: WorkExperience,
  company?: CompanyRating
): Promise<RoleAnalysis> {
  const input = {
    position: experience.position,
    company: experience.company,
    duration: experience.duration,
    startDate: experience.startDate,
    endDate: experience.endDate ?? 'present',
    description: experience.description,
    location: experience.location ?? null,
    companyContext: company
      ? {
          name: company.name,
          industry: company.industry,
          size: company.size,
          reputation: company.reputation,
          overallScore: company.overallScore
        }
      : null
  };

  const ai = await analyzeWithAI(
    `Analyze job role with the lens of impact/scope/complexity and return JSON conforming to the ROLE schema:
Analyze job role:
${JSON.stringify(input)}`
  );

  // If AI provided valid role fields, use them; else fallback to heuristics.
  const impactScore = Number(ai?.impactScore);
  const scopeScore = Number(ai?.scopeScore);
  const complexityScore = Number(ai?.complexityScore);

  const ok =
    Number.isFinite(impactScore) &&
    Number.isFinite(scopeScore) &&
    Number.isFinite(complexityScore);

  if (ok) {
    const tenureMonths = tenureMonthsFrom(experience);
    return {
      impactScore: Math.max(1, Math.min(10, impactScore)),
      scopeScore: Math.max(1, Math.min(10, scopeScore)),
      complexityScore: Math.max(1, Math.min(10, complexityScore)),
      tenureMonths,
      highlights: Array.isArray(ai?.highlights) ? ai.highlights.slice(0, 8) : [],
      risks: Array.isArray(ai?.risks) ? ai.risks.slice(0, 8) : [],
      fitSignals: Array.isArray(ai?.fitSignals) ? ai.fitSignals.slice(0, 8) : [],
      summary: typeof ai?.summary === 'string' ? ai.summary : 'Role summary unavailable',
      confidence: typeof ai?.confidence === 'number' ? ai.confidence : undefined
    };
  }

  // Fallback
  return heuristicRoleAnalysis(experience, company);
}
