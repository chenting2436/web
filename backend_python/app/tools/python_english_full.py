from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import os
import random
import re
import time
import uuid
import zipfile
from copy import deepcopy
from datetime import UTC, date, datetime
from typing import Any

from app.tools.common import ToolError


SCHEMA = "skyview-python-english-results"
PROJECT_SCHEMA = "skyview-python-english-project"
CATALOG_VERSION = "2026.09-card-parity-v1"
TOKEN_SECRET = os.getenv(
    "SKYVIEW_PYTHON_ENGLISH_TOKEN_SECRET",
    "skyview-local-python-english-change-in-production",
).encode("utf-8")

LEVELS = [
    (0, "新手"), (500, "青铜"), (1_500, "白银"), (3_500, "黄金"),
    (7_000, "铂金"), (13_000, "钻石"), (23_000, "大师"),
    (40_000, "宗师"), (70_000, "传奇"), (120_000, "神话"),
]


def _set(set_id: str, name: str, description: str, rows: list[tuple[str, str, str, str]]) -> dict[str, Any]:
    return {
        "id": set_id, "name": name, "description": description,
        "words": [
            {"id": f"{set_id}-{index}", "word": row[0], "translation": row[1],
             "example": row[2], "ipa": row[3], "category": name}
            for index, row in enumerate(rows, 1)
        ],
    }


VOCABULARY_SETS = [
    _set("fundamentals", "Fundamentals & Types", "Describe core Python values and operations in clear technical English.", [
        ("variable", "变量：绑定到对象的名称", "The variable total refers to the current sum.", "/ˈveriəbəl/"),
        ("assignment", "赋值：把对象绑定到名称", "Assignment uses a single equals sign in Python.", "/əˈsaɪnmənt/"),
        ("integer", "整数类型", "An integer stores a whole number without a fractional part.", "/ˈɪntɪdʒər/"),
        ("floating-point number", "浮点数", "A floating-point number approximates a real value.", ""),
        ("string", "字符串：字符序列", "A string is immutable and supports slicing.", "/strɪŋ/"),
        ("Boolean", "布尔值：True 或 False", "The comparison returns a Boolean value.", "/ˈbuːliən/"),
        ("type conversion", "类型转换", "Use explicit type conversion when reading numeric input.", ""),
        ("expression", "表达式：可求值的代码组合", "This expression combines two operands and an operator.", "/ɪkˈspreʃn/"),
    ]),
    _set("control-flow", "Control Flow", "Explain decisions, repetition and iteration without translating word by word.", [
        ("condition", "条件：控制分支是否执行的表达式", "The condition is evaluated before the branch runs.", "/kənˈdɪʃn/"),
        ("branch", "分支", "The else branch handles every remaining case.", "/brɑːntʃ/"),
        ("loop", "循环", "The loop processes one record at a time.", "/luːp/"),
        ("iteration", "迭代；一次循环过程", "Each iteration updates the running total.", "/ˌɪtəˈreɪʃn/"),
        ("iterable", "可迭代对象", "A list is an iterable that preserves order.", "/ˈɪtərəbl/"),
        ("break statement", "终止当前循环的语句", "A break statement exits the nearest loop.", ""),
        ("continue statement", "跳过本次循环余下部分的语句", "Continue moves directly to the next iteration.", ""),
        ("comprehension", "推导式", "A list comprehension expresses mapping and filtering concisely.", "/ˌkɒmprɪˈhenʃn/"),
    ]),
    _set("collections", "Collections", "Discuss how Python containers organize, retrieve and update data.", [
        ("list", "列表：有序可变序列", "A list is appropriate when order matters and values may change.", "/lɪst/"),
        ("tuple", "元组：有序不可变序列", "Return a tuple when the grouped values should remain fixed.", "/ˈtʌpl/"),
        ("dictionary", "字典：键值映射", "The dictionary maps station identifiers to measurements.", "/ˈdɪkʃəneri/"),
        ("set", "集合：唯一元素的无序集合", "A set removes duplicate identifiers efficiently.", "/set/"),
        ("key-value pair", "键值对", "Each key-value pair describes one configuration option.", ""),
        ("index", "索引位置", "Negative index minus one selects the final element.", "/ˈɪndeks/"),
        ("slice", "切片；序列的一个区间", "The slice excludes its stop position.", "/slaɪs/"),
        ("membership", "成员关系", "The in operator performs a membership test.", "/ˈmembəʃɪp/"),
    ]),
    _set("functions", "Functions & Modules", "Present reusable Python components and their interfaces precisely.", [
        ("function", "函数：执行特定任务的可复用代码块", "The function converts raw observations into normalized values.", "/ˈfʌŋkʃn/"),
        ("parameter", "形参：函数定义中的名称", "The threshold parameter has a default value.", "/pəˈræmɪtər/"),
        ("argument", "实参：调用时传给函数的值", "Pass the file path as a keyword argument.", "/ˈɑːɡjumənt/"),
        ("return value", "返回值", "The return value is a newly created dictionary.", ""),
        ("scope", "作用域：名称可见的区域", "A local variable has function scope.", "/skəʊp/"),
        ("module", "模块：可导入的 Python 文件", "The statistics module belongs to the standard library.", "/ˈmɒdjuːl/"),
        ("package", "包：组织模块的目录结构", "The package exposes a small public interface.", "/ˈpækɪdʒ/"),
        ("dependency", "依赖项", "Pin each dependency to make the environment reproducible.", "/dɪˈpendənsi/"),
    ]),
    _set("oop-errors", "OOP & Exceptions", "Explain object design, failure modes and recovery behavior.", [
        ("class", "类：创建对象的蓝图", "The class defines the shared behavior of all sensors.", "/klɑːs/"),
        ("instance", "实例：由类创建的具体对象", "Each instance keeps its own timestamp and value.", "/ˈɪnstəns/"),
        ("attribute", "属性：对象持有的数据或行为", "Access the public attribute through dot notation.", "/ˈætrɪbjuːt/"),
        ("method", "方法：定义在类中的函数", "The method validates the object before saving it.", "/ˈmeθəd/"),
        ("inheritance", "继承", "Inheritance can share behavior across related classes.", "/ɪnˈherɪtəns/"),
        ("exception", "异常：运行时的错误事件", "Raise a clear exception when the input violates the contract.", "/ɪkˈsepʃn/"),
        ("traceback", "回溯信息：异常调用路径", "Read the last line of the traceback before tracing the call stack.", "/ˈtreɪsbæk/"),
        ("exception handler", "异常处理器", "Keep the exception handler narrow and specific.", ""),
    ]),
    _set("files-data", "Files & Data", "Describe local files, serialization and tabular processing.", [
        ("file path", "文件路径", "Build the file path with pathlib instead of string concatenation.", ""),
        ("encoding", "字符编码", "Specify UTF-8 encoding when opening the text file.", "/ɪnˈkəʊdɪŋ/"),
        ("context manager", "上下文管理器", "A context manager closes the file even if an error occurs.", ""),
        ("delimiter", "分隔符", "The tab character is the delimiter in this dataset.", "/dɪˈlɪmɪtər/"),
        ("row", "行；一条表格记录", "Each row represents one monitoring event.", "/rəʊ/"),
        ("column", "列；一个字段", "Convert the temperature column to a numeric data type.", "/ˈkɒləm/"),
        ("serialization", "序列化", "JSON serialization turns the object into a portable text representation.", "/ˌsɪəriəlaɪˈzeɪʃn/"),
        ("missing value", "缺失值", "Handle each missing value according to its cause.", ""),
    ]),
    _set("testing", "Testing & Debugging", "Report evidence about program correctness and defects.", [
        ("test case", "测试用例", "A test case contains an input and an expected outcome.", ""),
        ("assertion", "断言：验证预期的检查", "The assertion compares the actual value with the expected value.", "/əˈsɜːʃn/"),
        ("fixture", "测试夹具：测试所需的固定环境或数据", "The fixture creates a temporary directory for each test.", "/ˈfɪkstʃər/"),
        ("edge case", "边界情况", "An empty collection is an important edge case.", ""),
        ("regression", "回归问题；已修复缺陷再次出现", "Add a regression test before fixing the defect.", "/rɪˈɡreʃn/"),
        ("breakpoint", "断点", "Set a breakpoint immediately before the suspicious assignment.", "/ˈbreɪkpɔɪnt/"),
        ("side effect", "副作用：除返回值外的可观察变化", "Writing to disk is a side effect.", ""),
        ("reproducible", "可复现的", "Record the seed so the failure remains reproducible.", "/ˌriːprəˈdjuːsəbl/"),
    ]),
    _set("scientific", "Scientific Python", "Communicate numerical workflows, evidence and limitations in English.", [
        ("array", "数组：同类型多维数据结构", "A NumPy array supports vectorized numerical operations.", "/əˈreɪ/"),
        ("data frame", "数据框：带标签的二维表格", "The data frame contains one column for each feature.", ""),
        ("vectorized operation", "向量化运算", "A vectorized operation avoids an explicit Python loop.", ""),
        ("sampling rate", "采样率", "The waveform has a sampling rate of one hundred hertz.", ""),
        ("uncertainty", "不确定性", "Report the estimate together with its uncertainty.", "/ʌnˈsɜːtnti/"),
        ("baseline", "基线；对照标准", "Compare the model against a simple baseline.", "/ˈbeɪslaɪn/"),
        ("reproducibility", "可复现性", "Pin software versions to improve computational reproducibility.", "/rɪˌprɒdjuːsəˈbɪləti/"),
        ("interpretation", "解释；对结果意义的说明", "Separate the observed result from its interpretation.", "/ɪnˌtɜːprɪˈteɪʃn/"),
    ]),
]


def _q(question_id: str, prompt: str, options: list[str], correct: int, explanation: str, code: str = "") -> dict[str, Any]:
    return {"id": question_id, "prompt": prompt, "options": options, "correct": correct, "explanation": explanation, "code": code}


EXAMS = [
    {"id": "exam-core", "title": "Python Core English", "level": "Foundation", "durationMinutes": 12,
     "description": "Types, expressions, collection vocabulary and precise code explanations.", "questions": [
        _q("core-1", "Which sentence explains this assignment most precisely?", ["It compares count with zero.", "It binds the integer zero to the name count.", "It declares a fixed integer variable.", "It prints zero."], 1, "In Python, assignment binds a name to an object.", "count = 0"),
        _q("core-2", "What is the best English description of values[1:4]?", ["It selects indexes one through four, including four.", "It selects a new slice from index one up to but excluding four.", "It deletes four values.", "It sorts the list in place."], 1, "The stop index of a slice is exclusive."),
        _q("core-3", "Which object is immutable?", ["list", "dictionary", "set", "tuple"], 3, "A tuple cannot be changed after creation."),
        _q("core-4", "Choose the clearest description of the in operator.", ["It assigns a value.", "It tests membership in a container.", "It imports a package.", "It converts a type."], 1, "The in operator evaluates a membership condition."),
        _q("core-5", "What will the expression evaluate to?", ["True", "False", "3", "An exception"], 0, "and returns True because both comparisons are true.", "3 < 5 and 5 != 0"),
        _q("core-6", "Which term describes a key and its associated value?", ["slice", "iteration", "key-value pair", "parameter"], 2, "Mappings are composed of key-value pairs."),
        _q("core-7", "Which sentence is technically accurate?", ["A string is a mutable sequence.", "A set preserves duplicate elements.", "A dictionary maps unique keys to values.", "A tuple is always numeric."], 2, "Dictionary keys are unique within the mapping."),
        _q("core-8", "What does explicit type conversion do here?", ["Reads a file", "Converts text input to an integer", "Rounds a float", "Validates a password"], 1, "input returns text; int attempts to convert it to an integer.", "age = int(input('Age: '))"),
    ]},
    {"id": "exam-flow-functions", "title": "Control Flow & Functions", "level": "Intermediate", "durationMinutes": 14,
     "description": "Iteration, function interfaces, scope and reusable design.", "questions": [
        _q("flow-1", "Which phrase best explains continue?", ["It exits the program.", "It skips the remaining statements in this iteration.", "It repeats the same iteration forever.", "It returns a value."], 1, "continue moves execution to the next iteration."),
        _q("flow-2", "In the function definition, what is threshold?", ["A return value", "A module", "A parameter", "An exception"], 2, "A name in a function signature is a parameter.", "def detect(values, threshold=0.8):\n    ..."),
        _q("flow-3", "When calling detect(data, threshold=0.9), what is 0.9?", ["A keyword argument", "A local function", "A package", "A branch"], 0, "It is supplied by the caller using the parameter name."),
        _q("flow-4", "Which sentence describes a pure function most accurately?", ["It always prints its result.", "It returns the same result for the same input and avoids observable side effects.", "It never accepts parameters.", "It can only return integers."], 1, "Purity concerns deterministic output and side effects."),
        _q("flow-5", "What does this comprehension produce?", ["All integers from zero to five", "The squares of even integers below six", "Only odd integers", "A generator error"], 1, "The condition filters even values before squaring them.", "[n ** 2 for n in range(6) if n % 2 == 0]"),
        _q("flow-6", "Which statement about local scope is correct?", ["Every local name is available in all modules.", "A local name is normally visible only inside its function.", "Local variables cannot hold lists.", "Python has no scope rules."], 1, "Function-local names are not normally visible outside the function."),
        _q("flow-7", "Why use a return statement?", ["To send a value back to the caller", "To import a package", "To repeat a loop", "To catch every exception"], 0, "return ends the call and supplies a result to its caller."),
        _q("flow-8", "Which import uses the standard library?", ["import statistics", "import my_private_package", "import project_local", "import missing_module"], 0, "statistics is included with Python's standard library."),
    ]},
    {"id": "exam-data-errors", "title": "Data, Files & Exceptions", "level": "Intermediate", "durationMinutes": 15,
     "description": "File handling, tabular data, exceptions and diagnostic language.", "questions": [
        _q("data-1", "Why is with open(...) recommended?", ["It encrypts the file.", "It manages the file resource and closes it reliably.", "It converts every line to JSON.", "It prevents all exceptions."], 1, "The with statement uses a context manager for reliable cleanup."),
        _q("data-2", "What is a delimiter?", ["A character that separates fields", "A missing observation", "A file permission", "A test fixture"], 0, "Delimited text formats use a character such as comma or tab between fields."),
        _q("data-3", "Which handler is the most specific?", ["except:", "except Exception:", "except ValueError:", "except BaseException:"], 2, "Catch the narrowest exception that the code can handle meaningfully."),
        _q("data-4", "What information does a traceback provide?", ["Only the current date", "The chain of calls leading to an exception", "A database backup", "A performance benchmark"], 1, "A traceback identifies frames and source lines on the failure path."),
        _q("data-5", "Which sentence separates observation from interpretation?", ["The model is perfect because accuracy is 91%.", "Accuracy was 91%; this result may reflect class imbalance and requires further checks.", "Accuracy proves causation.", "No uncertainty exists."], 1, "A careful report states the measurement, then qualifies its interpretation."),
        _q("data-6", "What does encoding='utf-8' specify?", ["The table delimiter", "How text bytes map to characters", "The file size", "The number of rows"], 1, "An encoding defines the representation of text as bytes."),
        _q("data-7", "What is the purpose of json.dumps?", ["Deserialize JSON text", "Serialize a Python object to JSON text", "Delete a dictionary", "Open an Excel workbook"], 1, "dumps produces a JSON string representation.", "payload = json.dumps(record, ensure_ascii=False)"),
        _q("data-8", "Which phrase best describes a missing value?", ["A guaranteed zero", "An observation whose value is unavailable", "A duplicate column", "A sorted index"], 1, "Missingness is different from the numeric value zero."),
    ]},
    {"id": "exam-testing-science", "title": "Testing & Scientific Communication", "level": "Advanced", "durationMinutes": 16,
     "description": "Testing evidence, numerical workflows, reproducibility and scientific claims.", "questions": [
        _q("sci-1", "What should a regression test demonstrate?", ["The old defect would be detected if it returned.", "The program has no dependencies.", "Every function is fast.", "All data is normally distributed."], 0, "A regression test protects the behavior affected by a prior defect."),
        _q("sci-2", "Why record a random seed?", ["To increase file size", "To make a stochastic run reproducible", "To remove all uncertainty", "To translate variable names"], 1, "The same seed can recreate the same pseudorandom sequence."),
        _q("sci-3", "Which assertion is most informative?", ["assert True", "assert result", "assert result == expected, 'normalized series differs'", "print(result)"], 2, "A precise expected value and message provide stronger diagnostic evidence."),
        _q("sci-4", "What is a baseline?", ["A reference method used for comparison", "A hidden exception", "A package installer", "An index error"], 0, "A baseline establishes a comparison point for a proposed method."),
        _q("sci-5", "Which claim is appropriately qualified?", ["The method always works.", "On this held-out dataset, the method reduced mean error by 8%; external validation remains necessary.", "The plot proves the theory.", "Uncertainty can be ignored."], 1, "The statement names the evidence, metric and limitation."),
        _q("sci-6", "What does a vectorized operation usually avoid?", ["Numeric arrays", "An explicit Python-level loop", "All memory allocation", "Documentation"], 1, "Array libraries perform the repeated operation in optimized compiled code."),
        _q("sci-7", "What does a fixture provide in a test suite?", ["A controlled setup or resource", "A final publication", "A user password", "A network guarantee"], 0, "Fixtures create repeatable preconditions and cleanup behavior."),
        _q("sci-8", "Which sentence describes uncertainty responsibly?", ["The estimate is exactly true.", "The estimate is 2.4 ± 0.3 under the stated model assumptions.", "Uncertainty is a bug.", "More decimal places remove uncertainty."], 1, "Quantification and assumptions make the limitation explicit."),
    ]},
]

REFERENCES = [
    {
        "id": "ref-explain-code", "title": "How to Explain Python Code in English", "category": "Communication", "minutes": 7,
        "summary": "A reliable structure for explaining purpose, inputs, transformation, output and limitations.",
        "sections": [
            ["Start with intent", "State what the block accomplishes before narrating individual lines. A useful opening is: ‘This function converts raw station records into validated measurements.’"],
            ["Name the interface", "Describe parameters as required inputs, optional controls and defaults. Distinguish parameters in the definition from arguments in a call."],
            ["Trace the transformation", "Use verbs such as filters, maps, groups, validates, aggregates and serializes. These verbs communicate behavior more precisely than ‘handles’ or ‘does’."],
            ["Close with evidence", "State the return type, side effects, exceptions and any assumption that limits the result."],
        ],
        "code": "def valid_readings(rows, threshold=0.0):\n    \"\"\"Return finite readings above the threshold.\"\"\"\n    return [row.value for row in rows if row.is_valid and row.value > threshold]",
    },
    {
        "id": "ref-read-traceback", "title": "Reading a Python Traceback", "category": "Debugging", "minutes": 6,
        "summary": "Locate the exception, reconstruct the call path and report the smallest defensible cause.",
        "sections": [
            ["Read the final line first", "The final line names the exception type and usually includes its message. It tells you what failed, not necessarily why."],
            ["Move upward through frames", "Each frame identifies a file, line and function. Find the first frame that belongs to your own code."],
            ["Verify the failing value", "Inspect the input, its type and the assumption made by that line. Avoid catching the exception before understanding it."],
            ["Report precisely", "Say ‘the conversion raised ValueError because the field contained an empty string’, rather than ‘Python broke’."],
        ],
        "code": "try:\n    value = float(raw_value)\nexcept ValueError as error:\n    raise ValueError(f\"Invalid measurement: {raw_value!r}\") from error",
    },
    {
        "id": "ref-functions", "title": "Functions, Parameters and Contracts", "category": "Core Python", "minutes": 8,
        "summary": "Write and describe functions as small interfaces with explicit contracts.",
        "sections": [
            ["Contract", "A function contract states accepted inputs, returned output, raised exceptions and observable side effects."],
            ["Defaults", "A default value belongs in the signature when it represents a stable, unsurprising policy. Avoid mutable default objects."],
            ["Names", "Prefer verb phrases for actions and noun phrases for returned data. A precise name reduces the explanation burden."],
            ["Documentation", "A short docstring should clarify intent and non-obvious constraints instead of restating syntax."],
        ],
        "code": "def normalize(value: float, minimum: float, maximum: float) -> float:\n    \"\"\"Scale value to [0, 1]; raise ValueError for an empty range.\"\"\"\n    if minimum == maximum:\n        raise ValueError(\"minimum and maximum must differ\")\n    return (value - minimum) / (maximum - minimum)",
    },
    {
        "id": "ref-collections", "title": "Choosing a Python Collection", "category": "Core Python", "minutes": 6,
        "summary": "Select containers by ordering, uniqueness, lookup and mutability requirements.",
        "sections": [
            ["List", "Use a list for an ordered, mutable sequence where duplicates are meaningful."],
            ["Tuple", "Use a tuple for a fixed record-like grouping or an immutable sequence."],
            ["Dictionary", "Use a dictionary when a stable key should retrieve an associated value."],
            ["Set", "Use a set for uniqueness, membership checks and set algebra."],
        ],
        "code": "station_ids = {record.station_id for record in records}\nby_station = {record.station_id: record for record in records}",
    },
    {
        "id": "ref-files", "title": "Safe Local File Handling", "category": "Data", "minutes": 7,
        "summary": "Use pathlib, explicit encodings, context managers and clear validation boundaries.",
        "sections": [
            ["Paths", "Represent paths with pathlib.Path so joining and platform differences remain explicit."],
            ["Text", "Specify the encoding for text input and output. UTF-8 is a reliable default for new data."],
            ["Lifetime", "Use a context manager when the object owns a file descriptor or another finite resource."],
            ["Validation", "Validate structure immediately after parsing and report the source location of invalid data."],
        ],
        "code": "from pathlib import Path\n\npath = Path('data') / 'stations.json'\ntext = path.read_text(encoding='utf-8')",
    },
    {
        "id": "ref-tests", "title": "Writing Evidence-Based Tests", "category": "Testing", "minutes": 9,
        "summary": "Turn expected behavior, boundary conditions and former defects into durable evidence.",
        "sections": [
            ["Arrange", "Create the smallest input and environment needed to reveal the behavior."],
            ["Act", "Execute one meaningful operation. Too many actions make failure diagnosis ambiguous."],
            ["Assert", "Compare the observable result with a precise expectation, including relevant error behavior."],
            ["Protect", "For every repaired defect, add a regression test that fails for the original implementation."],
        ],
        "code": "def test_normalize_rejects_empty_range():\n    with pytest.raises(ValueError, match='must differ'):\n        normalize(2.0, 1.0, 1.0)",
    },
    {
        "id": "ref-scientific", "title": "Scientific Results in Clear English", "category": "Research", "minutes": 8,
        "summary": "Separate method, observation, interpretation, uncertainty and limitation.",
        "sections": [
            ["Method", "Identify the data split, metric, comparison and relevant parameter settings."],
            ["Observation", "Report the measured result with its unit and uncertainty before making a causal claim."],
            ["Interpretation", "Explain what the result suggests under the assumptions of the study."],
            ["Limitation", "Name the population, environment or measurement condition to which the result may not generalize."],
        ],
        "code": "mean_error = errors.mean()\nstandard_error = errors.std(ddof=1) / len(errors) ** 0.5\nprint(f'{mean_error:.2f} ± {standard_error:.2f}')",
    },
    {
        "id": "ref-present", "title": "Presenting a Python Project", "category": "Communication", "minutes": 7,
        "summary": "A four-minute structure for a technical demonstration in English.",
        "sections": [
            ["Problem", "Open with the user, decision or scientific question. Avoid beginning with a list of libraries."],
            ["Pipeline", "Show how inputs move through validation, transformation, analysis and output."],
            ["Evidence", "Demonstrate one representative case, one boundary case and one test or metric."],
            ["Next step", "Conclude with the most important limitation and the next verifiable improvement."],
        ],
        "code": "# Presentation sentence\n# 'The pipeline rejects malformed rows before computing the station-level summary.'",
    },
]


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def _clean(value: Any, limit: int = 4000) -> str:
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value or "")).strip()
    if len(text) > limit:
        raise ToolError("文本超过允许长度")
    return text


def _public_catalog() -> dict[str, Any]:
    return {
        "version": CATALOG_VERSION,
        "vocabularySets": deepcopy(VOCABULARY_SETS),
        "exams": [{key: deepcopy(value) for key, value in exam.items() if key != "questions"} | {"questionCount": len(exam["questions"])} for exam in EXAMS],
        "references": deepcopy(REFERENCES),
        "source": {"name": "2EZ-exam", "repository": "https://github.com/dvrone/2EZ-exam", "commit": "333427c5080ddbebb8d70198df653173876fb0f9"},
    }


def _all_words() -> list[dict[str, Any]]:
    return [word for item in VOCABULARY_SETS for word in item["words"]]


def _sample_project() -> dict[str, Any]:
    now = _now()
    events = []
    for index, word in enumerate(_all_words()[:6]):
        for kind, xp in (("learn", 8), ("cards", 6), ("quiz", 12)):
            events.append({"id": _id("xp"), "key": f"sample:{word['id']}:{kind}", "xp": xp, "kind": kind, "termId": word["id"], "createdAt": now})
    return {
        "schema": PROJECT_SCHEMA, "version": 3, "id": "python-english-card-parity",
        "title": "Python 技术英语进阶", "catalogVersion": CATALOG_VERSION,
        "activeSetId": "fundamentals", "activeWordId": "fundamentals-1", "activeMode": "learn",
        "profile": {"displayName": "当前学习者", "dailyGoalXp": 80, "leaderboardOptIn": False, "sound": True, "vibration": False},
        "xpEvents": events, "progressByTerm": {word["id"]: {"evidence": ["learn", "cards", "quiz"], "masteredAt": now} for word in _all_words()[:6]},
        "referenceReads": ["ref-explain-code", "ref-read-traceback"], "attempts": [], "activeAttempt": None,
        "customSets": [], "customExamDrafts": [], "activities": [{"id": _id("activity"), "type": "catalog", "message": "卡片版完整课程基准已载入", "createdAt": now}],
        "createdAt": now, "updatedAt": now,
    }


def _project(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("state")
    if isinstance(raw, dict) and raw.get("schema") == SCHEMA:
        raw = raw.get("project")
    elif isinstance(raw, dict) and isinstance(raw.get("result"), dict):
        candidate = raw["result"]
        raw = candidate.get("project") if candidate.get("schema") == SCHEMA else candidate
    if not isinstance(raw, dict) or raw.get("schema") != PROJECT_SCHEMA:
        return _sample_project()
    project = deepcopy(raw)
    project.setdefault("xpEvents", [])
    project.setdefault("progressByTerm", {})
    project.setdefault("referenceReads", [])
    project.setdefault("attempts", [])
    project.setdefault("activeAttempt", None)
    project.setdefault("customSets", [])
    project.setdefault("customExamDrafts", [])
    project.setdefault("activities", [])
    return project


def _activity(project: dict[str, Any], message: str, kind: str) -> None:
    project["activities"].insert(0, {"id": _id("activity"), "type": kind, "message": message, "createdAt": _now()})
    project["activities"] = project["activities"][:80]


def _award(project: dict[str, Any], key: str, xp: int, kind: str, term_id: str = "") -> bool:
    if any(item.get("key") == key for item in project["xpEvents"]):
        return False
    project["xpEvents"].append({"id": _id("xp"), "key": key, "xp": xp, "kind": kind, "termId": term_id, "createdAt": _now()})
    return True


def _record_evidence(project: dict[str, Any], term_id: str, evidence: str) -> None:
    if term_id not in {item["id"] for item in _all_words()} and not any(term_id == word.get("id") for group in project["customSets"] for word in group.get("words", [])):
        raise ToolError("术语不存在")
    current = project["progressByTerm"].setdefault(term_id, {"evidence": [], "masteredAt": None})
    if evidence not in current["evidence"]:
        current["evidence"].append(evidence)
    if len(current["evidence"]) >= 3 and not current.get("masteredAt"):
        current["masteredAt"] = _now()


def _sign(data: dict[str, Any]) -> str:
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signature = hmac.new(TOKEN_SECRET, raw, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=") + "." + base64.urlsafe_b64encode(signature).decode().rstrip("=")


def _verify(token: str) -> dict[str, Any]:
    try:
        body, signature = token.split(".", 1)
        raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
        supplied = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        expected = hmac.new(TOKEN_SECRET, raw, hashlib.sha256).digest()
        if not hmac.compare_digest(supplied, expected):
            raise ValueError
        data = json.loads(raw)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ToolError("考试会话无效或已被修改") from exc
    if int(data.get("expiresAt", 0)) < int(time.time()):
        raise ToolError("考试已超过截止时间")
    return data


def _start_exam(exam_id: str) -> tuple[dict[str, Any], str]:
    exam = next((item for item in EXAMS if item["id"] == exam_id), None)
    if not exam:
        raise ToolError("考试不存在")
    seed = random.SystemRandom().randint(1, 2**31 - 1)
    rng = random.Random(seed)
    questions = deepcopy(exam["questions"])
    rng.shuffle(questions)
    public = []
    ordered_ids = []
    for question in questions:
        indexed = list(enumerate(question["options"]))
        rng.shuffle(indexed)
        ordered_ids.append(question["id"])
        public.append({"id": question["id"], "prompt": question["prompt"], "code": question["code"], "choices": [{"id": f"choice-{original}", "label": label} for original, label in indexed]})
    started = int(time.time())
    token = _sign({"examId": exam_id, "questionIds": ordered_ids, "seed": seed, "startedAt": started, "expiresAt": started + exam["durationMinutes"] * 60 + 30})
    attempt = {"id": _id("attempt"), "examId": exam_id, "title": exam["title"], "startedAt": datetime.fromtimestamp(started, UTC).isoformat().replace("+00:00", "Z"), "expiresAt": datetime.fromtimestamp(started + exam["durationMinutes"] * 60, UTC).isoformat().replace("+00:00", "Z"), "durationMinutes": exam["durationMinutes"], "questions": public, "answers": {}, "status": "in-progress", "currentIndex": 0}
    return attempt, token


def _submit_exam(project: dict[str, Any], payload: dict[str, Any]) -> None:
    active = project.get("activeAttempt")
    if not active or active.get("status") != "in-progress":
        raise ToolError("没有可提交的考试")
    data = _verify(_clean(payload.get("examToken"), 10_000))
    if data.get("examId") != active.get("examId") or data.get("questionIds") != [item["id"] for item in active["questions"]]:
        raise ToolError("考试会话与当前试卷不匹配")
    exam = next(item for item in EXAMS if item["id"] == active["examId"])
    private = {item["id"]: item for item in exam["questions"]}
    answers = payload.get("answers") if isinstance(payload.get("answers"), dict) else active.get("answers", {})
    review = []
    correct_count = 0
    for public in active["questions"]:
        question = private[public["id"]]
        selected = str(answers.get(public["id"], ""))
        expected = f"choice-{question['correct']}"
        correct = selected == expected
        correct_count += int(correct)
        review.append({"questionId": question["id"], "prompt": question["prompt"], "selectedChoiceId": selected, "correctChoiceId": expected, "correct": correct, "explanation": question["explanation"]})
    total = len(review)
    percent = round(correct_count / max(1, total) * 100)
    completed = {key: deepcopy(value) for key, value in active.items() if key != "questions"}
    completed.update({"status": "passed" if percent >= 70 else "failed", "submittedAt": _now(), "correct": correct_count, "total": total, "percent": percent, "passed": percent >= 70, "review": review})
    project["attempts"].insert(0, completed)
    project["attempts"] = project["attempts"][:100]
    project["activeAttempt"] = None
    _award(project, f"exam:{active['id']}", 120 if percent >= 70 else 40, "exam")
    _activity(project, f"提交 {exam['title']}：{percent}%", "exam")


def _parse_vocab(raw: Any) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ToolError(f"词汇 JSON 第 {exc.lineno} 行、第 {exc.colno} 列无效：{exc.msg}") from exc
    if isinstance(raw, list):
        raw = {"name": "导入词汇", "words": raw}
    if not isinstance(raw, dict) or not isinstance(raw.get("words"), list):
        raise ToolError("词汇 JSON 必须包含 words 数组")
    if not 1 <= len(raw["words"]) <= 300:
        raise ToolError("每次导入需包含 1–300 个术语")
    set_id = f"custom-{uuid.uuid4().hex[:10]}"
    words = []
    for line, item in enumerate(raw["words"], 1):
        if not isinstance(item, dict):
            raise ToolError(f"words[{line}] 必须是对象")
        word, translation = _clean(item.get("word"), 120), _clean(item.get("translation"), 300)
        if not word:
            raise ToolError(f"words[{line}].word 不能为空")
        if not translation:
            raise ToolError(f"words[{line}].translation 不能为空")
        words.append({"id": f"{set_id}-{line}", "word": word, "translation": translation, "example": _clean(item.get("example"), 500), "ipa": _clean(item.get("ipa"), 80), "category": _clean(raw.get("name"), 100) or "导入词汇"})
    return {"id": set_id, "name": _clean(raw.get("name"), 100) or "导入词汇", "description": _clean(raw.get("description"), 400), "words": words, "importedAt": _now()}


def _parse_exam_text(text: str) -> dict[str, Any]:
    text = _clean(text, 60_000)
    title = "导入考试草稿"
    questions, current = [], None
    for line_no, raw_line in enumerate(text.splitlines(), 1):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("# ") and not questions and current is None:
            title = line[2:].strip() or title
        elif line.startswith("? "):
            if current:
                questions.append(current)
            current = {"id": f"draft-q-{len(questions) + 1}", "prompt": line[2:].strip(), "options": [], "correct": None, "explanation": "", "code": ""}
            if not current["prompt"]:
                raise ToolError(f"第 {line_no} 行题干不能为空")
        elif line.startswith("- "):
            if not current:
                raise ToolError(f"第 {line_no} 行选项之前缺少 '? 题干'")
            value = line[2:].strip()
            correct = value.startswith("#")
            value = value[1:].strip() if correct else value
            if not value:
                raise ToolError(f"第 {line_no} 行选项不能为空")
            if correct:
                if current["correct"] is not None:
                    raise ToolError(f"第 {line_no} 行存在多个正确选项")
                current["correct"] = len(current["options"])
            current["options"].append(value)
        elif line.startswith("> "):
            if not current:
                raise ToolError(f"第 {line_no} 行解析之前缺少题干")
            current["explanation"] = line[2:].strip()
        elif current:
            current["code"] = (current["code"] + "\n" + raw_line).strip()
        else:
            raise ToolError(f"第 {line_no} 行格式无效；请以 #、?、- 或 > 开头")
    if current:
        questions.append(current)
    if not questions:
        raise ToolError("考试文本没有题目")
    for index, question in enumerate(questions, 1):
        if len(question["options"]) < 2:
            raise ToolError(f"第 {index} 题至少需要两个选项")
        if question["correct"] is None:
            raise ToolError(f"第 {index} 题缺少以 '- #' 标记的正确选项")
    return {"id": f"draft-exam-{uuid.uuid4().hex[:10]}", "title": title, "questionCount": len(questions), "status": "teacher-draft", "publishable": False, "questions": questions, "importedAt": _now()}


def _metrics(project: dict[str, Any]) -> dict[str, Any]:
    xp = sum(max(0, int(item.get("xp", 0))) for item in project["xpEvents"])
    level_index = max(index for index, item in enumerate(LEVELS) if xp >= item[0])
    next_threshold = LEVELS[level_index + 1][0] if level_index + 1 < len(LEVELS) else LEVELS[-1][0]
    current_threshold = LEVELS[level_index][0]
    days = sorted({str(item.get("createdAt", ""))[:10] for item in project["xpEvents"] if item.get("createdAt")}, reverse=True)
    streak = 0
    cursor = date.today()
    for value in days:
        try:
            event_day = date.fromisoformat(value)
        except ValueError:
            continue
        delta = (cursor - event_day).days
        if delta == 0:
            streak += 1
            cursor = event_day.fromordinal(event_day.toordinal() - 1)
        elif delta > 0:
            break
    mastered = sum(bool(item.get("masteredAt")) for item in project["progressByTerm"].values())
    attempts = project["attempts"]
    average = round(sum(item.get("percent", 0) for item in attempts) / max(1, len(attempts))) if attempts else 0
    return {"xp": xp, "level": LEVELS[level_index][1], "levelIndex": level_index + 1, "nextLevelXp": next_threshold, "levelProgress": 100 if next_threshold == current_threshold else round((xp - current_threshold) / (next_threshold - current_threshold) * 100), "streak": streak, "mastered": mastered, "totalTerms": len(_all_words()) + sum(len(item.get("words", [])) for item in project["customSets"]), "examAverage": average, "completedExams": len(attempts), "referencesRead": len(project["referenceReads"])}


def _exports(project: dict[str, Any]) -> dict[str, Any]:
    progress = json.dumps(project, ensure_ascii=False, indent=2)
    csv_buffer = io.StringIO()
    writer = csv.writer(csv_buffer)
    writer.writerow(["term_id", "evidence", "mastered_at"])
    for term_id, value in project["progressByTerm"].items():
        writer.writerow([term_id, "|".join(value.get("evidence", [])), value.get("masteredAt", "")])
    attempt_buffer = io.StringIO()
    attempt_writer = csv.writer(attempt_buffer)
    attempt_writer.writerow(["attempt_id", "exam_id", "percent", "passed", "submitted_at"])
    for item in project["attempts"]:
        attempt_writer.writerow([item.get("id"), item.get("examId"), item.get("percent"), item.get("passed"), item.get("submittedAt")])
    refs = "\n\n".join(f"# {item['title']}\n\n{item['summary']}\n\n" + "\n\n".join(f"## {section[0]}\n\n{section[1]}" for section in item["sections"]) + f"\n\n```python\n{item['code']}\n```" for item in REFERENCES)
    package = io.BytesIO()
    with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps({"schema": SCHEMA, "catalogVersion": CATALOG_VERSION, "projectId": project["id"], "createdAt": _now(), "checksum": hashlib.sha256(progress.encode()).hexdigest()}, ensure_ascii=False, indent=2))
        archive.writestr("progress/project.json", progress)
        archive.writestr("progress/terms.csv", csv_buffer.getvalue())
        archive.writestr("progress/exams.csv", attempt_buffer.getvalue())
        archive.writestr("content/vocabulary.json", json.dumps({"sets": VOCABULARY_SETS + project["customSets"]}, ensure_ascii=False, indent=2))
        archive.writestr("content/references.md", refs)
    return {"projectJson": progress, "progressCsv": csv_buffer.getvalue(), "attemptsCsv": attempt_buffer.getvalue(), "vocabularyJson": json.dumps({"sets": VOCABULARY_SETS + project["customSets"]}, ensure_ascii=False, indent=2), "referencesMarkdown": refs, "packageBase64": base64.b64encode(package.getvalue()).decode("ascii")}


def _result(project: dict[str, Any], stage: str, *, exam_token: str = "") -> dict[str, Any]:
    project["updatedAt"] = _now()
    metrics = _metrics(project)
    leaderboard = [{"rank": 1, "displayName": project["profile"]["displayName"], "xp": metrics["xp"], "level": metrics["level"]}] if project["profile"].get("leaderboardOptIn") else []
    return {
        "schema": SCHEMA, "version": 3, "stage": stage, "project": project,
        "catalog": _public_catalog(),
        "analysis": {"metrics": metrics, "leaderboard": leaderboard, "awards": [{"id": "first-mastery", "name": "术语启航", "earned": metrics["mastered"] >= 1}, {"id": "six-mastered", "name": "基础构筑者", "earned": metrics["mastered"] >= 6}, {"id": "exam-pass", "name": "考试通关", "earned": any(item.get("passed") for item in project["attempts"])}, {"id": "reader", "name": "指南研读者", "earned": metrics["referencesRead"] >= 4}]},
        "runtime": {"goControlPlane": {"status": "enabled"}, "pythonLearningEngine": {"status": "enabled"}, "speechSynthesis": {"status": "browser-native"}, "speechRecognition": {"status": "browser-optional"}, "pronunciationScoring": {"status": "not-configured", "mode": "learner-self-assessment"}, "leaderboardDirectory": {"status": "not-configured", "privacy": "explicit-opt-in"}, "arbitraryCodeExecution": False},
        "exports": _exports(project), "examToken": exam_token,
    }


MUTATING = {"select-set", "select-mode", "record-learn", "record-card", "record-quiz", "record-typing", "record-pronunciation", "start-exam", "save-exam-answer", "submit-exam", "mark-reference-read", "update-preferences", "import-vocabulary", "import-exam", "reset-progress"}


def run_python_english(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "grade" and not payload.get("state"):
        from app.tools.teaching import python_english as legacy
        return legacy(action, payload)
    if action in {"load-sample", "run-all"} and not payload.get("state"):
        return _result(_sample_project(), "load-sample")
    project = _project(payload)
    role = _clean(payload.get("actorRole") or "owner", 30).casefold()
    if action in MUTATING and role == "viewer":
        raise ToolError("只读成员不能修改学习项目", code="TOOL_FORBIDDEN", status_code=403)
    exam_token = _clean(payload.get("examToken"), 10_000)

    if action == "select-set":
        set_id = _clean(payload.get("setId"), 80)
        groups = VOCABULARY_SETS + project["customSets"]
        group = next((item for item in groups if item["id"] == set_id), None)
        if not group:
            raise ToolError("词汇主题不存在")
        project["activeSetId"], project["activeWordId"] = set_id, group["words"][0]["id"]
    elif action == "select-mode":
        mode = _clean(payload.get("mode"), 40)
        if mode not in {"learn", "cards", "quiz", "speak", "type"}:
            raise ToolError("训练模式无效")
        project["activeMode"] = mode
    elif action in {"record-learn", "record-card", "record-quiz", "record-typing"}:
        term_id = _clean(payload.get("termId"), 100)
        evidence = {"record-learn": "learn", "record-card": "cards", "record-quiz": "quiz", "record-typing": "type"}[action]
        correct = bool(payload.get("correct", True))
        if evidence in {"quiz", "type"} and not correct:
            _activity(project, f"复习术语 {term_id}", "practice")
        else:
            _record_evidence(project, term_id, evidence)
            _award(project, f"{evidence}:{term_id}:{_clean(payload.get('sessionKey') or date.today().isoformat(), 100)}", 12 if evidence in {"quiz", "type"} else 8, evidence, term_id)
    elif action == "record-pronunciation":
        term_id = _clean(payload.get("termId"), 100)
        assessment = _clean(payload.get("selfAssessment"), 30)
        if assessment not in {"accurate", "retry", "skip"}:
            raise ToolError("发音记录必须由学习者明确自评")
        if assessment == "accurate":
            _record_evidence(project, term_id, "speak-self")
            _award(project, f"speak:{term_id}:{_clean(payload.get('sessionKey') or date.today().isoformat(), 100)}", 10, "speak-self", term_id)
        _activity(project, f"发音自评：{assessment}（未启用自动发音评分）", "pronunciation")
    elif action == "start-exam":
        attempt, exam_token = _start_exam(_clean(payload.get("examId"), 80))
        project["activeAttempt"] = attempt
        _activity(project, f"开始考试：{attempt['title']}", "exam")
    elif action == "save-exam-answer":
        active = project.get("activeAttempt")
        if not active:
            raise ToolError("没有进行中的考试")
        question_id, choice_id = _clean(payload.get("questionId"), 80), _clean(payload.get("choiceId"), 80)
        question = next((item for item in active["questions"] if item["id"] == question_id), None)
        if not question or choice_id not in {item["id"] for item in question["choices"]}:
            raise ToolError("答案与当前试卷不匹配")
        active["answers"][question_id] = choice_id
        active["currentIndex"] = min(len(active["questions"]) - 1, max(0, int(payload.get("currentIndex", active.get("currentIndex", 0)))))
    elif action == "submit-exam":
        _submit_exam(project, payload)
        exam_token = ""
    elif action == "mark-reference-read":
        reference_id = _clean(payload.get("referenceId"), 80)
        if reference_id not in {item["id"] for item in REFERENCES}:
            raise ToolError("参考指南不存在")
        if reference_id not in project["referenceReads"]:
            project["referenceReads"].append(reference_id)
            _award(project, f"reference:{reference_id}", 30, "reference")
            _activity(project, f"完成指南：{reference_id}", "reference")
    elif action == "update-preferences":
        preferences = payload.get("preferences") if isinstance(payload.get("preferences"), dict) else {}
        if "displayName" in preferences:
            project["profile"]["displayName"] = _clean(preferences["displayName"], 40) or "当前学习者"
        for key in ("sound", "vibration", "leaderboardOptIn"):
            if key in preferences:
                project["profile"][key] = bool(preferences[key])
        if "dailyGoalXp" in preferences:
            try:
                project["profile"]["dailyGoalXp"] = max(20, min(500, int(preferences["dailyGoalXp"])))
            except (TypeError, ValueError) as exc:
                raise ToolError("每日目标必须是 20–500 的整数") from exc
        _activity(project, "更新学习偏好与排行榜隐私设置", "preferences")
    elif action == "import-vocabulary":
        if role not in {"owner", "admin"}:
            raise ToolError("只有项目负责人或管理员可以导入词汇", code="TOOL_FORBIDDEN", status_code=403)
        project["customSets"].append(_parse_vocab(payload.get("content")))
        _activity(project, "导入自定义词汇集", "import")
    elif action == "import-exam":
        if role not in {"owner", "admin"}:
            raise ToolError("只有项目负责人或管理员可以导入考试", code="TOOL_FORBIDDEN", status_code=403)
        project["customExamDrafts"].append(_parse_exam_text(_clean(payload.get("content"), 60_000)))
        _activity(project, "导入考试草稿；正确答案仅供教师校对，未发布为学生考试", "import")
    elif action == "reset-progress":
        if role not in {"owner", "admin"}:
            raise ToolError("只有项目负责人或管理员可以清空进度", code="TOOL_FORBIDDEN", status_code=403)
        project["xpEvents"], project["progressByTerm"], project["referenceReads"], project["attempts"], project["activeAttempt"] = [], {}, [], [], None
        _activity(project, "清空学习进度", "reset")
    elif action in {"runtime-status", "validate", "export", "load-sample", "run-all"}:
        pass
    else:
        raise ToolError(f"不支持的 Python 英语操作：{action}")
    return _result(project, action, exam_token=exam_token)
