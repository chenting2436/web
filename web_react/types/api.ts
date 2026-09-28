export type ApiEnvelope<T> = {
  data: T;
  message?: string;
  requestId?: string;
};

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  message?: string;
  requestId?: string;
};

export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type UserRole = 'student' | 'teacher' | 'admin';

export type User = {
  id: string;
  displayName: string;
  email: string;
  role: UserRole;
};

export type LoginPayload = {
  account: string;
  password: string;
};

export type AuthSession = {
  user: User;
  expiresAt: string;
};

export type TextAnalysisResult = {
  charCount: number;
  nonWhitespaceCount: number;
  lineCount: number;
  englishWordCount: number;
  chineseCharacterCount: number;
  topTerms: Array<{ term: string; count: number }>;
};
