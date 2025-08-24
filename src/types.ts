export interface WorkExperience {
  company: string;
  position: string;
  duration: string;
  startDate: string;
  endDate?: string;
  description: string;
  location?: string;
}

export interface Education {
  institution: string;
  degree: string;
  field: string;
  startYear?: string;
  endYear?: string;
}

export interface LinkedInProfile {
  name: string;
  title: string;
  location: string;
  summary: string;
  workHistory: WorkExperience[];
  education: Education[];
  skills: string[];
  connections: number;
  profileStrength: number;
}

export interface CompanyRating {
  name: string;
  industry: string;
  size: string;
  reputation: number;
  glassdoorRating?: number;
  linkedinFollowers?: number;
  foundedYear?: number;
  revenueRange?: string;
  growthRate?: number;
  stabilityScore: number;
  innovationScore: number;
  overallScore: number;
}

export interface ProfileRating {
  profileCompleteness: number;
  experienceQuality: number;
  educationScore: number;
  skillsRelevance: number;
  networkStrength: number;
  careerProgression: number;
  industryExpertise: number;
  overallScore: number;
}

export interface RoleAnalysis {
  impactScore: number;      // 1–10
  scopeScore: number;       // 1–10
  complexityScore: number;  // 1–10
  tenureMonths: number;
  highlights: string[];
  risks: string[];
  fitSignals: string[];
  summary: string;
  confidence?: number;
}

export interface ExperienceAnalysis {
  experience: WorkExperience;
  company: CompanyRating;
  role: RoleAnalysis;
}

export interface TimelineItem {
  start: string;   // e.g., "Jan 2022"
  end: string;     // e.g., "present"
  company: string;
  position: string;
  note?: string;
}

export interface OverallRating {
  /**
   * Precise blended score on a 0–10 scale (one decimal).
   */
  score: number;

  /**
   * Detailed grade (with +/- granularity). Kept for backward compatibility.
   * Example: "A+", "A", "A-", "B+", ..., "F"
   */
  grade: string;

  /**
   * NEW: Simple letter grade on A–F scale (no +/-), as requested.
   * Mapping uses typical breakpoints: A ≥ 9.0, B ≥ 8.0, C ≥ 7.0, D ≥ 6.0, else F.
   */
  finalGrade: 'A' | 'B' | 'C' | 'D' | 'F';

  /**
   * NEW: Rounded integer score from 1 to 10 (i.e., “1 out of 10”).
   * We clamp to [1,10] so extremely low blended scores still report at least 1.
   */
  finalScore10: number;

  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  riskFactors: string[];
  marketValue: string;

  // High-level career narrative + chronological roles
  careerSummary: string;
  timeline: TimelineItem[];
}
