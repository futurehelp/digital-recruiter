import { Request, Response } from 'express';
import {
  analyzeLinkedInProfile,
  parseLinkedInProfile
} from '../services/linkedinScraper';
import {
  analyzeAllEmployers,
  analyzeCompany
} from '../services/companyService';
import {
  generateOverallRating,
  getProfileRating
} from '../services/analysisService';
import {
  TestAnalysisSchema,
  AnalyzeProfileSchema,
  BulkAnalyzeSchema,
  RateCompanySchema
} from '../schemas';
import { mockProfile } from '../mocks/mockProfile';
import { ExperienceAnalysis, LinkedInProfile } from '../types';
import { logger } from '../lib/logger';
import { validateLinkedInUrl } from '../utils/validators';
import { analyzeJobRole } from '../services/roleService';

export const health = (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
};

export const testAnalysis = async (req: Request, res: Response) => {
  const { linkedinUrl } = TestAnalysisSchema.parse(req.body);

  logger.info(
    { linkedinUrl },
    '🧪 Running test analysis (mock profile, all employers & roles)'
  );

  const profileData: LinkedInProfile = parseLinkedInProfile(mockProfile);

  // 1) All employers
  const employerAnalysis = await analyzeAllEmployers(profileData.workHistory);

  // 2) Every role with company context
  const byName = new Map(
    employerAnalysis.map((c) => [c.name.toLowerCase(), c])
  );

  const experienceAnalyses: ExperienceAnalysis[] = [];
  for (const ex of profileData.workHistory) {
    const company = byName.get((ex.company || '').toLowerCase());
    const role = await analyzeJobRole(ex, company);
    if (company) {
      experienceAnalyses.push({ experience: ex, company, role });
    }
  }

  // 3) Overall rating
  const overallRating = await generateOverallRating(
    profileData,
    employerAnalysis,
    experienceAnalyses
  );

  // 4) Profile component rating
  const profileRating = await getProfileRating(profileData);

  // 🔊 Log final overall rating for backend observability (Railway)
  logger.info(
    {
      url: linkedinUrl,
      score: overallRating.score,
      grade: overallRating.grade,
      finalGrade: overallRating.finalGrade,
      finalScore10: overallRating.finalScore10
    },
    `🎓 Overall Rating → ${overallRating.finalGrade} (${overallRating.finalScore10}/10)`
  );

  res.json({
    profileUrl: linkedinUrl,
    timestamp: new Date().toISOString(),
    testMode: true,
    profileData,
    employerAnalysis,
    experienceAnalyses,
    profileRating,
    overallRating,
    analysis: {
      strengths: overallRating.strengths,
      weaknesses: overallRating.weaknesses,
      recommendations: overallRating.recommendations
    }
  });
};

export const analyzeProfile = async (req: Request, res: Response) => {
  const { linkedinUrl } = AnalyzeProfileSchema.parse(req.body);

  if (!validateLinkedInUrl(linkedinUrl)) {
    res.status(400).json({ error: 'Invalid LinkedIn URL format' });
    return;
  }

  logger.info({ linkedinUrl }, '🚀 Starting full analysis (ALL employers & roles)');

  // 1) Scrape + parse profile
  const raw = await analyzeLinkedInProfile(linkedinUrl);
  const profileData = parseLinkedInProfile(raw);

  // 2) All employers
  const employerAnalysis = await analyzeAllEmployers(profileData.workHistory);

  // 3) Each role
  const byName = new Map(
    employerAnalysis.map((c) => [c.name.toLowerCase(), c])
  );
  const experienceAnalyses: ExperienceAnalysis[] = [];
  for (const ex of profileData.workHistory) {
    const company = byName.get((ex.company || '').toLowerCase());
    const role = await analyzeJobRole(ex, company);
    if (company) {
      experienceAnalyses.push({ experience: ex, company, role });
    }
  }

  // 4) Overall rating (profile + companies + roles)
  const overallRating = await generateOverallRating(
    profileData,
    employerAnalysis,
    experienceAnalyses
  );

  // 5) Profile component rating
  const profileRating = await getProfileRating(profileData);

  // 🔊 Log final overall rating for backend observability (Railway)
  logger.info(
    {
      url: linkedinUrl,
      score: overallRating.score,
      grade: overallRating.grade,
      finalGrade: overallRating.finalGrade,
      finalScore10: overallRating.finalScore10
    },
    `🎓 Overall Rating → ${overallRating.finalGrade} (${overallRating.finalScore10}/10)`
  );

  res.json({
    profileUrl: linkedinUrl,
    timestamp: new Date().toISOString(),
    profileData,
    employerAnalysis,
    experienceAnalyses,
    profileRating,
    overallRating,
    analysis: {
      strengths: overallRating.strengths,
      weaknesses: overallRating.weaknesses,
      recommendations: overallRating.recommendations
    }
  });
};

export const rateCompany = async (req: Request, res: Response) => {
  const { companyName, companyUrl } = RateCompanySchema.parse(req.body);

  const rating = await analyzeCompany(companyName, companyUrl);

  // Optional: log single-company rating
  logger.info(
    { company: companyName, overall: rating.overallScore },
    `🏢 Company Rating → ${rating.name}: ${rating.overallScore}/10`
  );

  res.json({
    company: companyName,
    timestamp: new Date().toISOString(),
    rating
  });
};

export const bulkAnalyze = async (req: Request, res: Response) => {
  const { linkedinUrls } = BulkAnalyzeSchema.parse(req.body);

  if (!Array.isArray(linkedinUrls) || linkedinUrls.length === 0) {
    res.status(400).json({ error: 'Array of LinkedIn URLs is required' });
    return;
  }
  if (linkedinUrls.length > 10) {
    res.status(400).json({ error: 'Maximum 10 profiles can be analyzed in bulk' });
    return;
  }

  const results: any[] = [];

  for (const url of linkedinUrls) {
    try {
      if (!validateLinkedInUrl(url)) {
        results.push({ url, error: 'Invalid LinkedIn URL format' });
        continue;
      }

      // Profile
      const raw = await analyzeLinkedInProfile(url);
      const profileData = parseLinkedInProfile(raw);

      // Companies
      const employerAnalysis = await analyzeAllEmployers(profileData.workHistory);

      // Roles
      const byName = new Map(
        employerAnalysis.map((c) => [c.name.toLowerCase(), c])
      );

      const experienceAnalyses: ExperienceAnalysis[] = [];
      for (const ex of profileData.workHistory) {
        const company = byName.get((ex.company || '').toLowerCase());
        const role = await analyzeJobRole(ex, company);
        if (company) {
          experienceAnalyses.push({ experience: ex, company, role });
        }
      }

      // Overall
      const overallRating = await generateOverallRating(
        profileData,
        employerAnalysis,
        experienceAnalyses
      );

      // 🔊 Log final overall rating per profile
      logger.info(
        {
          url,
          score: overallRating.score,
          grade: overallRating.grade,
          finalGrade: overallRating.finalGrade,
          finalScore10: overallRating.finalScore10
        },
        `🎓 Overall Rating for ${url} → ${overallRating.finalGrade} (${overallRating.finalScore10}/10)`
      );

      results.push({
        url,
        profileData,
        employerAnalysis,
        experienceAnalyses,
        overallRating: overallRating.score,
        summary: overallRating.summary
      });
    } catch (err) {
      logger.error({ url, err }, 'Bulk analyze failed for profile');
      results.push({
        url,
        error: err instanceof Error ? err.message : 'Analysis failed'
      });
    }
  }

  res.json({
    timestamp: new Date().toISOString(),
    totalProfiles: linkedinUrls.length,
    results
  });
};
