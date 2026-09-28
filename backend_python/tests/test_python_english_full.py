from __future__ import annotations

import base64
import io
import json
import unittest
import zipfile

from app.tools.common import ToolError
from app.tools.python_english_full import run_python_english


class PythonEnglishFullTests(unittest.TestCase):
    def test_card_catalog_is_complete_and_answer_safe(self) -> None:
        result = run_python_english("load-sample", {})
        self.assertEqual(result["schema"], "skyview-python-english-results")
        self.assertEqual(len(result["catalog"]["vocabularySets"]), 8)
        self.assertEqual(sum(len(item["words"]) for item in result["catalog"]["vocabularySets"]), 64)
        self.assertEqual(len(result["catalog"]["exams"]), 4)
        self.assertEqual(sum(item["questionCount"] for item in result["catalog"]["exams"]), 32)
        self.assertEqual(len(result["catalog"]["references"]), 8)
        self.assertNotIn("questions", result["catalog"]["exams"][0])
        self.assertEqual(result["analysis"]["leaderboard"], [])

    def test_mastery_requires_three_distinct_evidence_types(self) -> None:
        state = run_python_english("load-sample", {})
        term_id = "control-flow-1"
        first = run_python_english("record-learn", {"state": state, "actorRole": "owner", "termId": term_id, "sessionKey": "one"})
        duplicate = run_python_english("record-learn", {"state": first, "actorRole": "owner", "termId": term_id, "sessionKey": "one"})
        self.assertEqual(first["analysis"]["metrics"]["xp"], duplicate["analysis"]["metrics"]["xp"])
        second = run_python_english("record-card", {"state": duplicate, "actorRole": "owner", "termId": term_id, "sessionKey": "two"})
        self.assertIsNone(second["project"]["progressByTerm"][term_id]["masteredAt"])
        third = run_python_english("record-quiz", {"state": second, "actorRole": "owner", "termId": term_id, "sessionKey": "three", "correct": True})
        self.assertIsNotNone(third["project"]["progressByTerm"][term_id]["masteredAt"])

    def test_pronunciation_is_explicit_self_assessment(self) -> None:
        state = run_python_english("load-sample", {})
        with self.assertRaises(ToolError):
            run_python_english("record-pronunciation", {"state": state, "actorRole": "owner", "termId": "fundamentals-7", "selfAssessment": "ai-score-98"})
        output = run_python_english("record-pronunciation", {"state": state, "actorRole": "owner", "termId": "fundamentals-7", "selfAssessment": "accurate", "sessionKey": "speech-1"})
        self.assertEqual(output["runtime"]["pronunciationScoring"]["status"], "not-configured")
        self.assertIn("speak-self", output["project"]["progressByTerm"]["fundamentals-7"]["evidence"])

    def test_exam_questions_are_shuffled_and_scored_server_side(self) -> None:
        state = run_python_english("load-sample", {})
        started = run_python_english("start-exam", {"state": state, "actorRole": "owner", "examId": "exam-core"})
        self.assertTrue(started["examToken"])
        questions = started["project"]["activeAttempt"]["questions"]
        self.assertEqual(len(questions), 8)
        self.assertTrue(all("correct" not in item and "explanation" not in item for item in questions))
        answers = {item["id"]: item["choices"][0]["id"] for item in questions}
        submitted = run_python_english("submit-exam", {"state": started, "actorRole": "owner", "examToken": started["examToken"], "answers": answers})
        attempt = submitted["project"]["attempts"][0]
        self.assertEqual(attempt["total"], 8)
        self.assertEqual(len(attempt["review"]), 8)
        self.assertTrue(all("correctChoiceId" in item for item in attempt["review"]))

    def test_tampered_exam_token_is_rejected(self) -> None:
        state = run_python_english("start-exam", {"state": run_python_english("load-sample", {}), "actorRole": "owner", "examId": "exam-core"})
        with self.assertRaises(ToolError):
            run_python_english("submit-exam", {"state": state, "actorRole": "owner", "examToken": state["examToken"][:-2] + "aa", "answers": {}})

    def test_imports_report_precise_errors_and_keep_exam_as_draft(self) -> None:
        state = run_python_english("load-sample", {})
        with self.assertRaisesRegex(ToolError, r"words\[1\]\.translation"):
            run_python_english("import-vocabulary", {"state": state, "actorRole": "owner", "content": {"name": "Bad", "words": [{"word": "loop"}]}})
        imported = run_python_english("import-exam", {"state": state, "actorRole": "owner", "content": "# Mini\n? Which one?\n- wrong\n- #right\n> Because."})
        draft = imported["project"]["customExamDrafts"][0]
        self.assertEqual(draft["status"], "teacher-draft")
        self.assertFalse(draft["publishable"])

    def test_leaderboard_requires_opt_in_and_never_invents_people(self) -> None:
        state = run_python_english("load-sample", {})
        opted = run_python_english("update-preferences", {"state": state, "actorRole": "owner", "preferences": {"leaderboardOptIn": True, "displayName": "学习者甲"}})
        self.assertEqual(len(opted["analysis"]["leaderboard"]), 1)
        self.assertEqual(opted["analysis"]["leaderboard"][0]["displayName"], "学习者甲")

    def test_complete_package_is_valid_zip(self) -> None:
        result = run_python_english("load-sample", {})
        data = base64.b64decode(result["exports"]["packageBase64"])
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = set(archive.namelist())
            self.assertIn("manifest.json", names)
            self.assertIn("progress/project.json", names)
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["catalogVersion"], "2026.09-card-parity-v1")

    def test_viewer_cannot_mutate(self) -> None:
        state = run_python_english("load-sample", {})
        with self.assertRaises(ToolError):
            run_python_english("record-learn", {"state": state, "actorRole": "viewer", "termId": "fundamentals-1"})


if __name__ == "__main__":
    unittest.main()
