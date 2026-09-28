# 原卡片版导入导出格式与样例登记

状态：进行中。文本格式的首批合法、边界、恶意样例已冻结；需要可信生成器或真实领域数据的二进制格式仍保持待办，不能用改扩展名的伪文件代替。

| 格式族 | 使用模块 | 导入 | 导出 | 样例状态 | 生产验收要点 |
|---|---|---:|---:|---|---|
| CSV/TSV/TXT | T04、T06、R02、R04、R07/R08、E01、E02 | 是 | 是 | CSV 三类已冻结；TSV 待补 | UTF-8/BOM、引号换行、空值、科学计数、列数、公式注入 |
| JSON/JSONL | 全部复杂工作台 | 是 | 是 | JSON 三类已冻结；JSONL 待补 | schemaVersion、大小/深度、未知字段、原型键、稳定错误码 |
| XML | T04、T05 | 是 | 间接 | 三类已冻结 | 禁 DTD/外部实体/XInclude，限制节点/文本大小 |
| BibTeX | R01 | 是 | 是 | 三类已冻结 | 编码、重复 cite key、LaTeX 命令不得被执行 |
| Vocabulary JSON / Exam TXT | T06 | 是 | 否 | 合法样例已冻结；边界/恶意待补 | 题量、答案范围、重复 ID、富文本转义 |
| Python workspace/project JSON | T01、T03 | 是 | 是 | 待从旧 schema 生成三类 | 相对路径规范化、禁止软链接/绝对路径、文件数/总量 |
| Judge task/catalog/submission JSON | T07 | 管理端/历史 | 是 | 待生成三类 | hidden cases 服务端专有，导出必须剥离 |
| Project submission manifest/ZIP | T08 | 是 | 是 | archive 恶意 entry 清单已冻结；真实 ZIP 待补 | ZIP Slip/bomb/link、manifest 哈希、重复路径、病毒 |
| Markdown/HTML/LaTeX | T05、R01、E03 | 是/文本 | 是 | 待生成三类 | XSS、远程资源、公式/命令执行、导出转义 |
| DOCX/PPTX/XLS/XLSX/PDF | T04、T05、R01、E03、R06 | 是 | 部分 | 待可信生成器生成三类 | 宏、外链、嵌入对象、加密、解析炸弹、OCR 边界 |
| Knowledge database ZIP | R06 | 是 | 是 | 待按 knowledge-base.json/checksums.json 生成 | checksum、账号重绑、对象数量/体积、原文件扫描 |
| GeoTIFF/TIFF/PNG/JPEG/GeoJSON | R02 | 是 | 是 | 待真实小栅格和畸形文件 | CRS/transform/NoData/bands、像素上限、解码炸弹 |
| miniSEED 2/3 / waveform CSV | R03、E02 | 是 | 是 | 待公开许可小波形；CSV 可复用首批样例 | 采样率、单位、通道、时间、Steim、记录损坏 |
| Skill ZIP/SKILL.md/YAML/JSON | R05 | 是 | 是 | 待生成三类 | 路径、secretRef、禁止脚本自动执行、签名语义 |
| Workflow/dataflow JSON | R09、E01 | 是 | 是 | workflow 合法样例和 JSON 攻击样例已冻结 | DAG 校验、循环策略、processor allowlist、secretRef |
| Patent/project JSON、Markdown、DOCX | R04、E03 | 是/部分 | 是 | 待生成三类 | 敏感数据分级、公式/模板注入、法律批准状态 |

## 首批冻结样例

- csv/valid.csv、boundary.csv、malicious-formula.csv
- json/valid-workflow.json、boundary-unicode.json、malicious-prototype-key.json
- xml/valid.xml、boundary.xml、malicious-xxe.xml
- bibtex/valid.bib、boundary.bib、malicious-command.bib
- twoez/valid-vocabulary.json、valid-exam.txt
- security/archive-entry-manifest.json

## 验收规则

- “合法”必须往返不丢业务字段并保留编码、单位、时间与必要精度。
- “边界”必须得到确定结果，不允许崩溃、静默截断或按浏览器差异改变语义。
- “恶意”必须在产生业务副作用前拒绝，返回稳定错误码且日志不回显攻击正文。
- 所有样例记录 SHA-256、来源/生成器、许可、预期结果和允许公差；二进制样例必须能被独立工具验证。
- 隐藏判题用例、真实用户数据、密钥、真实专利/矿山敏感材料不得放入公开测试夹具。

## 尚未完成

本登记不把缺失的二进制与领域样例标成完成。Gate A 关闭前还必须补齐表中“待”项，并将每个样例接入 Go/Python/React 的导入、导出和安全回归测试。
