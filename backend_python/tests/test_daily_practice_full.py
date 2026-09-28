import base64
import json
import unittest

from app.tools.daily_practice_full import QUESTIONS, run_daily_practice
from app.tools.common import ToolError


class DailyPracticeFullTests(unittest.TestCase):
    def assert_no_hidden_answer_keys(self, value):
        forbidden = {"answer", "accepted", "explanation", "correctAnswer"}
        if isinstance(value, dict):
            self.assertTrue(forbidden.isdisjoint(value.keys()))
            for child in value.values():
                self.assert_no_hidden_answer_keys(child)
        elif isinstance(value, list):
            for child in value:
                self.assert_no_hidden_answer_keys(child)

    def test_card_bank_parity_and_public_payload_do_not_leak_answers(self):
        result = run_daily_practice("run-all", {})
        self.assertEqual(len(QUESTIONS), 720)
        self.assertEqual(result["bank"]["questionCount"], 720)
        self.assertEqual(
            {row["category"]: row["total"] for row in result["stats"]["categories"]},
            {
                "python": 120,
                "algorithms": 120,
                "data": 120,
                "statistics": 120,
                "ai": 120,
                "scientific": 120,
            },
        )
        self.assert_no_hidden_answer_keys(result["questions"])
        self.assertEqual(
            {item["type"] for item in result["questions"]},
            {"single", "multiple", "boolean", "fill", "ordering", "case"},
        )
        self.assertEqual(result["stats"]["advancedQuestions"], 540)
        self.assertGreaterEqual(len(result["stats"]["skills"]), 60)

    def test_practice_only_reveals_answer_after_submission(self):
        baseline = run_daily_practice("load-sample", {})
        answered = run_daily_practice(
            "answer-practice",
            {"state": baseline["state"], "questionId": "py-list", "selected": 0},
        )
        self.assertTrue(answered["feedback"]["correct"])
        self.assertIn("correctAnswer", answered["feedback"])
        self.assertIn("feedback", answered["state"]["practiceSession"]["answers"]["py-list"])
        self.assertEqual(answered["stats"]["answered"], 1)
        self.assertEqual(answered["stats"]["accuracy"], 100)

    def test_exam_hides_answers_until_server_submission(self):
        baseline = run_daily_practice("load-sample", {})
        started = run_daily_practice(
            "start-exam",
            {"state": baseline["state"], "count": 10, "durationMinutes": 10},
        )
        self.assertEqual(len(started["exam"]["questions"]), 10)
        self.assert_no_hidden_answer_keys(started["exam"])
        first = started["exam"]["questions"][0]
        selected = "def" if first["type"] == "fill" else ([0] if first["type"] == "multiple" else 0)
        saved = run_daily_practice(
            "save-exam-answer",
            {"state": started["state"], "questionId": first["id"], "selected": selected},
        )
        self.assert_no_hidden_answer_keys(saved["exam"])
        submitted = run_daily_practice("submit-exam", {"state": saved["state"]})
        self.assertEqual(len(submitted["examResult"]["review"]), 10)
        self.assertIsNone(submitted["state"]["activeExam"])
        self.assertEqual(len(submitted["state"]["examHistory"]), 1)

    def test_exam_token_rejects_tampering(self):
        baseline = run_daily_practice("load-sample", {})
        started = run_daily_practice(
            "start-exam",
            {"state": baseline["state"], "count": 10, "durationMinutes": 10},
        )
        tampered = json.loads(json.dumps(started["state"]))
        token = tampered["activeExam"]["token"]
        body, signature = token.split(".", 1)
        decoded = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        decoded["endsAt"] += 3600
        changed_body = base64.urlsafe_b64encode(
            json.dumps(decoded, separators=(",", ":"), sort_keys=True).encode()
        ).decode().rstrip("=")
        tampered["activeExam"]["token"] = f"{changed_body}.{signature}"
        with self.assertRaises(ToolError) as raised:
            run_daily_practice("resume-exam", {"state": tampered})
        self.assertEqual(raised.exception.code, "EXAM_TOKEN_INVALID")

    def test_favorite_export_and_bank_validation(self):
        baseline = run_daily_practice("load-sample", {})
        favorited = run_daily_practice(
            "toggle-favorite",
            {"state": baseline["state"], "questionId": "py-list"},
        )
        self.assertTrue(favorited["favorite"]["active"])
        exported = run_daily_practice("export", {"state": favorited["state"]})
        self.assertIn("backupJson", exported["exports"])
        self.assertIn("skillCsv", exported["exports"])
        self.assertIn("qtiXml", exported["exports"])
        checked = run_daily_practice(
            "validate-bank",
            {
                "questions": [
                    {"id": "Q1", "type": "single", "category": "python", "difficulty": 1}
                ]
            },
        )
        self.assertTrue(checked["valid"])

    def test_adaptive_session_and_spaced_review_update(self):
        baseline = run_daily_practice("load-sample", {})
        wrong = run_daily_practice(
            "answer-practice",
            {
                "state": baseline["state"],
                "questionId": "advanced-python-01-01",
                "selected": 0,
                "source": "adaptive",
                "confidence": 5,
                "elapsedSeconds": 75,
            },
        )
        self.assertIn("async-cancellation", wrong["state"]["skillMastery"])
        self.assertEqual(
            wrong["state"]["reviewSchedule"]["advanced-python-01-01"]["intervalDays"],
            0,
        )
        session = run_daily_practice(
            "build-adaptive-session",
            {"state": wrong["state"], "mode": "weak", "count": 20},
        )
        self.assertEqual(len(session["adaptive"]["questions"]), 20)
        self.assertEqual(session["adaptive"]["session"]["modelVersion"], "elo-spaced-v1")
        self.assert_no_hidden_answer_keys(session["adaptive"]["questions"])

    def test_ordering_question_requires_full_sequence(self):
        baseline = run_daily_practice("load-sample", {})
        answered = run_daily_practice(
            "answer-practice",
            {
                "state": baseline["state"],
                "questionId": "advanced-python-04-01",
                "selected": [0, 1, 2, 3],
            },
        )
        self.assertTrue(answered["feedback"]["correct"])

    def test_balanced_exam_supports_large_blueprints(self):
        baseline = run_daily_practice("load-sample", {})
        started = run_daily_practice(
            "start-exam",
            {"state": baseline["state"], "count": 100, "durationMinutes": 120},
        )
        categories = {
            item["category"] for item in started["exam"]["questions"]
        }
        self.assertEqual(len(started["exam"]["questions"]), 100)
        self.assertEqual(categories, {"python", "algorithms", "data", "statistics", "ai", "scientific"})


if __name__ == "__main__":
    unittest.main()
