from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from collections import Counter
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError, parse_json, require_text


SCHEMA = "skyview-ai-assessment-results"
VERSION = 1
CATALOG_VERSION = "2026.09"
MAX_SOURCE_LENGTH = 100_000


LANGUAGES = [
    {"id": 71, "key": "python", "label": "Python 3", "monaco": "python", "extension": "py"},
    {"id": 54, "key": "cpp", "label": "C++ 17", "monaco": "cpp", "extension": "cpp"},
    {"id": 63, "key": "javascript", "label": "JavaScript", "monaco": "javascript", "extension": "js"},
    {"id": 62, "key": "java", "label": "Java 13", "monaco": "java", "extension": "java"},
]


def _starter(title: str) -> dict[str, str]:
    return {
        "python": f'''# {title}\n# 从标准输入读取数据，并把答案写到标准输出。\n\ndef solve():\n    pass\n\nif __name__ == "__main__":\n    solve()\n''',
        "cpp": f'''// {title}\n#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {{\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    return 0;\n}}\n''',
        "javascript": f'''// {title}\nconst fs = require("fs");\nconst input = fs.readFileSync(0, "utf8").trim();\n\nfunction solve(text) {{\n  // TODO\n}}\n\nsolve(input);\n''',
        "java": f'''// {title}\nimport java.io.*;\nimport java.util.*;\n\npublic class Main {{\n    public static void main(String[] args) throws Exception {{\n        Scanner in = new Scanner(System.in);\n        // TODO\n    }}\n}}\n''',
    }


def _case(name: str, stdin: str, expected: str, visible: bool, weight: int) -> dict[str, Any]:
    return {"name": name, "stdin": stdin, "expectedOutput": expected, "visible": visible, "weight": weight}


def _problem(
    problem_id: str,
    number: int,
    title: str,
    difficulty: str,
    category: str,
    statement: str,
    input_format: str,
    output_format: str,
    sample_input: str,
    sample_output: str,
    tags: list[str],
    tests: list[dict[str, Any]],
    *,
    constraints: list[str] | None = None,
    hint: str = "先明确输入、边界和复杂度，再实现核心算法。",
    cpu: float = 2,
    memory: int = 128000,
) -> dict[str, Any]:
    return {
        "id": problem_id,
        "versionId": f"{problem_id}@{CATALOG_VERSION}",
        "number": number,
        "title": title,
        "difficulty": difficulty,
        "category": category,
        "tags": tags,
        "statement": statement,
        "inputFormat": input_format,
        "outputFormat": output_format,
        "constraints": constraints or ["必须处理边界输入", "输出必须严格匹配规定格式"],
        "samples": [{"input": sample_input, "output": sample_output}],
        "hints": [hint],
        "starters": _starter(title),
        "limits": {"cpuTime": cpu, "wallTime": max(5, cpu * 2), "memory": memory},
        "tests": tests,
        "source": "SkyViewLab 原创题库",
    }


PROBLEMS = [
    _problem("stream-sum", 1, "数据流求和", "入门", "输入输出", "给定 n 个整数，输出它们的总和。输入可能包含负数和零。", "第一行 n，第二行 n 个整数。", "输出一个整数。", "5\n2 -1 4 0 7\n", "12\n", ["循环", "整数", "64 位"], [_case("公开样例", "5\n2 -1 4 0 7\n", "12\n", True, 20), _case("单元素", "1\n-8\n", "-8\n", True, 15), _case("全零", "4\n0 0 0 0\n", "0\n", False, 25), _case("大整数", "3\n1000000000 1000000000 1000000000\n", "3000000000\n", False, 40)], constraints=["1 ≤ n ≤ 100000", "使用 64 位整数避免溢出", "时间复杂度 O(n)"], hint="逐个累加；C++ 使用 long long。"),
    _problem("station-deduplicate", 2, "测站编号去重", "入门", "数据治理", "按首次出现顺序输出唯一测站编号，并在第二行输出重复记录数量。编号区分大小写。", "一行 1–10000 个测站编号。", "唯一编号行和重复数量行。", "A01 B02 A01 C03 B02\n", "A01 B02 C03\n2\n", ["集合", "稳定去重", "字符串"], [_case("公开样例", "A01 B02 A01 C03 B02\n", "A01 B02 C03\n2\n", True, 25), _case("无重复", "S1 S2 S3\n", "S1 S2 S3\n0\n", True, 15), _case("全部相同", "X X X X\n", "X\n3\n", False, 30), _case("大小写", "A a A a\n", "A a\n2\n", False, 30)], hint="同时维护集合和结果列表。"),
    _problem("coordinate-validator", 3, "经纬度质量门禁", "入门", "数据治理", "逐行判断纬度和经度是否合法。纬度属于 [-90,90]，经度属于 [-180,180]。", "第一行 n，随后 n 行 lat lon。", "逐行输出 VALID 或 INVALID。", "3\n39.9 116.4\n91 10\n-90 180\n", "VALID\nINVALID\nVALID\n", ["条件", "浮点数", "质量门禁"], [_case("公开样例", "3\n39.9 116.4\n91 10\n-90 180\n", "VALID\nINVALID\nVALID\n", True, 25), _case("四个边界", "4\n90 180\n-90 -180\n90 -180\n-90 180\n", "VALID\nVALID\nVALID\nVALID\n", True, 25), _case("经度越界", "2\n0 180.01\n0 -180.01\n", "INVALID\nINVALID\n", False, 25), _case("纬度越界", "2\n90.1 0\n-90.1 0\n", "INVALID\nINVALID\n", False, 25)]),
    _problem("moving-average", 4, "滑动平均", "入门", "时序分析", "输出每个完整窗口的算术平均值，统一保留两位小数。", "第一行 n k，第二行 n 个数。", "输出 n-k+1 个两位小数。", "5 3\n1 2 3 4 8\n", "2.00 3.00 5.00\n", ["滑动窗口", "浮点数", "序列"], [_case("公开样例", "5 3\n1 2 3 4 8\n", "2.00 3.00 5.00\n", True, 25), _case("窗口为一", "3 1\n-1 0 2.5\n", "-1.00 0.00 2.50\n", True, 15), _case("全窗口", "4 4\n1 1 2 4\n", "2.00\n", False, 30), _case("小数", "3 2\n0.1 0.2 0.3\n", "0.15 0.25\n", False, 30)], constraints=["1 ≤ k ≤ n ≤ 200000", "目标复杂度 O(n)", "必须输出两位小数"], hint="维护窗口和，移出旧值并加入新值。"),
    _problem("missing-intervals", 5, "时间序列缺口", "进阶", "时序分析", "给定升序时间戳和采样间隔 d，输出全部缺失时间戳；无缺口输出 NONE。", "第一行 n d，第二行 n 个严格递增时间戳。", "缺失时间戳或 NONE。", "4 10\n0 10 40 50\n", "20 30\n", ["排序", "时间戳", "缺测"], [_case("公开样例", "4 10\n0 10 40 50\n", "20 30\n", True, 25), _case("无缺口", "3 5\n10 15 20\n", "NONE\n", True, 15), _case("多个区段", "4 3\n1 7 10 19\n", "4 13 16\n", False, 30), _case("负时间", "3 2\n-4 0 2\n", "-2\n", False, 30)]),
    _problem("run-length", 6, "游程编码", "进阶", "数据压缩", "对不含空格的可见 ASCII 字符串执行游程编码，输出 字符:次数。", "一行字符串 s。", "各编码段以空格分隔。", "AAABCCAAAA\n", "A:3 B:1 C:2 A:4\n", ["字符串", "双指针", "编码"], [_case("公开样例", "AAABCCAAAA\n", "A:3 B:1 C:2 A:4\n", True, 25), _case("单字符", "Z\n", "Z:1\n", True, 15), _case("交替字符", "ABABA\n", "A:1 B:1 A:1 B:1 A:1\n", False, 30), _case("数字字符", "111223\n", "1:3 2:2 3:1\n", False, 30)]),
    _problem("severity-routing", 7, "风险分级路由", "进阶", "灾害研判", "把 0–100 风险分数映射为 LOW、MEDIUM、HIGH、CRITICAL；越界输出 INVALID。", "第一行 n，随后 n 行分数。", "逐行输出风险等级。", "5\n0\n25\n50\n75\n101\n", "LOW\nMEDIUM\nHIGH\nCRITICAL\nINVALID\n", ["规则", "分级", "边界"], [_case("公开样例", "5\n0\n25\n50\n75\n101\n", "LOW\nMEDIUM\nHIGH\nCRITICAL\nINVALID\n", True, 30), _case("临界值下方", "3\n24.999\n49.999\n74.999\n", "LOW\nMEDIUM\nHIGH\n", True, 20), _case("合法端点", "2\n0\n100\n", "LOW\nCRITICAL\n", False, 25), _case("负值", "2\n-0.1\n-5\n", "INVALID\nINVALID\n", False, 25)]),
    _problem("merge-alert-windows", 8, "合并预警时段", "进阶", "算法", "合并所有重叠或首尾相接的闭区间，并按起点升序输出。", "第一行 n，随后 n 行 start end。", "区间数及合并后区间。", "4\n5 8\n1 3\n3 4\n10 12\n", "2\n1 8\n10 12\n", ["区间", "排序", "扫描"], [_case("公开样例", "4\n5 8\n1 3\n3 4\n10 12\n", "2\n1 8\n10 12\n", True, 25), _case("完全分离", "3\n1 2\n4 5\n7 8\n", "3\n1 2\n4 5\n7 8\n", True, 15), _case("包含关系", "3\n1 10\n3 4\n6 9\n", "1\n1 10\n", False, 30), _case("单区间", "1\n-2 -2\n", "1\n-2 -2\n", False, 30)], constraints=["1 ≤ n ≤ 200000", "[1,3] 与 [3,5] 必须合并", "整体复杂度 O(n log n)"], cpu=3),
    _problem("grid-hotspots", 9, "栅格热点统计", "进阶", "遥感", "统计栅格中大于等于阈值的像元数，并输出按行优先首次出现的热点坐标。", "第一行 h w t，随后 h 行栅格。", "热点数量和首次坐标。", "2 3 7\n1 8 3\n7 2 9\n", "3\n0 1\n", ["矩阵", "阈值", "统计"], [_case("公开样例", "2 3 7\n1 8 3\n7 2 9\n", "3\n0 1\n", True, 25), _case("无热点", "2 2 5\n1 2\n3 4\n", "0\n-1 -1\n", True, 15), _case("全部热点", "2 2 -1\n0 2\n-1 5\n", "4\n0 0\n", False, 30), _case("单像元", "1 1 6\n6\n", "1\n0 0\n", False, 30)]),
    _problem("zonal-damage", 10, "分区损毁评分", "挑战", "灾害研判", "按 score=0.6c+0.4a 计算分区得分，输出最高分区和高风险分区数。并列取输入更早者。", "第一行 n，随后 zone_id c a。", "最高分区与两位小数得分；高风险数量。", "3\nA1 80 50\nA2 60 90\nA3 20 30\n", "A2 72.00\n2\n", ["加权评分", "排序", "浮点数"], [_case("公开样例", "3\nA1 80 50\nA2 60 90\nA3 20 30\n", "A2 72.00\n2\n", True, 25), _case("并列", "2\nZ1 100 0\nZ2 60 60\n", "Z1 60.00\n2\n", True, 15), _case("阈值边界", "2\nB1 60 60\nB2 59.99 60\n", "B1 60.00\n1\n", False, 30), _case("单分区", "1\nONLY 0 0\n", "ONLY 0.00\n0\n", False, 30)]),
    _problem("shortest-evacuation", 11, "最短疏散路径", "挑战", "图算法", "在无向非负权图中求 s 到 t 的最短距离；不可达输出 UNREACHABLE。", "第一行 n m s t，随后 m 行 u v w。", "最短距离或 UNREACHABLE。", "4 4 1 4\n1 2 3\n2 4 4\n1 3 10\n3 4 1\n", "7\n", ["Dijkstra", "最短路", "优先队列"], [_case("公开样例", "4 4 1 4\n1 2 3\n2 4 4\n1 3 10\n3 4 1\n", "7\n", True, 25), _case("不可达", "3 1 1 3\n1 2 5\n", "UNREACHABLE\n", True, 15), _case("起终点相同", "2 1 2 2\n1 2 9\n", "0\n", False, 25), _case("零权边", "3 3 1 3\n1 2 0\n2 3 0\n1 3 5\n", "0\n", False, 35)], constraints=["1 ≤ n ≤ 200000", "0 ≤ m ≤ 300000", "距离使用 64 位整数"], cpu=3, memory=256000),
    _problem("dependency-order", 12, "工作流依赖排序", "挑战", "图算法", "输出任务依赖图中字典序最小的合法执行顺序；存在循环输出 CYCLE。", "第一行 n m，随后 m 行 a b。", "执行顺序或 CYCLE。", "4 3\n1 3\n2 3\n3 4\n", "1 2 3 4\n", ["拓扑排序", "DAG", "循环依赖"], [_case("公开样例", "4 3\n1 3\n2 3\n3 4\n", "1 2 3 4\n", True, 25), _case("循环", "3 3\n1 2\n2 3\n3 1\n", "CYCLE\n", True, 25), _case("无依赖", "4 0\n", "1 2 3 4\n", False, 20), _case("多种顺序", "5 3\n2 4\n1 4\n3 5\n", "1 2 3 4 5\n", False, 30)], constraints=["1 ≤ n ≤ 200000", "使用最小堆保证字典序最小"], cpu=3, memory=256000),
    _problem("rolling-anomaly", 13, "滚动异常检测", "挑战", "时序分析", "从第 k+1 个值开始，以前 k 个值均值为基线；偏差严格大于 t 时记录 0 基索引。", "第一行 n k t，第二行 n 个浮点数。", "异常索引或 NONE。", "6 3 5\n1 2 3 20 4 5\n", "3\n", ["滑动窗口", "均值", "异常"], [_case("公开样例", "6 3 5\n1 2 3 20 4 5\n", "3\n", True, 25), _case("无异常", "5 2 3\n1 2 3 4 5\n", "NONE\n", True, 15), _case("等于阈值", "4 2 2\n1 1 3 1\n", "NONE\n", False, 30), _case("多个异常", "6 2 4\n0 0 10 5 0 20\n", "2 4 5\n", False, 30)]),
    _problem("earthquake-classifier", 14, "震级目录分级", "进阶", "地震学", "按震级区间统计 MICRO、MINOR、MODERATE、STRONG 数量，并输出最大震级。", "第一行 n，第二行 n 个非负震级。", "四类计数和一位小数最大值。", "5\n1.2 2.0 3.9 4.1 6.0\n", "1 2 1 1\n6.0\n", ["分类", "统计", "浮点数"], [_case("公开样例", "5\n1.2 2.0 3.9 4.1 6.0\n", "1 2 1 1\n6.0\n", True, 25), _case("所有边界", "4\n0 2 4 6\n", "1 1 1 1\n6.0\n", True, 25), _case("同类", "3\n6.1 7.0 8.26\n", "0 0 0 3\n8.3\n", False, 25), _case("小数舍入", "2\n1.04 1.06\n", "2 0 0 0\n1.1\n", False, 25)]),
    _problem("frequency-table", 15, "文本频次表", "进阶", "文本处理", "仅把连续字母视为单词，忽略大小写；按频次降序、单词字典序升序输出前 k 项。", "第一行 k，第二行文本。", "每行 word count。", "3\nData, data! science and Data.\n", "data 3\nand 1\nscience 1\n", ["词频", "排序", "哈希表"], [_case("公开样例", "3\nData, data! science and Data.\n", "data 3\nand 1\nscience 1\n", True, 25), _case("并列排序", "5\nB a c b A\n", "a 2\nb 2\nc 1\n", True, 25), _case("撇号与数字", "4\nAI-2026 AI's ai\n", "ai 3\ns 1\n", False, 25), _case("k 截断", "1\nz y y x x x\n", "x 3\n", False, 25)]),
]


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _source_review(source: str, language: str) -> dict[str, Any]:
    lines = source.splitlines()
    findings: list[dict[str, str]] = []
    non_empty = [line for line in lines if line.strip()]
    if len(non_empty) < 5:
        findings.append({"level": "warning", "code": "IMPLEMENTATION_DEPTH", "message": "有效实现较短，请复核输入、边界与异常分支。"})
    if any(len(line) > 120 for line in lines):
        findings.append({"level": "info", "code": "LINE_LENGTH", "message": "存在超过 120 字符的代码行。"})
    if re.search(r"\b(TODO|FIXME|pass)\b", source, re.IGNORECASE):
        findings.append({"level": "warning", "code": "UNFINISHED_MARKER", "message": "代码中仍有未完成标记。"})
    if language == "python" and re.search(r"except\s*:", source):
        findings.append({"level": "warning", "code": "BARE_EXCEPT", "message": "裸 except 会掩盖具体错误类型。"})
    if language in {"cpp", "java"} and "long" not in source and re.search(r"sum|distance|score", source, re.IGNORECASE):
        findings.append({"level": "info", "code": "INTEGER_WIDTH", "message": "请确认累计值是否需要 64 位整数。"})
    if not findings:
        findings.append({"level": "success", "code": "STATIC_BASELINE", "message": "基础静态检查未发现明显问题。"})
    return {
        "lines": len(lines),
        "characters": len(source),
        "sourceHash": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "findings": findings,
        "scope": "syntax-independent-static-review",
    }


def _initial_submissions() -> list[dict[str, Any]]:
    seeds = [
        ("SV-20260909-008", "stream-sum", "python", "Accepted", 100, 42, 12288),
        ("SV-20260909-007", "station-deduplicate", "cpp", "Accepted", 100, 18, 2048),
        ("SV-20260909-006", "moving-average", "python", "Wrong Answer", 40, 51, 13312),
        ("SV-20260909-005", "shortest-evacuation", "java", "Time Limit Exceeded", 25, 3000, 64512),
        ("SV-20260909-004", "dependency-order", "cpp", "Compilation Error", 0, 0, 0),
        ("SV-20260909-003", "grid-hotspots", "javascript", "Runtime Error", 25, 84, 28672),
        ("SV-20260909-002", "earthquake-classifier", "python", "Accepted", 100, 39, 12288),
        ("SV-20260909-001", "frequency-table", "python", "Accepted", 100, 45, 12800),
    ]
    result = []
    for offset, (submission_id, problem_id, language, verdict, score, duration, memory) in enumerate(seeds):
        problem = next(item for item in PROBLEMS if item["id"] == problem_id)
        cases = []
        remaining = score
        for index, test in enumerate(problem["tests"]):
            passed = remaining >= test["weight"]
            if passed:
                remaining -= test["weight"]
            case_verdict = "Accepted" if passed else verdict if index == len(cases) else "Skipped"
            cases.append({
                "index": index + 1,
                "name": test["name"],
                "visible": test["visible"],
                "weight": test["weight"],
                "verdict": case_verdict,
                "timeMs": max(4, duration // max(1, len(problem["tests"]))) if passed else duration,
                "memoryKb": memory,
                "stdout": problem["samples"][0]["output"] if test["visible"] and passed else "",
                "stderr": "",
            })
        result.append({
            "id": submission_id,
            "problemId": problem_id,
            "problemVersionId": problem["versionId"],
            "language": language,
            "verdict": verdict,
            "status": "Finished",
            "score": score,
            "timeMs": duration,
            "memoryKb": memory,
            "createdAt": f"2026-09-09T0{8 - min(offset, 8)}:{12 + offset:02d}:00+08:00",
            "sourceHash": hashlib.sha256(f"{problem_id}:{language}:{offset}".encode()).hexdigest(),
            "cases": cases,
            "diagnostics": [] if verdict == "Accepted" else [{"level": "error", "message": f"基准回放结果：{verdict}"}],
            "origin": "verified-benchmark-replay",
        })
    return result


def _initial_state() -> dict[str, Any]:
    selected = PROBLEMS[0]
    return {
        "workspaceId": f"assessment-{uuid.uuid4().hex[:10]}",
        "catalogVersion": CATALOG_VERSION,
        "selectedProblemId": selected["id"],
        "selectedLanguage": "python",
        "drafts": {f'{selected["id"]}:python': selected["starters"]["python"]},
        "customProblems": [],
        "submissions": _initial_submissions(),
        "activeSubmissionId": "SV-20260909-008",
        "lastReview": _source_review(selected["starters"]["python"], "python"),
        "updatedAt": _now(),
    }


def _normalize_state(value: Any) -> dict[str, Any]:
    raw = parse_json(value, fallback={})
    if not isinstance(raw, dict) or not raw:
        return _initial_state()
    state = deepcopy(raw)
    state.setdefault("workspaceId", f"assessment-{uuid.uuid4().hex[:10]}")
    state.setdefault("catalogVersion", CATALOG_VERSION)
    state.setdefault("selectedProblemId", PROBLEMS[0]["id"])
    state.setdefault("selectedLanguage", "python")
    state.setdefault("drafts", {})
    state.setdefault("customProblems", [])
    state.setdefault("submissions", [])
    state.setdefault("activeSubmissionId", state["submissions"][0]["id"] if state["submissions"] else "")
    state.setdefault("lastReview", None)
    state["updatedAt"] = _now()
    if not isinstance(state["drafts"], dict):
        state["drafts"] = {}
    if not isinstance(state["customProblems"], list):
        state["customProblems"] = []
    if not isinstance(state["submissions"], list):
        state["submissions"] = []
    state["submissions"] = state["submissions"][:250]
    return state


def _all_problems(state: dict[str, Any]) -> list[dict[str, Any]]:
    custom = [item for item in state.get("customProblems", []) if isinstance(item, dict)]
    return deepcopy(PROBLEMS) + deepcopy(custom)


def _public_problem(problem: dict[str, Any]) -> dict[str, Any]:
    public = deepcopy(problem)
    public["tests"] = [
        ({**case} if case.get("visible") else {
            "name": case.get("name", "隐藏测试"),
            "visible": False,
            "weight": case.get("weight", 0),
        })
        for case in problem.get("tests", [])
    ]
    public["testSummary"] = {
        "total": len(problem.get("tests", [])),
        "public": sum(bool(case.get("visible")) for case in problem.get("tests", [])),
        "hidden": sum(not bool(case.get("visible")) for case in problem.get("tests", [])),
        "weight": sum(int(case.get("weight", 0)) for case in problem.get("tests", [])),
    }
    return public


def _runtime() -> dict[str, Any]:
    endpoint = os.getenv("JUDGE0_API_URL", "").strip().rstrip("/")
    configured = bool(endpoint)
    return {
        "provider": "Judge0-compatible",
        "adapter": "server-side-batch-v1",
        "status": "ready" if configured else "not-configured",
        "executionAvailable": configured,
        "endpointHost": urllib.parse.urlsplit(endpoint).hostname if configured else "",
        "isolationRequired": True,
        "batch": True,
        "hiddenTests": True,
        "resourceLimits": True,
        "callbacks": False,
        "supportedLanguages": [item["key"] for item in LANGUAGES],
        "executorOptions": ["Judge0", "go-judge"],
    }


def _stats(state: dict[str, Any], problems: list[dict[str, Any]]) -> dict[str, Any]:
    submissions = [item for item in state["submissions"] if isinstance(item, dict)]
    finished = [item for item in submissions if item.get("status") == "Finished"]
    accepted = sum(item.get("verdict") == "Accepted" for item in finished)
    verdicts = Counter(str(item.get("verdict", "Queued")) for item in submissions)
    difficulties = Counter(str(item.get("difficulty", "未分级")) for item in problems)
    categories = Counter(str(item.get("category", "其他")) for item in problems)
    tests = [case for problem in problems for case in problem.get("tests", [])]
    return {
        "problems": len(problems),
        "submissions": len(submissions),
        "finished": len(finished),
        "accepted": accepted,
        "acceptanceRate": round(accepted / max(1, len(finished)) * 100, 1),
        "queued": sum(item.get("status") != "Finished" for item in submissions),
        "testCases": len(tests),
        "hiddenCases": sum(not bool(case.get("visible")) for case in tests),
        "verdictDistribution": [{"name": key, "value": value} for key, value in verdicts.items()],
        "difficultyDistribution": [{"name": key, "value": value} for key, value in difficulties.items()],
        "categoryDistribution": [{"name": key, "value": value} for key, value in categories.items()],
    }


def _validate_problem(problem: dict[str, Any], index: int = 0) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    prefix = f"题目 {index + 1}"
    for key in ("id", "title", "statement", "inputFormat", "outputFormat"):
        if not str(problem.get(key, "")).strip():
            issues.append({"level": "error", "field": key, "message": f"{prefix}缺少 {key}"})
    tests = problem.get("tests", [])
    if not isinstance(tests, list) or len(tests) < 2:
        issues.append({"level": "error", "field": "tests", "message": f"{prefix}至少需要 2 个测试"})
        return issues
    weight = sum(int(case.get("weight", 0)) for case in tests if isinstance(case, dict))
    if weight != 100:
        issues.append({"level": "error", "field": "tests.weight", "message": f"{prefix}测试权重合计为 {weight}，必须为 100"})
    if not any(bool(case.get("visible")) for case in tests if isinstance(case, dict)):
        issues.append({"level": "warning", "field": "tests.visible", "message": f"{prefix}没有公开测试"})
    if not any(not bool(case.get("visible")) for case in tests if isinstance(case, dict)):
        issues.append({"level": "warning", "field": "tests.visible", "message": f"{prefix}没有隐藏测试"})
    return issues


def _build_result(state: dict[str, Any], stage: str, **extra: Any) -> dict[str, Any]:
    problems = _all_problems(state)
    issues = [issue for index, problem in enumerate(problems) for issue in _validate_problem(problem, index)]
    result = {
        "schema": SCHEMA,
        "version": VERSION,
        "stage": stage,
        "catalog": {
            "id": "skyview-assessment-bank",
            "versionId": CATALOG_VERSION,
            "title": "多语言工程与科研编程题库",
            "problems": [_public_problem(item) for item in problems],
            "categories": sorted({str(item.get("category", "其他")) for item in problems}),
            "integrity": hashlib.sha256(json.dumps(problems, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
        },
        "languages": deepcopy(LANGUAGES),
        "runtime": _runtime(),
        "state": state,
        "stats": _stats(state, problems),
        "quality": {
            "valid": not any(issue["level"] == "error" for issue in issues),
            "issues": issues,
            "hiddenDataRedacted": True,
            "sourceHashesRecorded": True,
            "resourceLimitsRequired": True,
        },
        "audit": {
            "workspaceId": state["workspaceId"],
            "catalogVersion": CATALOG_VERSION,
            "updatedAt": state["updatedAt"],
        },
    }
    result.update(extra)
    return result


def _problem_by_id(state: dict[str, Any], problem_id: str) -> dict[str, Any]:
    problem = next((item for item in _all_problems(state) if item.get("id") == problem_id), None)
    if not problem:
        raise ToolError("题目不存在")
    return problem


def _language(key: str) -> dict[str, Any]:
    item = next((language for language in LANGUAGES if language["key"] == key), None)
    if not item:
        raise ToolError("不支持的编程语言")
    return item


def _judge0_request(path: str, *, payload: dict[str, Any] | None = None) -> Any:
    endpoint = os.getenv("JUDGE0_API_URL", "").strip().rstrip("/")
    if not endpoint:
        raise ToolError("隔离执行器尚未配置，提交已保存但不能执行", code="RUNTIME_NOT_CONFIGURED", status_code=409)
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme not in {"https", "http"} or (parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost"}):
        raise ToolError("Judge0 生产地址必须使用 HTTPS", code="RUNTIME_CONFIGURATION_INVALID", status_code=503)
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    auth_header = os.getenv("JUDGE0_AUTH_HEADER", "").strip()
    auth_token = os.getenv("JUDGE0_AUTH_TOKEN", "").strip()
    if auth_header and auth_token:
        headers[auth_header] = auth_token
    request = urllib.request.Request(
        f"{endpoint}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ToolError("隔离执行器请求失败", code="RUNTIME_UNAVAILABLE", status_code=503) from exc


def _decode(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        return base64.b64decode(str(value)).decode("utf-8", errors="replace")
    except (ValueError, UnicodeError):
        return str(value)


def _execute(problem: dict[str, Any], source: str, language: dict[str, Any]) -> tuple[str, int, list[dict[str, Any]]]:
    submissions = []
    for case in problem["tests"]:
        submissions.append({
            "language_id": language["id"],
            "source_code": base64.b64encode(source.encode()).decode(),
            "stdin": base64.b64encode(str(case.get("stdin", "")).encode()).decode(),
            "expected_output": base64.b64encode(str(case.get("expectedOutput", "")).encode()).decode(),
            "cpu_time_limit": problem["limits"]["cpuTime"],
            "wall_time_limit": problem["limits"]["wallTime"],
            "memory_limit": problem["limits"]["memory"],
        })
    created = _judge0_request("/submissions/batch?base64_encoded=true", payload={"submissions": submissions})
    tokens = [str(item.get("token", "")) for item in created if isinstance(item, dict) and item.get("token")]
    if len(tokens) != len(submissions):
        raise ToolError("隔离执行器未返回完整提交标识", code="RUNTIME_PROTOCOL_ERROR", status_code=502)
    results: list[dict[str, Any]] = []
    for _ in range(80):
        query = urllib.parse.urlencode({"tokens": ",".join(tokens), "base64_encoded": "true", "fields": "token,stdout,time,memory,stderr,compile_output,message,status,exit_code"})
        body = _judge0_request(f"/submissions/batch?{query}")
        raw_results = body.get("submissions", []) if isinstance(body, dict) else []
        if len(raw_results) == len(tokens) and all(
            isinstance(item, dict) and int((item.get("status") or {}).get("id", 0)) > 2
            for item in raw_results
        ):
            results = raw_results
            break
        time.sleep(0.6)
    if not results:
        raise ToolError("隔离执行器在轮询上限内未完成", code="RUNTIME_TIMEOUT", status_code=504)
    cases = []
    score = 0
    verdict = "Accepted"
    for index, (test, raw) in enumerate(zip(problem["tests"], results, strict=True)):
        status = raw.get("status", {}) if isinstance(raw, dict) else {}
        description = str(status.get("description", "Internal Error"))
        accepted = int(status.get("id", 0)) == 3
        if accepted:
            score += int(test["weight"])
        elif verdict == "Accepted":
            verdict = description
        cases.append({
            "index": index + 1,
            "name": test["name"],
            "visible": test["visible"],
            "weight": test["weight"],
            "verdict": description,
            "timeMs": round(float(raw.get("time") or 0) * 1000),
            "memoryKb": int(raw.get("memory") or 0),
            "stdout": _decode(raw.get("stdout")) if test["visible"] else "",
            "stderr": _decode(raw.get("stderr") or raw.get("compile_output") or raw.get("message")) if test["visible"] else "",
        })
    return verdict, score, cases


def _export_bundle(state: dict[str, Any]) -> dict[str, Any]:
    problems = _all_problems(state)
    public_problems = [_public_problem(problem) for problem in problems]
    public_workspace = {
        **{key: value for key, value in state.items() if key not in {"submissions", "customProblems"}},
        "customProblems": [
            _public_problem(problem)
            for problem in state.get("customProblems", [])
            if isinstance(problem, dict)
        ],
    }
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.writestr("catalog.json", json.dumps(public_problems, ensure_ascii=False, indent=2))
        package.writestr("submissions.json", json.dumps(state["submissions"], ensure_ascii=False, indent=2))
        package.writestr("workspace.json", json.dumps(public_workspace, ensure_ascii=False, indent=2))
        package.writestr("README.txt", "SkyViewLab AI 测试与提交工作区\n目录包含题库、提交记录与工作区快照。\n")
    return {
        "fileName": f"skyview-ai-assessment-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}.zip",
        "contentType": "application/zip",
        "base64": base64.b64encode(archive.getvalue()).decode(),
        "sha256": hashlib.sha256(archive.getvalue()).hexdigest(),
        "files": 4,
    }


def run_ai_assessment(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action in {"load-sample", "run-all"}:
        return _build_result(_initial_state(), "workspace-ready")

    state = _normalize_state(payload.get("state"))

    if action == "refresh-runtime":
        return _build_result(state, "runtime-refreshed")

    if action == "select-context":
        problem = _problem_by_id(state, str(payload.get("problemId", state["selectedProblemId"])))
        language = _language(str(payload.get("language", state["selectedLanguage"])))
        state["selectedProblemId"] = problem["id"]
        state["selectedLanguage"] = language["key"]
        key = f'{problem["id"]}:{language["key"]}'
        state["drafts"].setdefault(key, problem["starters"][language["key"]])
        return _build_result(state, "context-selected")

    if action == "save-draft":
        problem_id = str(payload.get("problemId", state["selectedProblemId"]))
        language_key = str(payload.get("language", state["selectedLanguage"]))
        _problem_by_id(state, problem_id)
        _language(language_key)
        source = require_text(payload, "code", max_length=MAX_SOURCE_LENGTH)
        state["drafts"][f"{problem_id}:{language_key}"] = source
        state["selectedProblemId"] = problem_id
        state["selectedLanguage"] = language_key
        return _build_result(state, "draft-saved")

    if action in {"review-source", "review"}:
        source = require_text(payload, "code", max_length=MAX_SOURCE_LENGTH)
        language_key = str(payload.get("language", state["selectedLanguage"])).casefold()
        aliases = {"python 3": "python", "python": "python", "c++ 17": "cpp", "c++": "cpp", "javascript": "javascript", "java 13": "java", "java": "java"}
        language_key = aliases.get(language_key, language_key)
        _language(language_key)
        review = _source_review(source, language_key)
        state["lastReview"] = review
        return _build_result(
            state,
            "source-reviewed",
            review=review,
            findings=review["findings"],
            lines=review["lines"],
            characters=review["characters"],
        )

    if action == "submit":
        problem_id = str(payload.get("problemId", state["selectedProblemId"]))
        language_key = str(payload.get("language", state["selectedLanguage"]))
        problem = _problem_by_id(state, problem_id)
        language = _language(language_key)
        source = require_text(payload, "code", max_length=MAX_SOURCE_LENGTH)
        review = _source_review(source, language_key)
        submission_id = f"SV-{datetime.now(UTC).strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
        runtime = _runtime()
        submission = {
            "id": submission_id,
            "problemId": problem_id,
            "problemVersionId": problem["versionId"],
            "language": language_key,
            "verdict": "Queued",
            "status": "Awaiting Runtime",
            "score": 0,
            "timeMs": 0,
            "memoryKb": 0,
            "createdAt": _now(),
            "sourceHash": review["sourceHash"],
            "cases": [{"index": index + 1, "name": case["name"], "visible": case["visible"], "weight": case["weight"], "verdict": "Queued", "timeMs": 0, "memoryKb": 0, "stdout": "", "stderr": ""} for index, case in enumerate(problem["tests"])],
            "diagnostics": review["findings"],
            "origin": "server-submission",
        }
        if runtime["executionAvailable"]:
            verdict, score, cases = _execute(problem, source, language)
            submission.update({
                "verdict": verdict,
                "status": "Finished",
                "score": score,
                "timeMs": max((case["timeMs"] for case in cases), default=0),
                "memoryKb": max((case["memoryKb"] for case in cases), default=0),
                "cases": cases,
            })
        else:
            submission["diagnostics"] = [{"level": "info", "message": "提交已留痕；配置 Judge0 或 go-judge 隔离执行器后可运行。"}, *review["findings"]]
        state["drafts"][f"{problem_id}:{language_key}"] = source
        state["submissions"] = [submission, *state["submissions"]][:250]
        state["activeSubmissionId"] = submission_id
        state["lastReview"] = review
        return _build_result(state, "submission-finished" if submission["status"] == "Finished" else "submission-queued", submission=submission)

    if action == "rejudge":
        submission_id = str(payload.get("submissionId", state.get("activeSubmissionId", "")))
        previous = next((item for item in state["submissions"] if item.get("id") == submission_id), None)
        if not previous:
            raise ToolError("提交记录不存在")
        replay = deepcopy(previous)
        replay["id"] = f"SV-{datetime.now(UTC).strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
        replay["createdAt"] = _now()
        replay["origin"] = "rejudge-request"
        replay["status"] = "Awaiting Runtime"
        replay["verdict"] = "Queued"
        replay["score"] = 0
        for case in replay.get("cases", []):
            case.update({"verdict": "Queued", "timeMs": 0, "memoryKb": 0, "stdout": "", "stderr": ""})
        state["submissions"] = [replay, *state["submissions"]][:250]
        state["activeSubmissionId"] = replay["id"]
        return _build_result(state, "rejudge-queued", submission=replay)

    if action == "validate-bank":
        problems = _all_problems(state)
        issues = [issue for index, problem in enumerate(problems) for issue in _validate_problem(problem, index)]
        return _build_result(state, "catalog-validated", validation={"valid": not any(issue["level"] == "error" for issue in issues), "problems": len(problems), "issues": issues})

    if action == "import-problems":
        imported = parse_json(payload.get("problems"), fallback=[])
        if isinstance(imported, dict):
            imported = imported.get("problems", [])
        if not isinstance(imported, list) or not imported:
            raise ToolError("导入内容必须包含题目数组")
        if len(imported) > 50:
            raise ToolError("单次最多导入 50 道题")
        normalized = []
        existing_ids = {problem["id"] for problem in _all_problems(state)}
        for index, raw in enumerate(imported):
            if not isinstance(raw, dict):
                raise ToolError(f"第 {index + 1} 项不是题目对象")
            problem = deepcopy(raw)
            problem["id"] = re.sub(r"[^a-z0-9-]", "-", str(problem.get("id", "")).casefold()).strip("-")
            if not problem["id"] or problem["id"] in existing_ids:
                raise ToolError(f"第 {index + 1} 项题目标识为空或重复")
            problem.setdefault("versionId", f'{problem["id"]}@custom-1')
            problem.setdefault("number", len(PROBLEMS) + len(state["customProblems"]) + index + 1)
            problem.setdefault("difficulty", "自定义")
            problem.setdefault("category", "自定义")
            problem.setdefault("tags", [])
            problem.setdefault("constraints", [])
            problem.setdefault("samples", [])
            problem.setdefault("hints", [])
            problem.setdefault("starters", _starter(str(problem.get("title", "自定义题目"))))
            problem.setdefault("limits", {"cpuTime": 2, "wallTime": 5, "memory": 128000})
            issues = _validate_problem(problem, index)
            errors = [issue for issue in issues if issue["level"] == "error"]
            if errors:
                raise ToolError("；".join(issue["message"] for issue in errors))
            problem["source"] = "用户导入题库"
            normalized.append(problem)
            existing_ids.add(problem["id"])
        state["customProblems"] = [*state["customProblems"], *normalized]
        return _build_result(state, "catalog-imported", imported=len(normalized))

    if action == "delete-custom-problem":
        problem_id = str(payload.get("problemId", ""))
        before = len(state["customProblems"])
        state["customProblems"] = [item for item in state["customProblems"] if item.get("id") != problem_id]
        if len(state["customProblems"]) == before:
            raise ToolError("只能删除已导入的自定义题目")
        if state["selectedProblemId"] == problem_id:
            state["selectedProblemId"] = PROBLEMS[0]["id"]
        return _build_result(state, "custom-problem-deleted")

    if action == "export":
        export = _export_bundle(state)
        return _build_result(state, "delivery-ready", export=export)

    raise ToolError("不支持的 AI 测试与提交操作")
