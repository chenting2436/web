from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import html
import io
import json
import os
import random
import re
import time
import uuid
from copy import deepcopy
from datetime import UTC, datetime
from typing import Any

from app.tools.common import ToolError


BANK_ID = "skyview-daily-practice"
BANK_VERSION_ID = "professional-2026.09-v2"
ALLOWED_COUNTS = {10, 20, 30, 50, 80, 100}
ALLOWED_DURATIONS = {10, 20, 30, 45, 60, 90, 120}
TOPICS = (
    ("python", "Python 工程", "Python Engineering"),
    ("algorithms", "算法与数据结构", "Algorithms & Data Structures"),
    ("data", "数据工程与 SQL", "Data Engineering & SQL"),
    ("statistics", "统计与实验设计", "Statistics & Experiment Design"),
    ("ai", "机器学习与 AI 工程", "Machine Learning & AI Engineering"),
    ("scientific", "科学计算与可复现研究", "Scientific Computing & Reproducibility"),
)
TOPIC_IDS = {item[0] for item in TOPICS}
TOKEN_SECRET = os.getenv(
    "SKYVIEW_PRACTICE_TOKEN_SECRET",
    "skyview-local-practice-token-change-in-production",
).encode("utf-8")


def _now() -> int:
    return int(time.time())


def _iso(timestamp: int | None = None) -> str:
    return datetime.fromtimestamp(timestamp or _now(), tz=UTC).isoformat().replace("+00:00", "Z")


def _i18n(zh: str, en: str) -> dict[str, str]:
    return {"zh": zh, "en": en}


def _choice(zh: str, en: str | None = None) -> dict[str, str]:
    return _i18n(zh, en or zh)


def _single(
    question_id: str,
    category: str,
    difficulty: int,
    zh: str,
    en: str,
    choices: list[tuple[str, str] | str],
    answer: Any,
    explanation_zh: str,
    explanation_en: str,
    *,
    question_type: str = "single",
    skill: str | None = None,
    cognitive: str = "apply",
    estimated_minutes: int = 2,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    normalized_choices = [
        _choice(item[0], item[1]) if isinstance(item, tuple) else _choice(item)
        for item in choices
    ]
    return {
        "id": question_id,
        "versionId": f"{question_id}@{BANK_VERSION_ID}",
        "category": category,
        "difficulty": difficulty,
        "type": question_type,
        "prompt": _i18n(zh, en),
        "choices": normalized_choices,
        "answer": answer,
        "explanation": _i18n(explanation_zh, explanation_en),
        "skill": skill or category,
        "cognitiveLevel": cognitive,
        "estimatedMinutes": estimated_minutes,
        "tags": tags or [category],
        "sourceKind": "original",
    }


def _fill(
    question_id: str,
    category: str,
    difficulty: int,
    zh: str,
    en: str,
    accepted: list[str],
    answer_label: str,
    explanation_zh: str,
    explanation_en: str,
    *,
    question_type: str = "fill",
    skill: str | None = None,
    cognitive: str = "apply",
    estimated_minutes: int = 2,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": question_id,
        "versionId": f"{question_id}@{BANK_VERSION_ID}",
        "category": category,
        "difficulty": difficulty,
        "type": question_type,
        "prompt": _i18n(zh, en),
        "choices": [],
        "accepted": accepted,
        "answerLabel": answer_label,
        "explanation": _i18n(explanation_zh, explanation_en),
        "skill": skill or category,
        "cognitiveLevel": cognitive,
        "estimatedMinutes": estimated_minutes,
        "tags": tags or [category],
        "sourceKind": "original",
    }


def _base_questions() -> list[dict[str, Any]]:
    return [
        _single("py-list", "python", 1, "执行 list(range(2, 8, 2)) 的结果是什么？", "What is the result of list(range(2, 8, 2))?", ["[2, 4, 6]", "[2, 4, 6, 8]", "[2, 3, 4, 5, 6, 7]", "[0, 2, 4, 6]"], 0, "range 的结束值不包含在序列中，因此依次得到 2、4、6。", "The stop value is excluded, so the sequence contains 2, 4, and 6."),
        _single("py-dict", "python", 1, "Python 字典中用于安全读取不存在键并提供默认值的方法是？", "Which dictionary method safely reads a missing key with a default value?", ["append", "get", "index", "extend"], 1, "dict.get(key, default) 在键不存在时返回默认值，不会抛出 KeyError。", "dict.get(key, default) returns the default instead of raising KeyError."),
        _single("py-comprehension", "python", 2, "哪个表达式可以得到 1 到 10 中所有偶数的平方？", "Which expression returns squares of all even numbers from 1 through 10?", ["[x*x for x in range(1, 11) if x % 2 == 0]", "[x for x in range(10) if x*x]", "[x%2 for x in range(1, 11)]", "[x*x if x%2 for x in range(1, 11)]"], 0, "列表推导式先用条件筛选偶数，再计算 x*x。", "The list comprehension filters even values before calculating x*x."),
        _single("data-missing", "data", 1, "处理缺失值之前最先应该做什么？", "What should be done first before handling missing values?", [("直接删除所有行", "Delete every row"), ("识别缺失比例和字段含义", "Inspect the missing rate and field meaning"), ("把缺失值全部改成 0", "Replace every missing value with zero"), ("只保留数值列", "Keep numeric columns only")], 1, "缺失值处理取决于比例、字段语义和分析目标，应先完成诊断。", "The strategy depends on rate, meaning, and analysis goals, so diagnosis comes first."),
        _single("data-duplicate", "data", 2, "删除重复记录时，最需要提前确认的是？", "What must be confirmed before removing duplicate records?", [("屏幕尺寸", "Screen size"), ("唯一标识字段与重复判定规则", "Unique keys and duplicate rules"), ("文件扩展名", "File extension"), ("图表颜色", "Chart color")], 1, "同一对象可能有多次合法记录，必须先确定业务上的唯一键与判重标准。", "Repeated rows may be legitimate, so define the business key and duplicate rule first."),
        _single("data-correlation", "data", 3, "相关系数很高时，下列结论哪一个最严谨？", "Which conclusion is most rigorous when correlation is high?", [("一个变量必然导致另一个变量", "One variable necessarily causes the other"), ("两个变量存在较强线性关系，但不直接证明因果", "The variables have a strong linear relation, but causation is not proven"), ("模型一定可以准确预测", "The model must predict accurately"), ("数据一定没有异常值", "The data must contain no outliers")], 1, "相关性反映共同变化程度，不能单独证明因果关系。", "Correlation describes co-movement and does not by itself establish causation."),
        _single("ai-split", "ai", 1, "训练集与测试集分开的主要目的是什么？", "Why are training and test sets separated?", [("让文件更小", "Make files smaller"), ("评估模型在未见数据上的泛化能力", "Evaluate generalization on unseen data"), ("减少字段数量", "Reduce field count"), ("自动生成标签", "Generate labels automatically")], 1, "测试集模拟模型面对新数据时的表现，不能参与训练。", "The test set estimates performance on unseen data and should not be used for training."),
        _single("ai-leakage", "ai", 2, "数据泄漏最可能造成什么现象？", "What is a likely symptom of data leakage?", [("训练和测试指标异常优秀，但上线表现明显下降", "Offline metrics look exceptional while production performance drops"), ("模型文件无法保存", "The model file cannot be saved"), ("CSV 无法打开", "The CSV cannot be opened"), ("损失函数永远为负数", "Loss is always negative")], 0, "测试信息进入训练过程会制造虚假的高分，真实泛化能力通常较差。", "Test information leaking into training creates misleadingly strong offline scores."),
        _single("ai-metric", "ai", 3, "在极度类别不平衡的风险识别任务中，仅看准确率为什么可能误导？", "Why can accuracy be misleading for a highly imbalanced risk-detection task?", [("准确率无法计算", "Accuracy cannot be computed"), ("始终预测多数类也可能得到很高准确率", "Predicting only the majority class can still score highly"), ("准确率只适合回归", "Accuracy is only for regression"), ("准确率会自动删除少数类", "Accuracy deletes the minority class")], 1, "应结合召回率、精确率、F1 或 PR 曲线评估少数类识别效果。", "Use recall, precision, F1, or PR curves to assess minority-class performance."),
        _single("py-scope", "python", 2, "函数内部需要修改模块级变量 count 时，应使用哪个声明？", "Which declaration is needed to modify a module-level variable named count inside a function?", ["public count", "global count", "static count", "outer count"], 1, "global 声明告诉解释器该名称绑定到模块级变量。", "global binds the name to module scope."),
        _single("py-exception", "python", 2, "下列哪种写法最适合只捕获文件不存在错误？", "Which form is best for catching only a missing-file error?", ["except:", "except Error:", "except FileNotFoundError:", "except Exception as FileNotFoundError:"], 2, "捕获具体异常可以避免掩盖权限、编码或程序错误。", "Catching the specific exception avoids hiding other errors."),
        _single("py-generator", "python", 3, "生成器相较一次性列表的主要优势是什么？", "What is the main advantage of a generator over a fully materialized list?", [("语法永远更短", "Syntax is always shorter"), ("按需产生值，适合流式处理并降低内存占用", "Produce values lazily for streaming and lower memory use"), ("自动并行执行", "Run in parallel automatically"), ("不需要异常处理", "Need no error handling")], 1, "生成器采用惰性求值，只在迭代时产生下一项。", "Generators are lazy and produce the next value only when requested."),
        _single("data-outlier", "data", 2, "发现极端值后，最合理的第一步是什么？", "What is the most appropriate first step after finding an extreme value?", [("立即删除", "Delete it immediately"), ("核查来源、单位和业务合理性", "Check source, unit, and business plausibility"), ("替换成平均数", "Replace it with the mean"), ("复制该行", "Duplicate the row")], 1, "异常值可能是录入错误，也可能是重要风险信号，应先追溯来源。", "An outlier may be an error or a signal; trace its source first."),
        _single("data-scaling", "data", 2, "标准化通常把数值转换成什么形式？", "What does standardization usually transform numeric values into?", [("0 到 1 的整数", "Integers from 0 to 1"), ("均值约为 0、标准差约为 1", "Mean near 0 and standard deviation near 1"), ("百分比字符串", "Percentage strings"), ("排序后的类别", "Sorted categories")], 1, "常见 Z-score 标准化使用 (x-均值)/标准差。", "Z-score standardization uses (x-mean)/standard deviation."),
        _single("data-split", "data", 3, "时间序列建模为什么通常不能随机打乱后再划分训练集？", "Why should a time series usually not be randomly shuffled before a train/test split?", [("会改变文件名", "It changes file names"), ("未来信息可能泄漏到训练数据", "Future information may leak into training"), ("会删除时间字段", "It deletes the time field"), ("图表颜色会变化", "Chart colors change")], 1, "应使用过去训练、未来验证，避免前视偏差。", "Train on the past and validate on the future to avoid look-ahead bias."),
        _single("ai-validation", "ai", 2, "验证集在模型开发中的主要作用是什么？", "What is the main role of a validation set during model development?", [("替代训练集", "Replace the training set"), ("选择超参数并比较候选模型", "Choose hyperparameters and compare candidate models"), ("存放最终报告", "Store the final report"), ("自动生成新特征", "Generate features automatically")], 1, "验证集用于开发阶段的模型选择，测试集应保留到最终评估。", "The validation set guides model selection; the test set remains for final evaluation."),
        _single("ai-explain", "ai", 2, "解释模型预测时，为什么要区分全局解释和局部解释？", "Why distinguish global and local explanations of a model?", [("二者文件格式不同", "They use different file formats"), ("全局描述整体规律，局部说明某个样本的预测依据", "Global explains overall patterns; local explains one prediction"), ("局部解释一定更准确", "Local explanations are always more accurate"), ("全局解释不需要数据", "Global explanations need no data")], 1, "二者回答不同层级的问题，应结合使用。", "They answer different levels of questions and should be used together."),
        _single("ai-reproducible", "ai", 3, "为了让机器学习实验更可复现，最完整的做法是？", "Which practice best supports reproducible machine-learning experiments?", [("只保存最终准确率", "Save only final accuracy"), ("记录代码、数据版本、环境、随机种子和参数", "Record code, data version, environment, seed, and parameters"), ("每次手动调整参数", "Tune manually each time"), ("仅保存模型截图", "Save only a screenshot")], 1, "可复现性需要同时追踪数据、环境、代码和配置。", "Reproducibility requires tracking data, environment, code, and configuration."),
    ]


def _generated_questions() -> list[dict[str, Any]]:
    generated: list[dict[str, Any]] = []
    for index in range(1, 31):
        a, b, mode = 2 + index % 7, 3 + index % 5, index % 5
        if mode == 0:
            stop, correct = a + b * 3, a + b * 2
            generated.append(_single(f"py-generated-{index}", "python", 1, f"list(range({a}, {stop}, {b})) 的最后一个元素是什么？", f"What is the last element of list(range({a}, {stop}, {b}))?", [str(correct), str(stop), str(a + b), str(stop - 1)], 0, f"range 不包含结束值 {stop}，最后一项是 {correct}。", f"range excludes {stop}, so the last item is {correct}."))
        elif mode == 1:
            value = a * b
            generated.append(_single(f"py-generated-{index}", "python", 1, f"执行 x = {a}; x *= {b} 后，x 等于多少？", f"After x = {a}; x *= {b}, what is x?", [str(value), str(a + b), str(value + b), str(a)], 0, f"*= 是乘法赋值，结果为 {value}。", f"*= is multiplication assignment, so the result is {value}."))
        elif mode == 2:
            values = [a, b, a + b, a * 2]
            spread = max(values) - min(values)
            generated.append(_single(f"py-generated-{index}", "python", 2, f"列表 {values} 中，max(values) - min(values) 的结果是？", f"For {values}, what is max(values) - min(values)?", [str(spread), str(max(values)), str(min(values)), str(len(values))], 0, "先分别求最大值与最小值，再计算二者差值。", "Find the maximum and minimum first, then subtract."))
        elif mode == 3:
            value = a * b + index
            generated.append(_single(f"py-generated-{index}", "python", 2, f"{value} % {b} 的值是多少？", f"What is {value} % {b}?", [str(value % b), str(value // b), str(b), str(value)], 0, f"% 返回整数除法的余数，本题为 {value % b}。", f"% returns the remainder, which is {value % b}."))
        else:
            generated.append(_single(f"py-generated-{index}", "python", 3, f"表达式 [x for x in range({a + 5}) if x % 2 == 0] 会保留哪类数字？", f"What kind of values does [x for x in range({a + 5}) if x % 2 == 0] keep?", [("偶数", "Even numbers"), ("奇数", "Odd numbers"), ("负数", "Negative numbers"), ("浮点数", "Floating-point numbers")], 0, "x % 2 == 0 是偶数判断条件。", "x % 2 == 0 tests for even values."))

    for index in range(1, 31):
        a, b, c, mode = 60 + index, 70 + index % 20, 80 + index % 15, index % 5
        if mode == 0:
            mean = (a + b + c) / 3
            generated.append(_single(f"data-generated-{index}", "data", 1, f"数据 {a}、{b}、{c} 的平均值是多少？", f"What is the mean of {a}, {b}, and {c}?", [f"{mean:.2f}", str(a + b + c), str(max(a, b, c)), str(min(a, b, c))], 0, f"总和除以 3，结果为 {mean:.2f}。", f"Divide the sum by 3 to get {mean:.2f}."))
        elif mode == 1:
            generated.append(_single(f"data-generated-{index}", "data", 1, f"100 条记录中有 {index} 条缺失，缺失率是多少？", f"{index} of 100 records are missing. What is the missing rate?", [f"{index}%", f"{100-index}%", f"{index/10}%", str(index)], 0, "缺失率 = 缺失数量 ÷ 总数量 × 100%。", "Missing rate = missing count / total count × 100%."))
        elif mode == 2:
            middle = sorted([a, b, c])[1]
            generated.append(_single(f"data-generated-{index}", "data", 2, f"数据 {a}、{b}、{c} 的中位数是多少？", f"What is the median of {a}, {b}, and {c}?", [str(middle), str(min(a, b, c)), str(max(a, b, c)), f"{(a+b+c)/3:.1f}"], 0, f"排序后位于中间的数是 {middle}。", f"After sorting, the middle value is {middle}."))
        elif mode == 3:
            generated.append(_single(f"data-generated-{index}", "data", 2, "合并两个数据表时，用于确认同一对象的字段通常叫什么？", "What is the field used to identify the same entity when joining tables usually called?", [("主键", "Key"), ("颜色", "Color"), ("页边距", "Margin"), ("图例", "Legend")], 0, "稳定且唯一的主键是可靠关联数据表的基础。", "A stable unique key is the basis of a reliable join."))
        else:
            generated.append(_single(f"data-generated-{index}", "data", 3, "数据清洗操作为什么需要保存可重放的步骤？", "Why should data-cleaning operations be saved as replayable steps?", [("便于复现、审查并应用到新数据", "To reproduce, audit, and apply them to new data"), ("让文件名更长", "To make filenames longer"), ("自动删除原始数据", "To delete source data"), ("避免保存结果", "To avoid saving results")], 0, "操作记录可以复现处理流程，并帮助审查每一步的影响。", "Operation history makes the workflow reproducible and auditable."))

    for index in range(1, 31):
        tp, fn, mode = 20 + index, 1 + index % 9, index % 5
        if mode == 0:
            recall = tp / (tp + fn) * 100
            generated.append(_single(f"ai-generated-{index}", "ai", 2, f"模型识别出 {tp} 个真正例，漏掉 {fn} 个正例，召回率约为？", f"A model finds {tp} true positives and misses {fn}. What is recall?", [f"{recall:.1f}%", f"{tp}%", f"{fn}%", f"{(tp+fn)/100:.1f}%"], 0, f"召回率 = TP ÷ (TP + FN) = {recall:.1f}%。", f"Recall = TP / (TP + FN) = {recall:.1f}%."))
        elif mode == 1:
            generated.append(_single(f"ai-generated-{index}", "ai", 1, "下列哪一项属于监督学习所需的关键信息？", "Which item is essential for supervised learning?", [("输入样本及对应标签", "Input samples and labels"), ("只有未标注样本", "Only unlabeled samples"), ("网页颜色", "Page color"), ("显示器分辨率", "Display resolution")], 0, "监督学习利用输入与目标标签之间的对应关系训练模型。", "Supervised learning trains on input-target pairs."))
        elif mode == 2:
            generated.append(_single(f"ai-generated-{index}", "ai", 2, "交叉验证的主要价值是什么？", "What is the main value of cross-validation?", [("更稳定地估计模型泛化表现", "Estimate generalization more reliably"), ("自动生成无限数据", "Generate unlimited data"), ("保证模型没有偏差", "Guarantee no bias"), ("替代所有测试", "Replace all testing")], 0, "多次划分并验证可以降低单次划分带来的偶然性。", "Repeated splits reduce the chance effect of one validation split."))
        elif mode == 3:
            generated.append(_single(f"ai-generated-{index}", "ai", 3, "类别不平衡时调整分类阈值，最直接改变的是？", "What changes most directly when the classification threshold is adjusted?", [("精确率与召回率之间的权衡", "The precision-recall trade-off"), ("训练数据文件名", "Training filename"), ("模型输入维度", "Input dimension"), ("随机种子类型", "Seed type")], 0, "降低阈值通常提高召回率但可能降低精确率，反之亦然。", "Lowering a threshold often increases recall while reducing precision."))
        else:
            generated.append(_single(f"ai-generated-{index}", "ai", 3, "模型监控为什么需要比较训练数据与新数据的分布？", "Why compare training-data and new-data distributions during monitoring?", [("识别数据漂移及性能风险", "Detect drift and performance risk"), ("改变代码缩进", "Change code indentation"), ("压缩模型文件", "Compress model files"), ("删除评估指标", "Delete metrics")], 0, "输入分布变化可能使模型不再适用于当前场景。", "Distribution shifts can make a model unreliable."))
    return generated


def _special_questions() -> list[dict[str, Any]]:
    questions = [
        _single("special-multiple-python", "python", 2, "以下哪些对象是 Python 的可变对象？（多选）", "Which Python objects are mutable? Select all.", ["list", "dict", "tuple", "str"], [0, 1], "列表和字典可原地修改；元组和字符串不可变。", "Lists and dictionaries are mutable; tuples and strings are immutable.", question_type="multiple"),
        _fill("special-fill-python", "python", 1, "填写用于定义函数的 Python 关键字。", "Enter the Python keyword used to define a function.", ["def"], "def", "Python 使用 def 开始函数定义。", "Python function definitions start with def."),
        _single("special-bool-python", "python", 1, "判断：Python 的 range 结束值包含在生成序列中。", "True or false: the stop value of range is included.", [("错误", "False"), ("正确", "True")], 0, "range 的结束值不包含在序列中。", "The stop value is excluded.", question_type="boolean"),
        _fill("special-code-python", "python", 2, "填写表达式：获取列表 values 的元素数量。", "Enter the expression that returns the number of items in values.", ["len(values)", "len ( values )"], "len(values)", "内置函数 len 返回容器长度。", "The built-in len function returns container length."),
        _single("special-multiple-data", "data", 2, "以下哪些属于数据质量维度？（多选）", "Which are data-quality dimensions? Select all.", [("完整性", "Completeness"), ("一致性", "Consistency"), ("准确性", "Accuracy"), ("按钮颜色", "Button color")], [0, 1, 2], "完整性、一致性和准确性都是常见数据质量维度。", "Completeness, consistency, and accuracy are common data-quality dimensions.", question_type="multiple"),
        _fill("special-fill-data", "data", 1, "100 条记录中缺失 5 条，请填写缺失率（百分数）。", "Five of 100 records are missing. Enter the missing rate as a percentage.", ["5%", "5"], "5%", "5 ÷ 100 × 100% = 5%。", "5 / 100 × 100% = 5%."),
        _single("special-bool-data", "data", 1, "判断：发现重复行后应当无条件全部删除。", "True or false: every duplicate-looking row should always be deleted.", [("错误", "False"), ("正确", "True")], 0, "业务上可能存在合法重复记录，删除前必须确认唯一键与规则。", "Some repeated rows are legitimate; verify the business key first.", question_type="boolean"),
        _fill("special-fill-sql", "data", 2, "填写 SQL 中用于筛选行的关键字。", "Enter the SQL keyword used to filter rows.", ["where"], "WHERE", "WHERE 子句用于指定行筛选条件。", "The WHERE clause specifies row filters."),
        _single("special-multiple-ai", "ai", 2, "以下哪些指标适合评估类别不平衡的分类任务？（多选）", "Which metrics help evaluate an imbalanced classifier? Select all.", ["Recall", "Precision", "F1", ("文件大小", "File size")], [0, 1, 2], "召回率、精确率和 F1 能反映少数类识别能力。", "Recall, precision, and F1 expose minority-class performance.", question_type="multiple"),
        _fill("special-fill-ai", "ai", 1, "填写英文缩写：真正例数量记作什么？", "Enter the abbreviation for true positives.", ["tp"], "TP", "TP 表示 True Positive。", "TP stands for True Positive."),
        _single("special-bool-ai", "ai", 2, "判断：测试集可以在调参过程中反复使用。", "True or false: the test set may be repeatedly used for hyperparameter tuning.", [("错误", "False"), ("正确", "True")], 0, "反复使用测试集会造成评估泄漏；调参应使用验证集。", "Repeated test-set use leaks evaluation information; tune on validation data.", question_type="boolean"),
        _fill("special-fill-ai-metric", "ai", 3, "填写指标名称：Precision 与 Recall 的调和平均数。", "Enter the metric that is the harmonic mean of precision and recall.", ["f1", "f1 score", "f1-score"], "F1-score", "F1 使用调和平均综合精确率和召回率。", "F1 combines precision and recall using the harmonic mean."),
    ]
    return questions


def _advanced_questions() -> list[dict[str, Any]]:
    """Original advanced bank inspired by mature assessment-system capabilities.

    The scenarios and explanations are authored for SkyViewLab. No upstream question
    content is copied. Ten deterministic variants per concept provide stable IDs while
    leaving room for a future database-backed authoring workflow.
    """
    contexts = [
        ("生产故障复盘", "production incident review"),
        ("架构评审", "architecture review"),
        ("代码审计", "code audit"),
        ("容量压测", "capacity test"),
        ("科研复现", "research reproduction"),
        ("安全评估", "security assessment"),
        ("迁移验收", "migration acceptance"),
        ("性能诊断", "performance diagnosis"),
        ("数据治理", "data governance review"),
        ("上线门禁", "release gate"),
    ]

    # type, difficulty, skill, zh, en, choices, answer, explanation zh/en, cognitive
    specs: dict[str, list[tuple[Any, ...]]] = {
        "python": [
            ("case", 4, "async-cancellation", "asyncio 任务被取消时，哪种处理最能保持结构化并发的取消语义？", "When an asyncio task is cancelled, which handling best preserves structured-concurrency cancellation semantics?", ["捕获 BaseException 后静默返回", "完成必要清理后重新抛出 CancelledError", "把 CancelledError 转成普通返回值", "无限重试被取消的协程"], 1, "取消是控制流信号；清理资源后应继续传播，避免父任务误判子任务正常完成。", "Cancellation is control flow; clean up and re-raise so the parent does not treat the child as successful.", "evaluate"),
            ("single", 5, "descriptor-mro", "多继承中同名描述符与实例属性冲突时，判断访问结果首先应检查什么？", "With multiple inheritance, what should be checked first when a descriptor conflicts with an instance attribute?", ["源文件行数", "C3 MRO 与描述符是否实现 __set__", "对象的字符串长度", "垃圾回收阈值"], 1, "数据描述符优先于实例字典，非数据描述符则可能被实例属性遮蔽；解析顺序由 C3 MRO 决定。", "Data descriptors outrank the instance dictionary, while non-data descriptors may be shadowed; C3 MRO determines lookup order.", "analyze"),
            ("multiple", 4, "concurrency-model", "哪些任务更适合交给多进程而不是仅增加 asyncio 协程？（多选）", "Which workloads benefit from processes rather than merely adding asyncio coroutines? Select all.", ["纯 Python CPU 密集数值循环", "多个等待网络响应的轻量请求", "需要隔离崩溃的第三方本地库", "只做异步套接字转发"], [0, 2], "进程可绕开单解释器执行限制并提供故障隔离；I/O 等待更适合异步协程。", "Processes help CPU-bound Python and fault isolation; coroutine concurrency is better for I/O waits.", "analyze"),
            ("ordering", 4, "context-manager", "请按上下文管理器处理异常的真实调用顺序排列。", "Order the actual context-manager calls when the body raises an exception.", ["调用 __enter__", "执行 with 代码块", "把异常信息传给 __exit__", "依据 __exit__ 返回值决定是否抑制异常"], [0, 1, 2, 3], "with 先进入，再执行主体；异常三元组交给 __exit__，其真值决定异常是否被抑制。", "with enters, runs the body, passes exception details to __exit__, then uses its truth value to decide suppression.", "analyze"),
            ("boolean", 4, "typing-variance", "判断：list[Derived] 可以安全地当作 list[Base] 传入并允许被调用方写入 Base。", "True or false: list[Derived] can safely be passed as list[Base] when the callee may append Base values.", ["错误", "正确"], 0, "可变容器通常是不变的，否则写入 Base 会破坏原列表的元素类型约束。", "Mutable containers are invariant because inserting a Base could violate the original element constraint.", "evaluate"),
            ("fill", 3, "generator-protocol", "填写用于向已启动生成器内部发送值的方法名。", "Enter the method used to send a value into an already-started generator.", [], ["send"], "send", "generator.send(value) 会恢复生成器，并让暂停处的 yield 表达式得到该值。", "generator.send(value) resumes the generator and makes the suspended yield expression receive that value.", "apply"),
            ("case", 5, "multiprocessing-spawn", "Windows 的 spawn 启动方式下，避免子进程递归创建最关键的结构是什么？", "Under Windows spawn, which structure is essential to prevent recursive process creation?", ["把所有函数写成 lambda", "用 if __name__ == '__main__' 保护入口", "关闭类型检查", "把模块命名为 multiprocessing.py"], 1, "spawn 会重新导入主模块，入口保护可阻止导入阶段再次启动进程。", "spawn re-imports the main module; the main guard prevents process creation during import.", "apply"),
            ("single", 4, "memory-model", "需要对大型 bytes 缓冲区切片且避免复制时，首选哪种内置机制？", "Which built-in mechanism slices a large bytes buffer without copying?", ["str", "memoryview", "deepcopy", "pickle"], 1, "memoryview 暴露缓冲协议视图，可在不复制底层数据的情况下切片。", "memoryview exposes the buffer protocol and can slice without copying the underlying bytes.", "apply"),
        ],
        "data": [
            ("case", 5, "transaction-isolation", "两个事务分别读取彼此约束的数据后写入不同记录，最终共同破坏约束。这属于什么问题？", "Two transactions read a shared invariant and update different rows, jointly violating it. What anomaly is this?", ["脏读", "写偏差", "不可重复读", "幻读的唯一表现"], 1, "写偏差可能在快照隔离下发生；需要可串行化隔离、显式锁或约束重构。", "Write skew can occur under snapshot isolation; serializable isolation, locking, or constraint redesign is needed.", "analyze"),
            ("single", 4, "sql-window", "计算滚动 7 行平均值且希望遇到相同排序键时仍严格只取物理 7 行，应使用哪种窗口框架？", "For a rolling seven-row average that must include exactly seven physical rows despite tied sort keys, which frame is appropriate?", ["RANGE BETWEEN 6 PRECEDING AND CURRENT ROW", "ROWS BETWEEN 6 PRECEDING AND CURRENT ROW", "GROUPS UNBOUNDED PRECEDING", "不写 ORDER BY"], 1, "ROWS 按物理行计数；RANGE 会把相同排序值的同组行纳入，数量可能超过 7。", "ROWS counts physical rows; RANGE may include all peers with the same ordering value.", "analyze"),
            ("ordering", 4, "scd2", "将一条维度变更写入 SCD Type 2 时，请排列核心步骤。", "Order the core steps for writing a dimension change using SCD Type 2.", ["定位当前有效版本", "关闭旧版本有效期", "插入带新生效时间的新版本", "验证同一业务键仅一个当前版本"], [0, 1, 2, 3], "先锁定当前版本，再原子关闭并插入新版本，最后验证唯一有效记录约束。", "Locate and lock the current version, close it and insert the new version atomically, then validate uniqueness.", "apply"),
            ("multiple", 5, "stream-exactly-once", "流处理声称端到端 exactly-once 时，必须同时满足哪些条件？（多选）", "Which conditions are required for end-to-end exactly-once stream processing? Select all.", ["可重放且有序的输入位置", "处理状态与消费位点一致提交", "外部副作用幂等或参与事务", "只增加消费者数量"], [0, 1, 2], "引擎内部一次并不足够；输入、状态和外部输出必须形成一致的恢复边界。", "Engine-local guarantees are insufficient; input positions, state, and external effects need one recovery boundary.", "evaluate"),
            ("case", 4, "watermark", "事件时间窗口已关闭后仍到达一批旧事件，系统应依据什么决定更新、旁路或丢弃？", "Late events arrive after an event-time window closes. What should determine update, side-output, or drop behavior?", ["机器 CPU 型号", "水位线与允许迟到策略", "CSV 文件名", "前端主题颜色"], 1, "水位线表达事件时间进度，允许迟到阈值决定状态保留和修正输出策略。", "Watermarks express event-time progress; allowed lateness controls state retention and correction behavior.", "apply"),
            ("fill", 3, "cdc", "填写数据库变更数据捕获的常用英文缩写。", "Enter the common abbreviation for change data capture.", [], ["cdc"], "CDC", "CDC 将插入、更新和删除作为有序变更流交付给下游。", "CDC delivers inserts, updates, and deletes as an ordered change stream.", "remember"),
            ("boolean", 4, "schema-evolution", "判断：给事件模式新增一个无默认值的必填字段，通常对旧消费者天然向后兼容。", "True or false: adding a required event field without a default is naturally backward compatible for old consumers.", ["错误", "正确"], 0, "旧数据没有该字段，新消费者或模式验证可能失败；应使用可选字段或明确默认值并分阶段发布。", "Old data lacks the field and validation may fail; use an optional field or explicit default with staged rollout.", "evaluate"),
            ("single", 5, "distributed-join", "一张超大事实表与很小且稳定的维表关联时，减少跨节点洗牌的常见优先方案是？", "When joining a huge fact table to a small stable dimension, what commonly minimizes shuffle?", ["对两表全量排序", "广播小表", "把事实表收集到单机", "随机改变分区键"], 1, "广播小表让各执行节点本地完成关联，前提是维表足够小且内存可控。", "Broadcasting the small table enables local joins when it safely fits in worker memory.", "analyze"),
        ],
        "ai": [
            ("case", 5, "nested-validation", "在小样本中既要调参又要无偏估计泛化误差，最合适的评估设计是？", "With limited data, which design supports tuning and an approximately unbiased generalization estimate?", ["在测试集上反复调参", "嵌套交叉验证", "只报告训练误差", "挑选最好的一次随机划分"], 1, "内层选择超参数，外层只评估选择流程，避免测试折被调参过程污染。", "The inner loop tunes while the outer loop evaluates the selection procedure without contamination.", "evaluate"),
            ("multiple", 5, "point-in-time-features", "构建训练样本时，哪些做法可避免特征穿越？（多选）", "Which practices prevent point-in-time feature leakage? Select all.", ["按样本事件时间进行 as-of join", "记录特征可用时间而不仅是发生时间", "使用当前最新用户画像回填全部历史样本", "对迟到数据设置重算边界"], [0, 1, 3], "训练特征必须在预测时刻真实可用；事件时间、可用时间和迟到策略都要记录。", "Features must have been available at prediction time; event time, availability time, and lateness policy matter.", "analyze"),
            ("single", 4, "calibration", "二分类模型的排序能力较好但概率系统性过度自信，优先补充哪类处理？", "A binary classifier ranks well but is systematically overconfident. What should be added?", ["只提高分类阈值", "在独立校准集上做概率校准", "删除所有低概率样本", "只报告准确率"], 1, "Platt scaling 或 isotonic regression 可在独立数据上校准概率，不能复用训练数据自证。", "Platt scaling or isotonic regression can calibrate probabilities on held-out data.", "apply"),
            ("case", 5, "drift-diagnosis", "线上输入分布变化但 P(y|x) 未变，这更接近哪类漂移？", "The online input distribution changes while P(y|x) remains stable. Which drift is this?", ["概念漂移", "协变量漂移", "标签翻转", "评估泄漏"], 1, "协变量漂移是 P(x) 变化；概念漂移则涉及目标条件分布变化。", "Covariate drift changes P(x); concept drift changes the target conditional relationship.", "analyze"),
            ("ordering", 4, "mlops-rollback", "模型灰度发布出现异常时，请排列安全回滚闭环。", "Order a safe rollback loop after a canary model release degrades.", ["触发业务与模型联合告警", "冻结扩量并切回稳定版本", "保存输入、特征与推理证据", "复盘根因并补回归门禁"], [0, 1, 2, 3], "先阻断影响，再恢复服务，同时保全证据，最后把根因转成自动化门禁。", "Contain impact, restore service, preserve evidence, then turn the root cause into a regression gate.", "evaluate"),
            ("multiple", 5, "rag-evaluation", "评估 RAG 系统时，哪些维度不能被单一最终答案准确率替代？（多选）", "Which RAG evaluation dimensions cannot be replaced by one final-answer accuracy score? Select all.", ["检索召回与排序", "回答对证据的忠实度", "引用可追溯性", "按钮圆角大小"], [0, 1, 2], "需要分别度量检索、生成忠实度和证据引用，才能定位错误发生在哪一层。", "Measure retrieval, generation faithfulness, and citation traceability separately to localize failures.", "evaluate"),
            ("boolean", 4, "fairness", "判断：总体 AUC 接近 1 就能证明所有人群上的公平性与安全性。", "True or false: an overall AUC near 1 proves fairness and safety for every group.", ["错误", "正确"], 0, "总体指标会掩盖子群体差异，还需按场景检查误差率、校准、覆盖度和伤害成本。", "Aggregate metrics can hide subgroup gaps; inspect error rates, calibration, coverage, and harm by context.", "evaluate"),
            ("fill", 3, "classification-metrics", "填写由 Precision 与 Recall 的调和平均得到的指标缩写。", "Enter the metric abbreviation for the harmonic mean of precision and recall.", [], ["f1", "f1score", "f1-score"], "F1", "F1 在精确率与召回率之间给出调和平均，但仍应结合阈值和业务成本解释。", "F1 is their harmonic mean, but it still depends on threshold and business costs.", "remember"),
        ],
        "algorithms": [
            ("single", 4, "shortest-path", "存在可达负权边但不存在负环时，哪种算法可求单源最短路？", "Which algorithm handles reachable negative edges when no negative cycle exists?", ["Dijkstra", "Bellman–Ford", "Prim", "二分查找"], 1, "Bellman–Ford 通过重复松弛处理负权边，并可检测负环。", "Bellman-Ford uses repeated relaxation and can detect negative cycles.", "apply"),
            ("case", 5, "a-star", "A* 要保证找到最优路径，对启发函数的最低关键要求是什么？", "What key condition on the heuristic lets A* guarantee an optimal path?", ["始终大于真实剩余代价", "可采纳，即不高估真实剩余代价", "只能返回整数", "与节点编号相等"], 1, "可采纳启发式不高估；图搜索中一致性还能避免复杂的重新展开。", "An admissible heuristic never overestimates; consistency additionally simplifies graph search.", "analyze"),
            ("single", 4, "union-find", "带路径压缩与按秩合并的并查集，均摊复杂度通常写作？", "What is the amortized complexity of union-find with path compression and union by rank?", ["O(n)", "O(log n)", "O(α(n))", "O(n log n)"], 2, "其均摊复杂度由反 Ackermann 函数界定，在实际规模下接近常数。", "The inverse Ackermann bound is effectively constant at practical sizes.", "remember"),
            ("ordering", 4, "topological-sort", "使用 Kahn 算法做拓扑排序时，请排列步骤。", "Order the steps of Kahn's topological sort.", ["统计各节点入度", "把零入度节点入队", "弹出节点并降低出边终点入度", "若输出数少于节点数则报告环"], [0, 1, 2, 3], "零入度队列逐步移除依赖；无法移除全部节点说明存在有向环。", "The zero-indegree queue removes dependencies; leftover nodes imply a directed cycle.", "apply"),
            ("multiple", 5, "bloom-filter", "标准 Bloom Filter 具有哪些性质？（多选）", "Which properties does a standard Bloom filter have? Select all.", ["可能假阳性", "不会假阴性（未删除前提下）", "能直接枚举全部元素", "空间效率高"], [0, 1, 3], "它是概率成员结构：节省空间、可能误报存在，但不会漏报已插入元素。", "It is a space-efficient probabilistic membership structure with false positives but no false negatives absent deletion.", "analyze"),
            ("single", 5, "max-flow", "最大流最小割定理把最大 s-t 流值与什么等同？", "The max-flow min-cut theorem equates maximum s-t flow with what?", ["最长简单路径", "最小 s-t 割容量", "图的节点数", "最小生成树权重"], 1, "任意流受任意割容量上界约束，而存在达到最小割容量的最大流。", "Every flow is bounded by every cut, and a maximum flow reaches the minimum cut capacity.", "analyze"),
            ("case", 4, "consistent-hashing", "缓存节点扩缩容时希望只迁移少量键，常用哪种分配策略？", "Which assignment strategy moves relatively few keys when cache nodes scale?", ["固定取模哈希", "一致性哈希与虚拟节点", "每次全量随机", "按键字典序分半"], 1, "一致性哈希把键和节点映射到环；虚拟节点改善负载均衡。", "Consistent hashing maps keys and nodes to a ring; virtual nodes improve balance.", "apply"),
            ("boolean", 4, "amortized-analysis", "判断：动态数组 append 的最坏单次复杂度为 O(n)，但均摊复杂度可为 O(1)。", "True or false: dynamic-array append is O(n) in the worst case but O(1) amortized.", ["正确", "错误"], 0, "偶尔扩容复制 O(n)，但几何增长把总复制成本摊到多次追加。", "Occasional O(n) resizing is spread across many appends under geometric growth.", "analyze"),
            ("single", 5, "segment-tree", "支持区间查询和单点更新的线段树，典型单次复杂度是？", "What is the typical per-operation complexity for range queries and point updates in a segment tree?", ["O(1)", "O(log n)", "O(√n)", "O(n)"], 1, "树高为 O(log n)，查询与更新只访问对数级相关节点。", "The tree height is logarithmic and each operation touches logarithmically many nodes.", "apply"),
            ("fill", 3, "string-matching", "填写 KMP 算法用于避免主串指针回退的前缀函数常用缩写。", "Enter the common abbreviation for KMP's prefix table.", [], ["lps", "pi"], "LPS / π", "LPS 或 π 数组记录最长相等真前后缀，使失配时复用已匹配信息。", "The LPS or pi table reuses matched-prefix information after mismatch.", "remember"),
            ("case", 5, "scc", "把有向图的每个强连通分量压缩成一个点后，所得图一定是什么？", "After contracting every strongly connected component, what must the resulting graph be?", ["完全图", "有向无环图", "二分图", "无向树"], 1, "若压缩图仍有环，环上的分量应属于同一个更大的强连通分量，产生矛盾。", "A cycle in the condensation would imply those components form one larger SCC.", "analyze"),
            ("multiple", 4, "btree", "B/B+ 树适合数据库索引的原因包括哪些？（多选）", "Why are B/B+ trees suitable for database indexes? Select all.", ["高扇出降低树高", "节点大小可贴合页读取", "范围扫描高效", "所有操作都严格 O(1)"], [0, 1, 2], "页友好的高扇出结构减少随机 I/O，B+ 树叶链便于范围扫描。", "Page-sized high fanout reduces random I/O and linked leaves support range scans.", "analyze"),
        ],
        "statistics": [
            ("single", 5, "power-analysis", "在效应量和显著性水平不变时，希望提高检验功效，通常最直接的设计手段是？", "With effect size and alpha fixed, what most directly increases statistical power?", ["减少样本量", "增加样本量", "只报告显著结果", "提高测量噪声"], 1, "增加样本量降低标准误并提高识别给定效应的概率；仍应在研究前完成功效设计。", "A larger sample reduces standard error and improves the chance of detecting the target effect.", "apply"),
            ("case", 5, "multiple-testing", "同时检验大量相关假设并希望控制错误发现率，优先考虑哪种方法？", "When testing many related hypotheses and controlling false discovery rate, which method is appropriate?", ["Bonferroni 只控制 FWER", "Benjamini–Hochberg", "删除不显著样本", "重复选择最小 p 值"], 1, "BH 对排序后的 p 值应用阈值以控制 FDR，目标与严格控制族错误率不同。", "BH thresholds ordered p-values to control FDR rather than the stricter family-wise error rate.", "evaluate"),
            ("multiple", 5, "causal-dag", "估计处理对结果的总因果效应时，哪些变量通常不应盲目纳入调整集？（多选）", "When estimating a total causal effect, which variables should not be blindly adjusted for? Select all.", ["处理后的中介变量", "碰撞点变量", "处理前共同原因", "由选择机制产生的后果变量"], [0, 1, 3], "中介会截断部分总效应，条件化碰撞点或选择后果可能打开伪路径；共同原因通常需要控制。", "Mediators block part of the total effect, while conditioning on colliders or selection consequences can open spurious paths.", "analyze"),
            ("single", 4, "cluster-randomization", "整所学校随机分组而分析学生结果时，标准误必须处理什么结构？", "When schools are randomized but student outcomes are analyzed, what must standard errors account for?", ["校内相关性", "字体差异", "文件压缩率", "问卷页数"], 0, "同一集群内观测不独立，应使用集群稳健推断或分层模型，并按集群数评估功效。", "Observations within a cluster are dependent; use cluster-aware inference or hierarchical models.", "analyze"),
            ("case", 5, "noninferiority", "非劣效试验在看结果前必须预先明确的核心量是什么？", "What core quantity must a non-inferiority trial specify before seeing outcomes?", ["非劣效界值", "最终 p 值", "最好看的子组", "事后删除比例"], 0, "非劣效界值应由临床或业务可接受损失定义，事后设定会破坏推断可信度。", "The non-inferiority margin must reflect acceptable loss and be specified prospectively.", "evaluate"),
            ("boolean", 4, "bootstrap", "判断：对强依赖时间序列逐点独立重采样，普通 bootstrap 仍天然保持原相关结构。", "True or false: ordinary iid bootstrap preserves strong serial dependence in a time series.", ["错误", "正确"], 0, "逐点重采样破坏时序依赖，应考虑 block bootstrap 等结构化重采样。", "Pointwise resampling destroys serial dependence; block bootstrap is often needed.", "evaluate"),
            ("single", 5, "missing-data", "缺失概率依赖未观测值本身，即使给定已观测变量仍成立，属于哪类机制？", "If missingness depends on the unseen value itself even conditional on observed data, which mechanism applies?", ["MCAR", "MAR", "MNAR", "完全观测"], 2, "这是非随机缺失 MNAR，通常需要敏感性分析或显式缺失机制模型。", "This is MNAR and usually requires sensitivity analysis or an explicit missingness model.", "analyze"),
            ("single", 4, "robust-estimation", "含少量极端污染值时，哪种位置统计量通常比均值更稳健？", "With a small fraction of extreme contamination, which location statistic is more robust than the mean?", ["中位数", "最大值", "样本和", "平方和"], 0, "中位数具有更高的崩溃点，不会被少数极端值任意拉动。", "The median has a higher breakdown point and resists a few extreme values.", "apply"),
            ("ordering", 4, "sequential-testing", "计划进行序贯检验时，请排列合规分析流程。", "Order a defensible sequential-testing workflow.", ["预先定义查看频率与停止规则", "选择 alpha spending 或等价控制方法", "按计划进行中期分析", "报告停止时间与全部查看记录"], [0, 1, 2, 3], "频繁偷看会膨胀一类错误；预注册边界并完整报告可保持推断有效。", "Unplanned peeking inflates type-I error; prespecified boundaries and complete reporting preserve validity.", "evaluate"),
            ("fill", 3, "calibration-statistics", "填写衡量概率预测均方误差、同时反映校准与分辨率的评分名称。", "Enter the score name for mean squared error of probabilistic predictions.", [], ["brier", "brier score", "布里尔评分"], "Brier score", "Brier score 对概率预测与二元结果的平方差取平均，属于 proper scoring rule。", "The Brier score averages squared probability errors and is a proper scoring rule.", "remember"),
            ("case", 5, "hierarchical-model", "多个小地区样本量差异很大，直接分别估计波动剧烈。分层模型的主要收益是什么？", "Small regions have unequal samples and unstable separate estimates. What is the main benefit of a hierarchical model?", ["让每个地区完全相同", "通过部分汇聚稳定估计并保留异质性", "消除所有模型假设", "保证因果识别"], 1, "部分汇聚让信息在群体间共享，小样本地区收缩更多，同时允许真实差异存在。", "Partial pooling shares information, shrinking small groups more while retaining heterogeneity.", "analyze"),
            ("multiple", 5, "time-series-validation", "时间序列预测的可靠验证通常需要哪些措施？（多选）", "Which practices support reliable time-series validation? Select all.", ["滚动或扩展窗口回测", "特征按预测时点截断", "随机打乱后普通 K 折", "报告不同时间段稳定性"], [0, 1, 3], "验证必须尊重时间因果顺序，并检查跨时期的性能与漂移。", "Validation must respect temporal order and assess stability across periods.", "evaluate"),
        ],
        "scientific": [
            ("single", 4, "floating-point", "为什么计算 0.1 + 0.2 时不应直接与 0.3 做严格浮点相等比较？", "Why should 0.1 + 0.2 not be compared to 0.3 by strict floating-point equality?", ["CPU 不支持加法", "多数十进制小数无法用有限二进制精确表示", "Python 会随机改值", "0.3 是字符串"], 1, "二进制浮点产生舍入误差，应使用相对与绝对容差相结合的近似比较。", "Binary floating point introduces rounding; compare with appropriate relative and absolute tolerances.", "analyze"),
            ("case", 5, "conditioning", "输入只有极小扰动却导致解大幅变化，首先应怀疑什么？", "Tiny input perturbations cause large solution changes. What should be suspected first?", ["问题条件数很大", "显示器刷新率低", "文件名过短", "循环次数为偶数"], 0, "高条件数表示问题本身对扰动敏感，算法稳定也无法消除全部信息损失。", "A high condition number means the problem itself is sensitive even with a stable algorithm.", "analyze"),
            ("multiple", 5, "reproducibility", "让计算实验可复核至少应固定或记录哪些要素？（多选）", "Which elements should be fixed or recorded for reproducible computation? Select all.", ["代码提交与依赖锁", "输入数据版本与校验和", "随机种子和硬件/运行参数", "只保存最终截图"], [0, 1, 2], "可复现记录要覆盖代码、环境、数据、参数和随机性，并保存机器可读产物。", "Reproducibility spans code, environment, data, parameters, randomness, and machine-readable artifacts.", "evaluate"),
            ("ordering", 4, "provenance", "请排列科研数据处理的可追溯链。", "Order a traceable scientific data-processing chain.", ["登记原始数据与校验和", "记录参数和软件环境", "执行不可变任务并保存日志", "关联结果、图表与报告版本"], [0, 1, 2, 3], "从输入身份到环境、运行和交付物都应有稳定引用，才能完成端到端追溯。", "Stable references from input identity through environment, execution, and outputs enable end-to-end provenance.", "apply"),
            ("single", 5, "geospatial-crs", "将经纬度直接当作米计算欧氏距离的主要问题是什么？", "What is wrong with treating longitude/latitude degrees as meters in Euclidean distance?", ["度不是线性等距单位且随位置变化", "经度永远等于纬度", "坐标只能存成字符串", "所有 CRS 都使用英尺"], 0, "地理坐标在曲面上，距离分析应选合适投影或使用椭球测地算法。", "Geographic coordinates lie on a curved surface; use an appropriate projection or geodesic calculation.", "analyze"),
            ("single", 4, "sampling-theorem", "采样率为 200 Hz 时，不混叠的理论最高频率是多少？", "At a 200 Hz sampling rate, what is the theoretical highest unaliased frequency?", ["50 Hz", "100 Hz", "200 Hz", "400 Hz"], 1, "Nyquist 频率为采样率的一半；实际系统还需留出抗混叠滤波过渡带。", "The Nyquist frequency is half the sample rate, with practical margin for the anti-alias filter.", "apply"),
            ("boolean", 4, "interpolation", "判断：插值结果落在观测凸包之外时，通常仍与域内插值具有同等可信度。", "True or false: extrapolation outside the observation hull is usually as reliable as interpolation inside it.", ["错误", "正确"], 0, "域外是外推，误差会迅速增大，应显式标记覆盖范围并传播不确定性。", "Outside the observed hull is extrapolation; uncertainty grows and coverage should be explicit.", "evaluate"),
            ("case", 5, "uncertainty-propagation", "非线性模型且输入分布明显非高斯时，哪种方法更适合传播完整不确定性？", "For a nonlinear model with strongly non-Gaussian inputs, what better propagates full uncertainty?", ["只代入均值", "蒙特卡洛传播", "忽略协方差", "把标准差设为零"], 1, "从联合输入分布采样并运行模型可近似输出分布，同时保留非线性和相关结构。", "Sampling the joint input distribution and running the model approximates the output distribution with nonlinearities and dependence.", "apply"),
            ("multiple", 4, "array-storage", "大型多维科学数组采用分块存储时，块形状选择应考虑哪些因素？（多选）", "What should guide chunk-shape selection for large multidimensional arrays? Select all.", ["典型访问切片方向", "并行任务粒度", "压缩与对象存储开销", "开发者姓名长度"], [0, 1, 2], "分块应匹配访问模式和计算粒度，并平衡压缩率、请求次数与内存。", "Chunks should match access and compute patterns while balancing compression, requests, and memory.", "analyze"),
            ("fill", 3, "data-format", "填写常用于带维度、坐标和属性的自描述科学数组格式名称。", "Enter a self-describing format commonly used for scientific arrays with dimensions and attributes.", [], ["netcdf", "netcdf4", "hdf5"], "NetCDF / HDF5", "NetCDF 与 HDF5 支持结构化元数据和大型数组；具体选择取决于生态与并发需求。", "NetCDF and HDF5 support structured metadata and large arrays; ecosystem and concurrency guide the choice.", "remember"),
            ("single", 5, "iterative-solvers", "大型稀疏线性系统使用 Krylov 迭代法收敛缓慢时，常见优先改进是什么？", "What commonly improves slow Krylov convergence for a large sparse linear system?", ["把矩阵转成图片", "设计合适的预条件器", "删除收敛判据", "固定只迭代两次"], 1, "预条件器改善谱性质，可显著减少迭代次数；同时应监控真实残差。", "A suitable preconditioner improves spectral properties and can greatly reduce iterations.", "analyze"),
            ("case", 5, "workflow-scheduling", "数百个科研任务存在 DAG 依赖且部分失败可重试，可靠调度器必须保存什么？", "Hundreds of scientific tasks form a DAG and may retry. What must a reliable scheduler persist?", ["仅当前页面颜色", "任务输入指纹、依赖状态、尝试记录和产物引用", "只保存成功数量", "每次随机改变依赖"], 1, "持久化状态使任务可恢复、幂等重试并追踪每个产物来自哪次执行。", "Persistent fingerprints, dependency state, attempts, and artifact references enable recovery and traceability.", "evaluate"),
        ],
    }

    generated: list[dict[str, Any]] = []
    for category, rows in specs.items():
        for concept_index, row in enumerate(rows, start=1):
            if len(row) == 11:
                (
                    question_type,
                    difficulty,
                    skill,
                    prompt_zh,
                    prompt_en,
                    choices,
                    answer,
                    answer_label,
                    explanation_zh,
                    explanation_en,
                    cognitive,
                ) = row
            else:
                (
                    question_type,
                    difficulty,
                    skill,
                    prompt_zh,
                    prompt_en,
                    choices,
                    answer,
                    explanation_zh,
                    explanation_en,
                    cognitive,
                ) = row
                answer_label = str(answer[0]) if isinstance(answer, list) and answer else str(answer)
            for variant_index, (context_zh, context_en) in enumerate(contexts, start=1):
                question_id = f"advanced-{category}-{concept_index:02d}-{variant_index:02d}"
                zh = f"【{context_zh} {variant_index:02d}】{prompt_zh}"
                en = f"[{context_en} {variant_index:02d}] {prompt_en}"
                if question_type in {"fill", "numeric"}:
                    item = _fill(
                        question_id,
                        category,
                        difficulty,
                        zh,
                        en,
                        list(answer),
                        answer_label,
                        explanation_zh,
                        explanation_en,
                        question_type=question_type,
                        skill=skill,
                        cognitive=cognitive,
                        estimated_minutes=3 if difficulty >= 4 else 2,
                        tags=[category, skill, "advanced"],
                    )
                else:
                    item = _single(
                        question_id,
                        category,
                        difficulty,
                        zh,
                        en,
                        choices,
                        answer,
                        explanation_zh,
                        explanation_en,
                        question_type=question_type,
                        skill=skill,
                        cognitive=cognitive,
                        estimated_minutes=4 if difficulty == 5 else 3,
                        tags=[category, skill, "advanced"],
                    )
                item["sourceKind"] = "parameterized"
                item["variant"] = variant_index
                generated.append(item)
    return generated


QUESTIONS = _base_questions() + _generated_questions() + _special_questions() + _advanced_questions()
QUESTION_BY_ID = {item["id"]: item for item in QUESTIONS}


def _public_question(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "versionId": item["versionId"],
        "category": item["category"],
        "difficulty": item["difficulty"],
        "type": item["type"],
        "prompt": item["prompt"],
        "choices": item["choices"],
        "skill": item.get("skill", item["category"]),
        "cognitiveLevel": item.get("cognitiveLevel", "apply"),
        "estimatedMinutes": item.get("estimatedMinutes", 2),
        "tags": item.get("tags", [item["category"]]),
        "sourceKind": item.get("sourceKind", "original"),
        "variant": item.get("variant", 1),
    }


def _question_label(item: dict[str, Any]) -> Any:
    if item["type"] in {"fill", "numeric"}:
        return item["answerLabel"]
    answer = item["answer"]
    if isinstance(answer, list):
        return {
            "zh": "、".join(item["choices"][index]["zh"] for index in answer),
            "en": ", ".join(item["choices"][index]["en"] for index in answer),
        }
    return item["choices"][answer]


def _normalize_fill(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().casefold())


def _is_correct(item: dict[str, Any], selected: Any) -> bool:
    if item["type"] in {"fill", "numeric"}:
        return _normalize_fill(selected) in {_normalize_fill(value) for value in item["accepted"]}
    if item["type"] in {"multiple", "ordering"}:
        if not isinstance(selected, list):
            return False
        try:
            normalized = [int(value) for value in selected]
            if item["type"] == "ordering":
                return normalized == item["answer"]
            return sorted(set(normalized)) == sorted(item["answer"])
        except (TypeError, ValueError):
            return False
    try:
        return int(selected) == int(item["answer"])
    except (TypeError, ValueError):
        return False


def _validate_selection(item: dict[str, Any], selected: Any) -> None:
    if item["type"] in {"fill", "numeric"}:
        if not str(selected or "").strip():
            raise ToolError("请填写答案")
        if len(str(selected)) > 200:
            raise ToolError("填空答案过长")
        return
    if item["type"] in {"multiple", "ordering"}:
        if not isinstance(selected, list) or not selected:
            raise ToolError("请至少选择一个答案")
        indices = selected
    else:
        indices = [selected]
    try:
        normalized = [int(value) for value in indices]
    except (TypeError, ValueError) as exc:
        raise ToolError("选项编号无效") from exc
    if any(value < 0 or value >= len(item["choices"]) for value in normalized):
        raise ToolError("选项编号超出范围")
    if item["type"] == "ordering" and len(set(normalized)) != len(item["choices"]):
        raise ToolError("排序题需要排列全部选项")


def _default_state() -> dict[str, Any]:
    return {
        "bankId": BANK_ID,
        "bankVersionId": BANK_VERSION_ID,
        "practiceSession": {
            "id": f"practice-{uuid.uuid4().hex[:12]}",
            "answers": {},
            "attempts": [],
            "startedAt": _iso(),
            "updatedAt": _iso(),
        },
        "favorites": [],
        "skillMastery": {},
        "reviewSchedule": {},
        "adaptiveSession": None,
        "activeExam": None,
        "examHistory": [],
        "lastExamResult": None,
    }


def _state(payload: dict[str, Any]) -> dict[str, Any]:
    source = payload.get("state")
    state = deepcopy(source) if isinstance(source, dict) else _default_state()
    state["bankId"] = BANK_ID
    state["bankVersionId"] = BANK_VERSION_ID
    if not isinstance(state.get("practiceSession"), dict):
        state["practiceSession"] = _default_state()["practiceSession"]
    state["practiceSession"].setdefault("answers", {})
    state["practiceSession"].setdefault("attempts", [])
    state["favorites"] = list(dict.fromkeys(value for value in state.get("favorites", []) if value in QUESTION_BY_ID))
    state["skillMastery"] = state.get("skillMastery", {}) if isinstance(state.get("skillMastery"), dict) else {}
    state["reviewSchedule"] = state.get("reviewSchedule", {}) if isinstance(state.get("reviewSchedule"), dict) else {}
    if state.get("adaptiveSession") is not None and not isinstance(state.get("adaptiveSession"), dict):
        state["adaptiveSession"] = None
    state["examHistory"] = state.get("examHistory", []) if isinstance(state.get("examHistory"), list) else []
    if state.get("lastExamResult") is not None and not isinstance(state.get("lastExamResult"), dict):
        state["lastExamResult"] = None
    return state


def _stats(state: dict[str, Any]) -> dict[str, Any]:
    answers = state["practiceSession"].get("answers", {})
    attempted = [answer for question_id, answer in answers.items() if question_id in QUESTION_BY_ID and isinstance(answer, dict)]
    correct = sum(bool(answer.get("correct")) for answer in attempted)
    category_rows = []
    for category, _zh, _en in TOPICS:
        total = sum(item["category"] == category for item in QUESTIONS)
        category_answers = [answer for question_id, answer in answers.items() if QUESTION_BY_ID.get(question_id, {}).get("category") == category and isinstance(answer, dict)]
        category_correct = sum(bool(answer.get("correct")) for answer in category_answers)
        attempts = sum(1 for row in state["practiceSession"].get("attempts", []) if QUESTION_BY_ID.get(row.get("questionId", ""), {}).get("category") == category)
        category_rows.append({"category": category, "total": total, "answered": len(category_answers), "correct": category_correct, "attempts": attempts, "mastery": round(category_correct / max(1, total) * 100)})
    skill_rows = []
    for skill in sorted({item.get("skill", item["category"]) for item in QUESTIONS}):
        profile = state["skillMastery"].get(skill, {})
        skill_rows.append({
            "skill": skill,
            "rating": round(float(profile.get("rating", 1000))),
            "mastery": round(max(0, min(100, (float(profile.get("rating", 1000)) - 600) / 8))),
            "attempts": int(profile.get("attempts", 0)),
            "correct": int(profile.get("correct", 0)),
        })
    now = _now()
    due = sum(
        1 for row in state["reviewSchedule"].values()
        if isinstance(row, dict) and int(row.get("dueAt", now + 1)) <= now
    )
    return {
        "total": len(QUESTIONS),
        "answered": len(attempted),
        "correct": correct,
        "wrong": len(attempted) - correct,
        "accuracy": round(correct / len(attempted) * 100) if attempted else 0,
        "mastery": round(correct / len(QUESTIONS) * 100),
        "favorites": len(state["favorites"]),
        "categories": category_rows,
        "skills": skill_rows,
        "dueReviews": due,
        "advancedQuestions": sum(item["difficulty"] >= 4 for item in QUESTIONS),
        "examAttempts": len(state["examHistory"]),
    }


def _sign_token(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    body = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = hmac.new(TOKEN_SECRET, body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{base64.urlsafe_b64encode(signature).decode('ascii').rstrip('=')}"


def _read_token(token: Any) -> dict[str, Any]:
    value = str(token or "")
    try:
        body, encoded_signature = value.split(".", 1)
        expected = hmac.new(TOKEN_SECRET, body.encode("ascii"), hashlib.sha256).digest()
        actual = base64.urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
        if not hmac.compare_digest(expected, actual):
            raise ValueError("signature")
        decoded = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
        claims = json.loads(decoded)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ToolError("考试凭证无效或已被修改", code="EXAM_TOKEN_INVALID", status_code=409) from exc
    if claims.get("bankVersionId") != BANK_VERSION_ID:
        raise ToolError("考试题库版本不匹配", code="EXAM_BANK_VERSION_MISMATCH", status_code=409)
    return claims


def _catalog() -> dict[str, Any]:
    public = [_public_question(item) for item in QUESTIONS]
    return {
        "bank": {
            "id": BANK_ID,
            "versionId": BANK_VERSION_ID,
            "status": "published",
            "questionCount": len(public),
            "checksum": hashlib.sha256(json.dumps(public, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest(),
            "publishedAt": "2026-09-09T00:00:00Z",
        },
        "topics": [{"id": topic_id, "label": _i18n(zh, en)} for topic_id, zh, en in TOPICS],
        "questions": public,
    }


def _response(state: dict[str, Any], *, stage: str, **extra: Any) -> dict[str, Any]:
    result = {
        "schema": "skyview-daily-practice-results",
        "version": 2,
        "stage": stage,
        **_catalog(),
        "state": state,
        "stats": _stats(state),
        "runtime": {
            "controlPlane": "Go 项目、作业、版本、身份与审计",
            "assessmentEngine": "Python 题库、校验、判分与导出",
            "answerDisclosure": "练习作答后单题反馈；考试交卷后统一反馈",
            "examClock": "server",
            "examToken": "HMAC-SHA256",
            "arbitraryCodeExecution": False,
            "adaptiveModel": "Elo-style skill rating + spaced review",
        },
    }
    result.update(extra)
    return result


def _filtered_ids(payload: dict[str, Any]) -> list[str]:
    category = str(payload.get("category", "all"))
    difficulty = str(payload.get("difficulty", "all"))
    pool = [item for item in QUESTIONS if category == "all" or item["category"] == category]
    if difficulty != "all":
        try:
            level = int(difficulty)
        except ValueError as exc:
            raise ToolError("难度筛选无效") from exc
        pool = [item for item in pool if item["difficulty"] == level]
    difficulty_min = int(payload.get("difficultyMin", 1))
    difficulty_max = int(payload.get("difficultyMax", 5))
    pool = [item for item in pool if difficulty_min <= item["difficulty"] <= difficulty_max]
    requested_types = payload.get("types")
    if isinstance(requested_types, list) and requested_types:
        allowed_types = {str(value) for value in requested_types}
        pool = [item for item in pool if item["type"] in allowed_types]
    return [item["id"] for item in pool]


def _update_learning_model(state: dict[str, Any], item: dict[str, Any], correct: bool) -> None:
    skill = item.get("skill", item["category"])
    profile = state["skillMastery"].setdefault(skill, {"rating": 1000, "attempts": 0, "correct": 0, "streak": 0})
    rating = float(profile.get("rating", 1000))
    target = 700 + int(item["difficulty"]) * 180
    expected = 1 / (1 + 10 ** ((target - rating) / 400))
    profile["rating"] = round(max(600, min(1800, rating + 48 * (int(correct) - expected))))
    profile["attempts"] = int(profile.get("attempts", 0)) + 1
    profile["correct"] = int(profile.get("correct", 0)) + int(correct)
    profile["streak"] = int(profile.get("streak", 0)) + 1 if correct else 0
    profile["updatedAt"] = _iso()

    previous = state["reviewSchedule"].get(item["id"], {})
    repetitions = int(previous.get("repetitions", 0))
    ease = float(previous.get("ease", 2.5))
    if correct:
        repetitions += 1
        interval = 1 if repetitions == 1 else 3 if repetitions == 2 else round(max(4, float(previous.get("intervalDays", 3)) * ease))
        ease = min(3.0, ease + 0.05)
    else:
        repetitions = 0
        interval = 0
        ease = max(1.3, ease - 0.2)
    state["reviewSchedule"][item["id"]] = {
        "questionId": item["id"],
        "repetitions": repetitions,
        "intervalDays": interval,
        "ease": round(ease, 2),
        "dueAt": _now() + interval * 86400,
        "lastReviewedAt": _iso(),
    }


def _build_adaptive_session(payload: dict[str, Any]) -> dict[str, Any]:
    state = _state(payload)
    mode = str(payload.get("mode", "adaptive"))
    if mode not in {"adaptive", "weak", "review", "challenge"}:
        raise ToolError("自适应模式无效")
    count = max(5, min(50, int(payload.get("count", 20))))
    category = str(payload.get("category", "all"))
    now = _now()
    candidates = [item for item in QUESTIONS if category == "all" or item["category"] == category]
    if mode == "challenge":
        candidates = [item for item in candidates if item["difficulty"] >= 4]
    answers = state["practiceSession"]["answers"]

    def recommendation_score(item: dict[str, Any]) -> float:
        profile = state["skillMastery"].get(item.get("skill", item["category"]), {})
        rating = float(profile.get("rating", 1000))
        target = 700 + int(item["difficulty"]) * 180
        closeness = 500 - min(500, abs(rating - target))
        unseen = 260 if item["id"] not in answers else 0
        previous = answers.get(item["id"], {})
        wrong = 360 if previous and not previous.get("correct") else 0
        review = state["reviewSchedule"].get(item["id"], {})
        due = 420 if review and int(review.get("dueAt", now + 1)) <= now else 0
        advanced = item["difficulty"] * 35
        if mode == "weak":
            return wrong * 2 + (1800 - rating) + due + unseen / 4
        if mode == "review":
            return due * 3 + wrong + (0 if review else -1000)
        if mode == "challenge":
            return advanced * 3 + closeness + unseen
        return closeness + unseen + wrong + due + advanced

    candidates.sort(key=lambda item: (-recommendation_score(item), item["id"]))
    question_ids = [item["id"] for item in candidates[:count]]
    session = {
        "id": f"adaptive-{uuid.uuid4().hex[:12]}",
        "mode": mode,
        "questionIds": question_ids,
        "position": 0,
        "createdAt": _iso(),
        "modelVersion": "elo-spaced-v1",
    }
    state["adaptiveSession"] = session
    return _response(
        state,
        stage="build-adaptive-session",
        adaptive={"session": session, "questions": [_public_question(QUESTION_BY_ID[item_id]) for item_id in question_ids]},
    )


def _answer_practice(payload: dict[str, Any]) -> dict[str, Any]:
    state = _state(payload)
    question_id = str(payload.get("questionId", ""))
    item = QUESTION_BY_ID.get(question_id)
    if not item:
        raise ToolError("题目不存在")
    selected = payload.get("selected")
    _validate_selection(item, selected)
    correct = _is_correct(item, selected)
    timestamp = _iso()
    source = str(payload.get("source", "practice"))
    if source not in {"practice", "adaptive", "review"}:
        source = "practice"
    answer_record = {
        "questionId": question_id,
        "questionVersionId": item["versionId"],
        "selected": selected,
        "correct": correct,
        "source": source,
        "answeredAt": timestamp,
        "confidence": max(1, min(5, int(payload.get("confidence", 3)))),
        "elapsedSeconds": max(0, min(7200, int(payload.get("elapsedSeconds", 0)))),
        "feedback": {
            "correctAnswer": _question_label(item),
            "explanation": item["explanation"],
        },
    }
    state["practiceSession"]["answers"][question_id] = answer_record
    state["practiceSession"]["attempts"].append(answer_record)
    state["practiceSession"]["attempts"] = state["practiceSession"]["attempts"][-1000:]
    state["practiceSession"]["updatedAt"] = timestamp
    _update_learning_model(state, item, correct)
    return _response(
        state,
        stage="answer-practice",
        feedback={
            "questionId": question_id,
            "correct": correct,
            "correctAnswer": _question_label(item),
            "explanation": item["explanation"],
        },
    )


def _start_exam(payload: dict[str, Any]) -> dict[str, Any]:
    state = _state(payload)
    count = int(payload.get("count", 20))
    duration = int(payload.get("durationMinutes", 20))
    if count not in ALLOWED_COUNTS:
        raise ToolError("题量必须为 10、20、30、50、80 或 100")
    if duration not in ALLOWED_DURATIONS:
        raise ToolError("时长必须为 10、20、30、45、60、90 或 120 分钟")
    pool = _filtered_ids(payload)
    if not pool:
        raise ToolError("当前筛选没有可用题目")
    started_at = _now()
    attempt_id = f"exam-{uuid.uuid4().hex[:16]}"
    seed = int(hashlib.sha256(f"{attempt_id}:{started_at}".encode()).hexdigest()[:16], 16)
    rng = random.Random(seed)
    rng.shuffle(pool)
    if str(payload.get("category", "all")) == "all":
        buckets = {topic_id: [item_id for item_id in pool if QUESTION_BY_ID[item_id]["category"] == topic_id] for topic_id in TOPIC_IDS}
        balanced: list[str] = []
        ordered_topics = [item[0] for item in TOPICS]
        while any(buckets.values()):
            for topic_id in ordered_topics:
                if buckets[topic_id]:
                    balanced.append(buckets[topic_id].pop())
        pool = balanced
    question_ids = pool[: min(count, len(pool))]
    claims = {
        "attemptId": attempt_id,
        "bankVersionId": BANK_VERSION_ID,
        "questionIds": question_ids,
        "startedAt": started_at,
        "endsAt": started_at + duration * 60,
        "durationMinutes": duration,
        "courseId": str(payload.get("courseId", "default-course"))[:120],
        "learnerId": str(payload.get("learnerId", "current-user"))[:120],
    }
    active_exam = {
        **claims,
        "token": _sign_token(claims),
        "answers": {},
        "status": "in-progress",
        "remainingSeconds": duration * 60,
    }
    state["activeExam"] = active_exam
    return _response(state, stage="start-exam", exam={"attempt": active_exam, "questions": [_public_question(QUESTION_BY_ID[item_id]) for item_id in question_ids]})


def _resume_exam(payload: dict[str, Any]) -> dict[str, Any]:
    state = _state(payload)
    exam = state.get("activeExam")
    if not isinstance(exam, dict):
        raise ToolError("没有进行中的考试")
    claims = _read_token(exam.get("token"))
    if claims["attemptId"] != exam.get("attemptId"):
        raise ToolError("考试记录与凭证不匹配", code="EXAM_TOKEN_INVALID", status_code=409)
    remaining = max(0, int(claims["endsAt"]) - _now())
    exam["remainingSeconds"] = remaining
    if remaining == 0:
        return _submit_exam({**payload, "state": state, "autoSubmit": True})
    return _response(state, stage="resume-exam", exam={"attempt": exam, "questions": [_public_question(QUESTION_BY_ID[item_id]) for item_id in claims["questionIds"]]})


def _save_exam_answer(payload: dict[str, Any]) -> dict[str, Any]:
    state = _state(payload)
    exam = state.get("activeExam")
    if not isinstance(exam, dict):
        raise ToolError("没有进行中的考试")
    claims = _read_token(exam.get("token"))
    if _now() >= int(claims["endsAt"]):
        return _submit_exam({**payload, "state": state, "autoSubmit": True})
    question_id = str(payload.get("questionId", ""))
    if question_id not in claims["questionIds"]:
        raise ToolError("题目不属于当前试卷")
    item = QUESTION_BY_ID[question_id]
    selected = payload.get("selected")
    _validate_selection(item, selected)
    exam["answers"][question_id] = {"selected": selected, "savedAt": _iso()}
    exam["remainingSeconds"] = max(0, int(claims["endsAt"]) - _now())
    return _response(state, stage="save-exam-answer", exam={"attempt": exam, "questions": [_public_question(QUESTION_BY_ID[item_id]) for item_id in claims["questionIds"]]})


def _submit_exam(payload: dict[str, Any]) -> dict[str, Any]:
    state = _state(payload)
    exam = state.get("activeExam")
    if not isinstance(exam, dict):
        raise ToolError("没有进行中的考试")
    claims = _read_token(exam.get("token"))
    if claims["attemptId"] != exam.get("attemptId"):
        raise ToolError("考试记录与凭证不匹配", code="EXAM_TOKEN_INVALID", status_code=409)
    answers = exam.get("answers", {}) if isinstance(exam.get("answers"), dict) else {}
    review = []
    score = 0
    finished_at = _now()
    for question_id in claims["questionIds"]:
        item = QUESTION_BY_ID[question_id]
        selected = answers.get(question_id, {}).get("selected")
        correct = _is_correct(item, selected)
        score += int(correct)
        review.append({
            "questionId": question_id,
            "selected": selected,
            "correct": correct,
            "correctAnswer": _question_label(item),
            "explanation": item["explanation"],
        })
        if question_id in answers:
            state["practiceSession"]["answers"][question_id] = {
                "questionId": question_id,
                "questionVersionId": item["versionId"],
                "selected": selected,
                "correct": correct,
                "source": "exam",
                "answeredAt": _iso(finished_at),
            }
            _update_learning_model(state, item, correct)
    total = len(claims["questionIds"])
    result = {
        "attemptId": claims["attemptId"],
        "bankVersionId": BANK_VERSION_ID,
        "score": score,
        "total": total,
        "rate": round(score / max(1, total) * 100),
        "answered": len(answers),
        "startedAt": _iso(int(claims["startedAt"])),
        "finishedAt": _iso(finished_at),
        "durationSeconds": max(0, min(finished_at, int(claims["endsAt"])) - int(claims["startedAt"])),
        "autoSubmitted": bool(payload.get("autoSubmit")) or finished_at >= int(claims["endsAt"]),
        "review": review,
    }
    state["examHistory"].insert(0, {key: value for key, value in result.items() if key != "review"})
    state["examHistory"] = state["examHistory"][:50]
    state["lastExamResult"] = result
    state["activeExam"] = None
    state["practiceSession"]["updatedAt"] = _iso(finished_at)
    return _response(state, stage="submit-exam", examResult=result)


def _toggle_favorite(payload: dict[str, Any]) -> dict[str, Any]:
    state = _state(payload)
    question_id = str(payload.get("questionId", ""))
    if question_id not in QUESTION_BY_ID:
        raise ToolError("题目不存在")
    if question_id in state["favorites"]:
        state["favorites"].remove(question_id)
        favorite = False
    else:
        state["favorites"].append(question_id)
        favorite = True
    return _response(state, stage="toggle-favorite", favorite={"questionId": question_id, "active": favorite})


def _export(state: dict[str, Any]) -> dict[str, str]:
    stats = _stats(state)
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["题目ID", "题目版本", "分类", "难度", "作答", "是否正确", "来源", "作答时间"])
    for question_id, answer in state["practiceSession"].get("answers", {}).items():
        item = QUESTION_BY_ID.get(question_id)
        if not item or not isinstance(answer, dict):
            continue
        writer.writerow([question_id, item["versionId"], item["category"], item["difficulty"], json.dumps(answer.get("selected"), ensure_ascii=False), "是" if answer.get("correct") else "否", answer.get("source", "practice"), answer.get("answeredAt", "")])
    markdown = f"# 日常做题学习报告\n\n- 题库版本：{BANK_VERSION_ID}\n- 已完成：{stats['answered']}/{stats['total']}\n- 正确题数：{stats['correct']}\n- 正确率：{stats['accuracy']}%\n- 模拟考试：{stats['examAttempts']} 次\n"
    skill_output = io.StringIO()
    skill_writer = csv.writer(skill_output, lineterminator="\n")
    skill_writer.writerow(["能力点", "掌握度", "能力评分", "作答次数", "答对次数"])
    for row in stats["skills"]:
        skill_writer.writerow([row["skill"], row["mastery"], row["rating"], row["attempts"], row["correct"]])
    qti_items = []
    for item in QUESTIONS:
        prompt = html.escape(item["prompt"]["zh"])
        qti_items.append(f'<assessmentItem identifier="{html.escape(item["id"])}" title="{prompt}" adaptive="false" timeDependent="false"/>')
    qti = '<?xml version="1.0" encoding="UTF-8"?>\n<assessmentTest xmlns="http://www.imsglobal.org/xsd/imsqtiasi_v3p0" identifier="skyview-daily-practice">\n' + "\n".join(qti_items) + "\n</assessmentTest>\n"
    backup = {"schema": "skyview-daily-practice-backup", "version": 2, "exportedAt": _iso(), "state": state, "stats": stats}
    return {
        "answersCsv": output.getvalue(),
        "skillCsv": skill_output.getvalue(),
        "reportMarkdown": markdown,
        "backupJson": json.dumps(backup, ensure_ascii=False, indent=2),
        "qtiXml": qti,
    }


def _validate_bank(payload: dict[str, Any]) -> dict[str, Any]:
    draft = payload.get("questions")
    if not isinstance(draft, list):
        raise ToolError("questions 必须是题目数组")
    issues = []
    seen: set[str] = set()
    for index, item in enumerate(draft):
        if not isinstance(item, dict):
            issues.append({"index": index, "level": "error", "message": "题目必须是对象"})
            continue
        question_id = str(item.get("id", "")).strip()
        if not question_id:
            issues.append({"index": index, "level": "error", "message": "缺少题目 ID"})
        elif question_id in seen:
            issues.append({"index": index, "level": "error", "message": "题目 ID 重复"})
        seen.add(question_id)
        if item.get("type") not in {"single", "multiple", "boolean", "fill", "numeric", "ordering", "case"}:
            issues.append({"index": index, "level": "error", "message": "题型不受支持"})
        if item.get("category") not in TOPIC_IDS:
            issues.append({"index": index, "level": "error", "message": "分类不受支持"})
        if item.get("difficulty") not in {1, 2, 3, 4, 5}:
            issues.append({"index": index, "level": "error", "message": "难度必须为 1–5"})
    return {"valid": not any(item["level"] == "error" for item in issues), "questionCount": len(draft), "issues": issues, "checkedAt": _iso()}


def _legacy_grade(payload: dict[str, Any]) -> dict[str, Any]:
    expected = [line.strip().casefold() for line in str(payload.get("expected", "")).splitlines() if line.strip()]
    answers = [line.strip().casefold() for line in str(payload.get("answers", "")).splitlines()]
    if not expected:
        raise ToolError("expected 不能为空")
    details = [{"index": index + 1, "correct": index < len(answers) and answers[index] == value} for index, value in enumerate(expected)]
    correct = sum(item["correct"] for item in details)
    return {"correct": correct, "total": len(expected), "percent": round(correct / len(expected) * 100), "details": details}


def run_daily_practice(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "grade":
        return _legacy_grade(payload)
    if action in {"load-sample", "run-all"}:
        state = _default_state()
        return _response(state, stage=action, exports=_export(state))
    if action == "upgrade-bank":
        previous_version = payload.get("state", {}).get("bankVersionId") if isinstance(payload.get("state"), dict) else None
        state = _state(payload)
        if previous_version != BANK_VERSION_ID:
            state["activeExam"] = None
        return _response(state, stage=action, exports=_export(state))
    if action == "answer-practice":
        return _answer_practice(payload)
    if action == "build-adaptive-session":
        return _build_adaptive_session(payload)
    if action == "toggle-favorite":
        return _toggle_favorite(payload)
    if action == "start-exam":
        return _start_exam(payload)
    if action == "save-exam-answer":
        return _save_exam_answer(payload)
    if action == "resume-exam":
        return _resume_exam(payload)
    if action == "submit-exam":
        return _submit_exam(payload)
    if action == "reset-progress":
        state = _default_state()
        return _response(state, stage=action, exports=_export(state))
    if action == "export":
        state = _state(payload)
        return _response(state, stage=action, exports=_export(state))
    if action == "validate-bank":
        return _validate_bank(payload)
    raise ToolError("不支持的日常做题操作")
