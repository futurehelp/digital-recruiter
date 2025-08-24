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

function hasAny(text: string, kws: string[]) {
  const t = text.toLowerCase();
  return kws.some((k) => t.includes(k));
}

function seniorityLevel(position = '', companyName = ''): number {
  const t = `${position} ${companyName}`.toLowerCase();
  // Strong senior signals
  if (
    hasAny(t, [
      'cto', 'chief technology officer', 'ceo', 'coo', 'cso',
      'founder', 'co-founder', 'cofounder',
      'distinguished', 'fellow',
      'principal engineer', 'principal scientist',
      'member of technical staff', 'mts', 'staff engineer', 'staff scientist',
      'executive director'
    ])
  ) return 2.5;
  // Moderate senior signals
  if (hasAny(t, ['vp', 'svp', 'evp', 'director', 'head of', 'lead', 'senior'])) return 1.5;
  return 0;
}

function heuristicRoleAnalysis(
  ex: WorkExperience,
  company?: CompanyRating
): RoleAnalysis {
  const desc = (ex.description || '').toLowerCase();
  const len = ex.description ? ex.description.length : 0;

  // Start from **neutral baselines** (not punitive)
  let impact = 6.0;
  let scope = 6.0;
  let complexity = 6.0;

  // Seniority bumps (Founder/CTO/Staff/Principal/Director/VP/etc.)
  const seniorBump = seniorityLevel(ex.position, ex.company);
  impact += seniorBump * 0.8;
  scope += seniorBump * 1.1;
  complexity += seniorBump * 0.6;

  // Company size/quality gives small scope/context boost
  if (company) {
    if (company.overallScore >= 8.5) {
      impact += 0.6; scope += 0.8; complexity += 0.4;
    } else if (company.overallScore >= 7.5) {
      impact += 0.3; scope += 0.4; complexity += 0.2;
    }
  }

  // Content signals
  const delivered = hasAny(desc, ['led', 'delivered', 'launched', 'shipped', 'drove', 'built']);
  const metrics = /\b\d{1,3}k\b|\b\d{1,3}m\b|\b\d{1,3}b\b|\b\d{1,3}%\b|\b(?:million|billion|thousand)\b/.test(desc);
  const scale = hasAny(desc, ['scale', 'scalable', 'throughput', 'latency', 'p99', 'reliability']);
  const cloud = hasAny(desc, ['kubernetes', 'k8s', 'docker', 'aws', 'gcp', 'azure']);
  const ml = hasAny(desc, ['ml', 'machine learning', 'nlp', 'cv', 'reinforcement learning', 'rl']);

  if (delivered) impact += 0.6;
  if (metrics) impact += 0.5;
  if (scale) complexity += 0.5;
  if (cloud) complexity += 0.3;
  if (ml) { impact += 0.2; complexity += 0.6; }

  // Tenure adjustments (small, bounded)
  const tenureMonths = tenureMonthsFrom(ex);
  if (tenureMonths >= 48) { impact += 0.4; scope += 0.5; }
  else if (tenureMonths >= 24) { impact += 0.2; scope += 0.3; }
  else if (tenureMonths > 0 && tenureMonths < 6) { impact -= 0.4; scope -= 0.4; complexity -= 0.2; }

  // Sparse description => do NOT punish harshly; just add a risk
  const highlights: string[] = [];
  if (delivered) highlights.push('Delivered/led key initiatives');
  if (scale) highlights.push('Scaled performance/reliability');
  if (cloud) highlights.push('Modern cloud-native stack');
  if (metrics) highlights.push('Reported quantifiable outcomes');

  const risks: string[] = [];
  if (len < 80) risks.push('Sparse role description');
  if (tenureMonths > 0 && tenureMonths < 6) risks.push('Short tenure (<6 months)');
  if (!ml && !cloud && !scale && !metrics && len < 120) risks.push('Few verifiable signals');

  const fitSignals: string[] = [];
  if (hasAny(desc, ['ownership', 'end-to-end', 'accountable'])) fitSignals.push('Ownership mindset');
  if (hasAny(desc, ['mentor', 'mentored', 'coached'])) fitSignals.push('Mentorship');
  if (hasAny(desc, ['data-driven', 'ab test', 'experiment'])) fitSignals.push('Evidence-based decisions');

  return {
    impactScore: clamp(impact, 1, 10),
    scopeScore: clamp(scope, 1, 10),
    complexityScore: clamp(complexity, 1, 10),
    tenureMonths,
    highlights: highlights.slice(0, 6),
    risks: risks.slice(0, 6),
    fitSignals: fitSignals.slice(0, 6),
    summary: 'Role scored with neutral baseline; boosted by seniority, employer quality, and content signals.'
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
      impactScore: clamp(impactScore, 1, 10),
      scopeScore: clamp(scopeScore, 1, 10),
      complexityScore: clamp(complexityScore, 1, 10),
      tenureMonths,
      highlights: Array.isArray(ai?.highlights) ? ai.highlights.slice(0, 8) : [],
      risks: Array.isArray(ai?.risks) ? ai.risks.slice(0, 8) : [],
      fitSignals: Array.isArray(ai?.fitSignals) ? ai.fitSignals.slice(0, 8) : [],
      summary: typeof ai?.summary === 'string' ? ai.summary : 'Role summary unavailable',
      confidence: typeof ai?.confidence === 'number' ? ai.confidence : undefined
    };
  }

  // Fallback (neutral baselines + signals)
  return heuristicRoleAnalysis(experience, company);
}

// Exported for use in score weighting (company-by-tenure)
export { tenureMonthsFrom };