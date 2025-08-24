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
  score: number;
  grade: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  riskFactors: string[];
  marketValue: string;

  // Added for the "analyze every employer + role" requirement
  careerSummary: string;     // high-level narrative summary (often mirrors `summary` but tailored to career)
  timeline: TimelineItem[];  // computed timeline of roles
}
