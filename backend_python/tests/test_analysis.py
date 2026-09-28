import unittest

from app.analysis import analyze_text


class AnalyzeTextTests(unittest.TestCase):
    def test_counts_text_and_limits_terms(self):
        result = analyze_text("地球科学数据分析\nPython data data", limit=3)

        self.assertEqual(result.lineCount, 2)
        self.assertEqual(result.englishWordCount, 3)
        self.assertGreater(result.chineseCharacterCount, 0)
        self.assertLessEqual(len(result.topTerms), 3)
        self.assertEqual(result.topTerms[0].term, "data")
        self.assertEqual(result.topTerms[0].count, 2)


if __name__ == "__main__":
    unittest.main()

