import { LRUCache } from 'lru-cache';
import { analyzeWithAI } from './openaiClient';
import { CompanyRating, WorkExperience } from '../types';
import { logger } from '../lib/logger';

// lru-cache v10+: use named export { LRUCache }
const companyCache = new LRUCache<string, CompanyRating>({
  max: 200,
  ttl: 1000 * 60 * 60 * 24 // 24 hours
});

export async function analyzeCompany(
  companyName: string,
  companyUrl?: string
): Promise<CompanyRating> {
  const key = `${companyName}:${companyUrl ?? ''}`;
  const cached = companyCache.get(key);
  if (cached) return cached;

  const ai = await analyzeWithAI(
    `Analyze company "${companyName}"${
      companyUrl ? ` (${companyUrl})` : ''
    } and return JSON:
{
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
 "growthRate": number | null
}`
  );

  const result: CompanyRating = {
    name: companyName,
    industry: ai.industry || 'Technology',
    size: ai.size || '100-1000 employees',
    reputation: Number(ai.reputation ?? 7),
    stabilityScore: Number(ai.stabilityScore ?? 7),
    innovationScore: Number(ai.innovationScore ?? 7),
    overallScore: Number(ai.overallScore ?? 7),
    glassdoorRating: ai.glassdoorRating ?? undefined,
    linkedinFollowers: ai.linkedinFollowers ?? undefined,
    foundedYear: ai.foundedYear ?? undefined,
    revenueRange: ai.revenueRange ?? undefined,
    growthRate: ai.growthRate ?? undefined
  };

  companyCache.set(key, result);
  logger.debug({ company: result }, 'Company analyzed');
  return result;
}

/**
 * Analyze ALL employers in the candidate's work history (no depth limit).
 */
export async function analyzeAllEmployers(
  workHistory: WorkExperience[]
): Promise<CompanyRating[]> {
  const names = [...new Set(workHistory.map((w) => (w.company || '').trim()))].filter(
    (n) => !!n
  );

  const ratings: CompanyRating[] = [];
  for (const name of names) {
    try {
      ratings.push(await analyzeCompany(name));
    } catch (err) {
      logger.warn({ company: name, err }, 'Company analysis failed; using fallback');
      ratings.push({
        name,
        industry: 'Unknown',
        size: 'Unknown',
        reputation: 6,
        stabilityScore: 6,
        innovationScore: 6,
        overallScore: 6
      });
    }
  }
  return ratings;
}
