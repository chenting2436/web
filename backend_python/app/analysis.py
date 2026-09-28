from __future__ import annotations

import re
from collections import Counter

from app.schemas import TermCount, TextAnalysisResult

ENGLISH_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_+-]{1,}")
CHINESE_SEQUENCE = re.compile(r"[\u4e00-\u9fff]{2,}")
CHINESE_CHARACTER = re.compile(r"[\u4e00-\u9fff]")

STOP_TERMS = {
    "一个",
    "以及",
    "使用",
    "可以",
    "进行",
    "这个",
    "这些",
    "我们",
    "通过",
    "支持",
    "the",
    "and",
    "for",
    "with",
    "from",
}


def _terms(text: str) -> list[str]:
    terms = [token.lower() for token in ENGLISH_TOKEN.findall(text)]
    for sequence in CHINESE_SEQUENCE.findall(text):
        if len(sequence) <= 6:
            terms.append(sequence)
            continue
        terms.extend(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return [term for term in terms if term not in STOP_TERMS]


def analyze_text(text: str, limit: int = 8) -> TextAnalysisResult:
    normalized = text.strip()
    counts = Counter(_terms(normalized))
    top_terms = [
        TermCount(term=term, count=count)
        for term, count in counts.most_common(limit)
    ]

    return TextAnalysisResult(
        charCount=len(normalized),
        nonWhitespaceCount=sum(not char.isspace() for char in normalized),
        lineCount=normalized.count("\n") + 1,
        englishWordCount=len(ENGLISH_TOKEN.findall(normalized)),
        chineseCharacterCount=len(CHINESE_CHARACTER.findall(normalized)),
        topTerms=top_terms,
    )

