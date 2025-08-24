import { z } from 'zod';

export const AnalyzeProfileSchema = z.object({
  linkedinUrl: z.string().url()
  // Depth removed: we now analyze ALL employers by design
});

export const RateCompanySchema = z.object({
  companyName: z.string().min(1),
  companyUrl: z.string().url().optional()
});

export const BulkAnalyzeSchema = z.object({
  linkedinUrls: z.array(z.string().url()).min(1).max(10)
  // Depth removed here as well
});

export const TestAnalysisSchema = z.object({
  linkedinUrl: z.string().url().default('https://www.linkedin.com/in/test-user')
});
