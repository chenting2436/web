from typing import Any

from pydantic import BaseModel, Field


class TextAnalysisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=50_000)
    limit: int = Field(default=8, ge=1, le=20)


class TermCount(BaseModel):
    term: str
    count: int


class TextAnalysisResult(BaseModel):
    charCount: int
    nonWhitespaceCount: int
    lineCount: int
    englishWordCount: int
    chineseCharacterCount: int
    topTerms: list[TermCount]


class ToolRunRequest(BaseModel):
    action: str = Field(min_length=1, max_length=80)
    payload: dict[str, Any] = Field(default_factory=dict)
