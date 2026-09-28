import { apiRequest } from '@/services/api/client';
import type { TextAnalysisResult } from '@/types/api';

export const analysisApi = {
  analyzeText(text: string, limit = 8) {
    return apiRequest<TextAnalysisResult>('/analysis/text', {
      method: 'POST',
      body: JSON.stringify({ text, limit }),
    });
  },
};
