import { Router } from 'express';
import { validateBody } from './middleware/validateBody';
import {
  AnalyzeProfileSchema,
  BulkAnalyzeSchema,
  RateCompanySchema,
  TestAnalysisSchema
} from './schemas';
import * as controller from './controllers/analysisController';

export const router = Router();

// Health
router.get('/health', controller.health);

// Test analysis (mock data)
router.post(
  '/api/test-analysis',
  validateBody(TestAnalysisSchema),
  controller.testAnalysis
);

// Analyze LinkedIn profile
router.post(
  '/api/analyze-profile',
  validateBody(AnalyzeProfileSchema),
  controller.analyzeProfile
);

// Rate company
router.post(
  '/api/rate-company',
  validateBody(RateCompanySchema),
  controller.rateCompany
);

// Bulk analyze
router.post(
  '/api/bulk-analyze',
  validateBody(BulkAnalyzeSchema),
  controller.bulkAnalyze
);

export default router;
