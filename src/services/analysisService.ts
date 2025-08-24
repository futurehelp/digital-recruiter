import {
  LinkedInProfile,
  OverallRating,
  ProfileRating,
  CompanyRating,
  ExperienceAnalysis,
  TimelineItem
} from '../types';
import { analyzeWithAI } from './openaiClient';

export async function getProfileRating(
  profile: LinkedInProfile
): Promise<ProfileRating> {
  const hasLongSummary = profile.summary && profile.summary.length >= 80;
  const detailedExperiences = profile.workHistory.filter(
    (x) => (x.description || '').length > 80
  ).length;

  const profileCompleteness = Math.min(
    (profile.name ? 15 : 0) +
      (profile.title ? 15 : 0) +
      (hasLongSummary ? 20 : 10) +
      (profile.workHistory.length > 0 ? 25 : 0) +
      (profile.education.length > 0 ? 10 : 0) +
      (profile.skills.length >= 5 ? 15 : 8),
    100
  );

  const experienceQuality = Math.min(
    profile.workHistory.length * 1.8 + Math.min(detailedExperiences, 4),
    10
  );

  const educationScore =
    profile.education.length > 0
      ? Math.min(7 + (profile.education[0].degree ? 1 : 0), 10)
      : 5;

  const skillsRelevance = Math.min(profile.skills.length * 1.2, 10);

  const networkStrength =
    profile.connections >= 1000 ? 9 : profile.connections >= 500 ? 8 : 4;

  const careerProgression =
    profile.workHistory.length >= 3 ? 8 : profile.workHistory.length >= 2 ? 7 : 5;

  const industryExpertise = Math.min(
    Math.ceil(profile.skills.length / 3) + (profile.workHistory.length >= 3 ? 3 : 0),
    10
  );

  const overallScore = Number(
    (
      (profileCompleteness / 10) * 0.2 +
      experienceQuality * 0.2 +
      educationScore * 0.1 +
      skillsRelevance * 0.2 +
      networkStrength * 0.15 +
      careerProgression * 0.1 +
      industryExpertise * 0.05
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

function buildTimeline(
  profile: LinkedInProfile
): TimelineItem[] {
  const items: TimelineItem[] = profile.workHistory.map((w) => ({
    start: w.startDate || '',
    end: w.endDate || 'present',
    company: w.company,
    position: w.position,
    note: w.duration || undefined
  }));

  // Sort by start date DESC (most recent first), fallback keep order
  items.sort((a, b) => {
    const da = parseMonthYear(a.start)?.getTime() ?? 0;
    const db = parseMonthYear(b.start)?.getTime() ?? 0;
    return db - da;
  });

  return items;
}

export async function generateOverallRating(
  profile: LinkedInProfile,
  companies: CompanyRating[],
  experiences: ExperienceAnalysis[]
): Promise<OverallRating> {
  const profileRating = await getProfileRating(profile);

  const avgCompanyScore =
    companies.length > 0
      ? companies.reduce((acc, c) => acc + c.overallScore, 0) / companies.length
      : 7;

  const roleAvg =
    experiences.length > 0
      ? experiences.reduce((acc, e) => {
          const m = (e.role.impactScore + e.role.scopeScore + e.role.complexityScore) / 3;
          return acc + m;
        }, 0) / experiences.length
      : 6.5;

  // Blend: profile 50%, companies 25%, roles 25%
  const finalScore = Number(
    (profileRating.overallScore * 0.5 + avgCompanyScore * 0.25 + roleAvg * 0.25).toFixed(1)
  );

  const analysis = await analyzeWithAI(
    `Analyze this profile and return JSON with summary, strengths[], weaknesses[], recommendations[], riskFactors[], marketValue:
${JSON.stringify(profile)}`
  );

  const grade =
    finalScore >= 9 ? 'A+' : finalScore >= 8 ? 'A' : finalScore >= 7 ? 'B' : finalScore >= 6 ? 'C' : 'D';

  const timeline = buildTimeline(profile);

  return {
    score: finalScore,
    grade,
    summary:
      analysis.summary ||
      'Solid professional profile with room for growth in leadership visibility.',
    strengths: analysis.strengths || ['Technical skills', 'Production impact'],
    weaknesses: analysis.weaknesses || ['Network depth'],
    recommendations:
      analysis.recommendations || ['Publish case studies', 'Expand network'],
    riskFactors: analysis.riskFactors || ['Market competition'],
    marketValue: analysis.marketValue || 'Mid Level',
    careerSummary:
      analysis.summary ||
      'Career shows consistent progression and meaningful delivery across roles.',
    timeline
  };
}
