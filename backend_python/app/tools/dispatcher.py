from __future__ import annotations

from typing import Any, Callable

from app.config import settings
from app.tools import ai_assessment_full, ai_report_full, ambient_noise_full, daily_practice_full, data_gateway_full, data_lab_full, emergency_console_full, flac3d_slope_full, fusion_console_full, knowledge_system_full, mine_safety_radar_full, paper_writing_full, patent_disclosure_full, patent_transfer_full, professional, project_workspace_full, python_english_full, python_lab_full, remote_sensing_full, research, research_automation_full, research_radar_full, scientific_animation_full, seismic_physics_full, skill_evolution_full, teaching, uav_inspection_full, warning_platform_full
from app.tools.common import ToolError

ToolHandler = Callable[[str, dict[str, Any]], dict[str, Any]]

DEDICATED_ACTIONS: dict[str, list[str]] = {
    "seismic-physics": [
        "load-sample", "preprocess", "detect", "spectrum-workbench",
        "aic-pick", "physics", "validate", "run-all",
    ],
    "patent-transfer": [
        "load-sample", "analyze", "search-landscape", "novelty-matrix",
        "claim-workbench", "fto-assess", "transfer-assess",
        "deadline-check", "export", "run-all",
    ],
    "skill-evolution": [
        "load-sample", "validate-spec", "validate-contract", "validate-workflow",
        "run", "evaluate", "security-scan", "release-check", "publish",
        "import-package", "import-dataset", "export", "run-all",
    ],
    "knowledge-system": [
        "load-sample", "search", "ask", "ingest-file", "ingest-text",
        "update-chunk", "reindex-document", "delete-document", "evaluate",
        "concept-map", "export", "import-backup", "run-all",
    ],
    "research-radar": [
        "load-sample", "search", "search-live", "import-records", "dedupe",
        "update-library", "update-evidence", "run-monitor", "transfer",
        "export", "run-all",
    ],
    "mine-safety-radar": [
        "load-sample", "search", "search-live", "classify", "import-records",
        "dedupe", "update-library", "update-evidence", "run-monitor",
        "transfer", "export", "run-all",
    ],
    "research-automation": [
        "load-sample", "validate-workflow", "update-workflow", "apply-template",
        "select-workflow", "add-node", "update-node", "delete-node",
        "add-variable", "delete-variable", "run-preview", "retry-step",
        "approve", "cancel-run", "publish", "import-workflow", "export", "run-all",
    ],
    "python-lab": [
        "load-sample", "validate-workspace", "save-file", "create-file",
        "create-folder", "rename-path", "delete-path", "apply-template",
        "save-notebook", "record-cell-run", "update-run-config", "install-package", "record-run",
        "create-snapshot", "restore-snapshot", "import-workspace", "export",
        "run-all",
    ],
    "daily-practice": [
        "load-sample", "upgrade-bank", "answer-practice", "build-adaptive-session", "toggle-favorite", "start-exam",
        "save-exam-answer", "resume-exam", "submit-exam", "reset-progress",
        "validate-bank", "export", "run-all",
    ],
    "ai-assessment": [
        "load-sample", "select-context", "save-draft", "review-source", "refresh-runtime",
        "submit", "rejudge", "validate-bank", "import-problems",
        "delete-custom-problem", "export", "run-all",
    ],
    "flac3d-slope-stability": [
        "load-sample", "update-model", "validate-model", "screen-stability",
        "runtime-status", "solver-status", "prepare-run", "import-results",
        "execute-flac3d", "execute-open-source",
        "export", "run-all",
    ],
    "warning-platform": [
        "load-sample", "ingest-observations", "evaluate-rules",
        "acknowledge-alarm", "assign-alarm", "close-alarm", "suppress-alarm",
        "approve-rule", "publish-rule", "create-maintenance-window",
        "validate", "connector-status", "export", "run-all",
    ],
    "uav-inspection": [
        "load-sample", "update-flight-plan", "validate-flight-plan",
        "import-image-manifest", "prepare-photogrammetry", "run-defect-analysis",
        "review-detection", "update-annotation", "create-work-order",
        "update-work-order", "compare-missions", "runtime-status",
        "validate", "export", "run-all",
    ],
    "fusion-console": [
        "load-sample", "register-source", "govern-schema", "calibrate-source",
        "import-observations", "run-quality-checks", "align-observations",
        "build-features", "run-fusion", "review-fused-event",
        "publish-model-version", "replay-window", "runtime-status",
        "validate", "export", "run-all", "align",
    ],
    "emergency-console": [
        "load-sample", "create-incident", "update-incident", "import-reports",
        "verify-report", "create-task", "update-task", "assign-resource",
        "record-decision", "send-communication", "handover-shift",
        "publish-situation-report", "close-incident", "after-action-review",
        "runtime-status", "validate", "export", "run-all", "plan",
    ],
    "project-workspace": [
        "load-sample", "select-project", "create-project", "update-project",
        "archive-project", "restore-project", "create-task", "update-task",
        "move-task", "archive-task", "delete-task", "restore-task",
        "add-dependency", "add-comment", "add-attachment", "add-member",
        "update-member", "remove-member", "create-cycle", "update-cycle",
        "create-milestone", "update-milestone", "update-note",
        "create-snapshot", "restore-snapshot", "import-project",
        "runtime-status", "validate", "export", "run-all", "summary",
    ],
    "scientific-animation-studio": [
        "load-sample", "run-all", "select-scene", "create-scene",
        "update-scene", "select-object", "add-object", "update-object",
        "delete-object", "add-keyframe", "update-keyframe",
        "remove-keyframe", "reorder-layer", "update-camera", "seek",
        "create-snapshot", "import-project", "prepare-render",
        "record-render", "render-preview", "validate-scene",
        "create-storyboard", "runtime-status", "export",
    ],
    "data-lab": [
        "load-sample", "run-all", "update-project", "import-data",
        "apply-operation", "edit-cell", "undo", "redo", "jump-history",
        "set-view", "set-facet", "clear-facets", "set-sort",
        "replay-operations", "create-snapshot", "restore-snapshot",
        "import-project", "validate", "runtime-status", "export",
    ],
    "ai-report": [
        "draft", "audit", "load-sample", "run-all", "update-project", "update-config",
        "import-material", "import-text", "register-url", "toggle-material",
        "toggle-chunk", "delete-material", "set-active-material",
        "generate-extractive", "record-local-generation", "ask-extractive",
        "record-local-chat", "update-report", "audit-report",
        "create-version", "restore-version", "clear-chat", "import-project",
        "runtime-status", "validate", "export",
    ],
    "python-english": [
        "grade", "load-sample", "run-all", "select-set", "select-mode",
        "record-learn", "record-card", "record-quiz", "record-typing",
        "record-pronunciation", "start-exam", "save-exam-answer",
        "submit-exam", "mark-reference-read", "update-preferences",
        "import-vocabulary", "import-exam", "reset-progress",
        "runtime-status", "validate", "export",
    ],
}

ROUTES: dict[str, ToolHandler] = {
    "paper-writing": paper_writing_full.run_paper_writing,
    "disaster-remote-sensing": remote_sensing_full.run_remote_sensing,
    "seismic-physics": seismic_physics_full.run_seismic_physics,
    "patent-transfer": patent_transfer_full.run_patent_transfer,
    "skill-evolution": skill_evolution_full.run_skill_evolution,
    "research-automation": research_automation_full.run_research_automation,
    "knowledge-system": knowledge_system_full.run_knowledge_system,
    "research-radar": research_radar_full.run_research_radar,
    "mine-safety-radar": mine_safety_radar_full.run_mine_safety_radar,
    "flac3d-slope-stability": flac3d_slope_full.run_flac3d_slope,
    "data-gateway": data_gateway_full.run_data_gateway,
    "ambient-noise-imaging": ambient_noise_full.run_ambient_noise,
    "warning-platform": warning_platform_full.run_warning_platform,
    "uav-inspection": uav_inspection_full.run_uav_inspection,
    "fusion-console": fusion_console_full.run_fusion_console,
    "emergency-console": emergency_console_full.run_emergency_console,
    "python-lab": python_lab_full.run_python_lab,
    "daily-practice": daily_practice_full.run_daily_practice,
    "project-workspace": project_workspace_full.run_project_workspace,
    "scientific-animation-studio": scientific_animation_full.run_scientific_animation,
    "data-lab": data_lab_full.run_data_lab,
    "ai-report": ai_report_full.run_ai_report,
    "python-english": python_english_full.run_python_english,
    "ai-assessment": ai_assessment_full.run_ai_assessment,
    "project-submission": teaching.project_submission,
    "patent-disclosure": patent_disclosure_full.run_patent_disclosure,
}


def run_tool(slug: str, action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if slug not in {"disaster-remote-sensing", "patent-transfer"}:
        found, result = professional.run_extended(slug, action, payload)
        if found:
            return result
    handler = ROUTES.get(slug)
    if handler is None:
        raise ToolError("工作台不存在")
    if not action:
        raise ToolError("action 不能为空")
    return handler(action, payload)


def catalog() -> list[dict[str, Any]]:
    return [
        {
            "slug": slug,
            "engine": "python",
            "available": True,
            "productionReady": False,
            "maturity": "prototype",
            "codeExecutionAvailable": (
                settings.unsafe_local_code_execution_enabled
                if slug in {"python-lab", "ai-assessment"}
                else None
            ),
            "extendedActions": sorted(set(professional.extended_actions(slug) + DEDICATED_ACTIONS.get(slug, []))),
        }
        for slug in ROUTES
    ]
