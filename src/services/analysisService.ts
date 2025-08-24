import {
  LinkedInProfile,
  OverallRating,
  ProfileRating,
  CompanyRating,
  ExperienceAnalysis,
  TimelineItem
} from '../types';
import { analyzeWithAI } from './openaiClient';
import { tenureMonthsFrom } from './roleService';

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function parseMonthYear(input?: string): Date | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (!s || s === 'present' || s === 'current') return new Date();
  const m1 = s.match(/^([a-z]{3,9})\s+(\d{4})$/i);
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
  if (m1) {
    const mi = map[m1[1].toLowerCase()];
    const year = parseInt(m1[2], 10);
    if (mi !== undefined && Number.isFinite(year)) return new Date(year, mi, 1);
  }
  const m2 = s.match(/^(\d{4})$/);
  if (m2) {
    const year = parseInt(m2[1], 10);
    if (Number.isFinite(year)) return new Date(year, 0, 1);
  }
  return null;
}

function buildTimeline(profile: LinkedInProfile): TimelineItem[] {
  const items: TimelineItem[] = profile.workHistory.map((w) => ({
    start: w.startDate || '',
    end: w.endDate || 'present',
    company: w.company,
    position: w.position,
    note: w.duration || undefined
  }));

  items.sort((a, b) => {
    const da = parseMonthYear(a.start)?.getTime() ?? 0;
    const db = parseMonthYear(b.start)?.getTime() ?? 0;
    return db - da;
  });

  return items;
}

function hasAny(text: string, kws: string[]) {
  const t = (text || '').toLowerCase();
  return kws.some((k) => t.includes(k));
}

function seniorityLevelFromProfile(p: LinkedInProfile): number {
  const combined = [
    p.title,
    ...p.workHistory.map((w) => `${w.position} ${w.company}`)
  ].join(' ').toLowerCase();

  if (
    hasAny(combined, [
      'cto', 'chief technology officer', 'ceo', 'coo', 'cso',
      'founder', 'co-founder', 'cofounder',
      'distinguished', 'fellow',
      'principal engineer', 'principal scientist',
      'member of technical staff', 'mts', 'staff engineer', 'staff scientist'
    ])
  ) return 2.5;

  if (hasAny(combined, ['vp', 'svp', 'evp', 'director', 'head of', 'lead', 'senior']))
    return 1.5;

  return 0;
}

export async function getProfileRating(
  profile: LinkedInProfile
): Promise<ProfileRating> {
  const hasLongSummary = profile.summary && profile.summary.length >= 80;
  const detailedExperiences = profile.workHistory.filter(
    (x) => (x.description || '').length > 80
  ).length;

  // Start with a neutral completeness heuristic
  const profileCompletenessRaw =
    (profile.name ? 15 : 10) +
    (profile.title ? 15 : 10) +
    (hasLongSummary ? 20 : 14) +
    (profile.workHistory.length > 0 ? 25 : 15) +
    (profile.education.length > 0 ? 10 : 8) +
    (profile.skills.length >= 5 ? 15 : profile.skills.length > 0 ? 12 : 10);

  const profileCompleteness = Math.min(profileCompletenessRaw, 100);

  // Experience quality starts neutral and gets boosts for details and seniority
  let experienceQuality = 6.5 + Math.min(detailedExperiences, 4) * 0.6; // up to +2.4
  const seniorBump = seniorityLevelFromProfile(profile);
  experienceQuality += seniorBump * 0.8; // up to ~+2
  experienceQuality = clamp(experienceQuality, 1, 10);

  // Education: if present, 7–9 range; else neutral 6
  const educationScore =
    profile.education.length > 0
      ? clamp(7 + (profile.education[0].degree ? 1 : 0), 6, 9)
      : 6;

  // Skills: neutral if unknown/empty
  const skillsRelevance =
    profile.skills.length === 0 ? 6 : clamp(profile.skills.length * 1.0, 6, 10);

  // Network: neutral 6 if connections look missing/zero
  let networkStrength = 6;
  if (Number.isFinite(profile.connections) && profile.connections > 0) {
    networkStrength =
      profile.connections >= 5000
        ? 10
        : profile.connections >= 1000
        ? 9
        : profile.connections >= 500
        ? 8
        : profile.connections >= 200
        ? 7
        : 6;
  }

  // Career progression: base on #roles + seniority
  let careerProgression =
    profile.workHistory.length >= 4 ? 8 : profile.workHistory.length >= 2 ? 7 : 6;
  careerProgression += seniorBump * 0.6;
  careerProgression = clamp(careerProgression, 1, 10);

  // Industry expertise: neutral + slight bump for more roles & seniority
  let industryExpertise =
    6 + Math.min(profile.workHistory.length, 5) * 0.4 + seniorBump * 0.5;
  industryExpertise = clamp(industryExpertise, 1, 10);

  // Rebalanced weights (less penalty for network; more for experience)
  const overallScore = Number(
    (
      (profileCompleteness / 10) * 0.15 +
      experienceQuality * 0.25 +
      educationScore * 0.10 +
      skillsRelevance * 0.15 +
      networkStrength * 0.10 +
      careerProgression * 0.15 +
      industryExpertise * 0.10
    ).toFixed(1)
  );

  return {
    profileCompleteness: Math.round((profileCompleteness / 10) * 10) / 10,
    experienceQuality,
    educationScore,
    skillsRelevance,
    networkStrength,
    careerProgression,
    industryExpertise,
    overallScore
  };
}

/**
 * Detailed grade with +/- bands for backward compatibility.
 */
function toDetailedGrade(score10: number): string {
  if (score10 >= 9.7) return 'A+';
  if (score10 >= 9.0) return 'A';
  if (score10 >= 8.7) return 'A-';
  if (score10 >= 8.3) return 'B+';
  if (score10 >= 7.7) return 'B';
  if (score10 >= 7.3) return 'B-';
  if (score10 >= 6.7) return 'C+';
  if (score10 >= 6.3) return 'C';
  if (score10 >= 6.0) return 'C-';
  if (score10 >= 5.3) return 'D+';
  if (score10 >= 5.0) return 'D';
  return 'F';
}

/**
 * Simple letter grade A–F (no +/-).
 */
function toLetterAF(score10: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score10 >= 9.0) return 'A';
  if (score10 >= 8.0) return 'B';
  if (score10 >= 7.0) return 'C';
  if (score10 >= 6.0) return 'D';
  return 'F';
}

/**
 * Clamp and round to an integer from 1 to 10 (“1 out of 10”).
 */
function toFinalScore10(score10: number): number {
  const r = Math.round(score10);
  if (r < 1) return 1;
  if (r > 10) return 10;
  return r;
}

export async function generateOverallRating(
  profile: LinkedInProfile,
  companies: CompanyRating[],
  experiences: ExperienceAnalysis[]
): Promise<OverallRating> {
  const profileRating = await getProfileRating(profile);

  // Company quality weighted by **tenure months** per experience (fallback 12 if parsing fails).
  let weightedSum = 0;
  let totalMonths = 0;
  for (const e of experiences) {
    const months = e.role?.tenureMonths && e.role.tenureMonths > 0 ? e.role.tenureMonths : Math.max(12, tenureMonthsFrom(e.experience));
    const compScore = e.company?.overallScore ?? 7;
    weightedSum += months * compScore;
    totalMonths += months;
  }
  const companyWeighted =
    totalMonths > 0
      ? Number((weightedSum / totalMonths).toFixed(1))
      : companies.length > 0
      ? Number(
          (
            companies.reduce((acc, c) => acc + c.overallScore, 0) / companies.length
          ).toFixed(1)
        )
      : 7;

  // Roles: average of (impact+scope+complexity)/3 across experiences (now neutral-baseline heuristics)
  const roleAvg =
    experiences.length > 0
      ? Number(
          (
            experiences.reduce((acc, e) => {
              const m = (e.role.impactScore + e.role.scopeScore + e.role.complexityScore) / 3;
              return acc + m;
            }, 0) / experiences.length
          ).toFixed(1)
        )
      : 6.5;

  // Prestige boost: bounded uplift for elite employers + senior roles
  const maxCompany = companies.reduce((m, c) => Math.max(m, c.overallScore ?? 0), 0);
  const eliteCount = companies.filter((c) => (c.overallScore ?? 0) >= 8.5).length;
  const hasSenior = seniorityLevelFromProfile(profile) >= 1.5;

  let prestigeBoost = 0;
  if (maxCompany >= 9) prestigeBoost += 0.4;               // one truly elite org
  if (eliteCount >= 2) prestigeBoost += 0.2;               // multiple strong brands
  if (hasSenior && eliteCount >= 1) prestigeBoost += 0.3;  // senior at elite org
  prestigeBoost = clamp(prestigeBoost, 0, 1.0);            // cap boost

  // Rebalanced blend: profile 40%, companies 35%, roles 25%
  let finalScore =
    profileRating.overallScore * 0.40 +
    companyWeighted * 0.35 +
    roleAvg * 0.25;

  finalScore = Number(clamp(finalScore + prestigeBoost, 1, 10).toFixed(1));

  // Derive requested outputs
  const finalScore10 = toFinalScore10(finalScore);  // 1..10 integer
  const finalGrade = toLetterAF(finalScore);        // A..F (no +/-)
  const detailedGrade = toDetailedGrade(finalScore);// "A+", "A", ..., "F"

  const analysis = await analyzeWithAI(
    `Analyze this profile and return JSON with summary, strengths[], weaknesses[], recommendations[], riskFactors[], marketValue:
${JSON.stringify(profile)}`
  );

  const timeline = buildTimeline(profile);

  return {
    score: finalScore,                 // precise 0–10 (one decimal)
    grade: detailedGrade,              // detailed grade with +/-
    finalGrade,                        // A–F (no +/-)
    finalScore10,                      // 1..10 integer
    summary:
      analysis.summary ||
      'Strong career signals with room for additional public artifacts and quantifiable outcomes.',
    strengths: analysis.strengths || ['Technical depth', 'Impactful roles', 'Reputable companies'],
    weaknesses: analysis.weaknesses || ['Limited public artifacts'],
    recommendations:
      analysis.recommendations || ['Add quantifiable outcomes to roles', 'Publish talks/posts'],
    riskFactors: analysis.riskFactors || ['Market competition'],
    marketValue: analysis.marketValue || 'High',
    careerSummary:
      analysis.summary ||
      'Career shows consistent progression and delivery across roles and organizations.',
    timeline
  };
}
