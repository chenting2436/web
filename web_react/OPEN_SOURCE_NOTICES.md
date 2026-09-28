# React 界面开源参考

本项目的 React 代码为 SkyViewLab 重写代码。迁移时参考了以下开源产品的工作流和信息架构，不使用其名称冒充对应服务，也不复制其品牌资源：

- JupyterLab：文档/运行区、侧边栏与活动记录的工作区组织方式。https://github.com/jupyterlab/jupyterlab
- OpenRefine：数据画像、可回放清洗步骤与撤销/重做的工作流。https://github.com/OpenRefine/OpenRefine
- Plane：项目、状态、任务与协作视图的组织方式。https://github.com/makeplane/plane
- Judge0 与 Judge0 IDE：编辑、运行、评测结果和判题状态的工作流。https://github.com/judge0/judge0 与 https://github.com/judge0/ide
- Apache NiFi：处理器、连接、质量门禁和数据溯源概念。https://github.com/apache/nifi
- Dagster：研究流程中的资产、依赖、运行与重试概念。https://github.com/dagster-io/dagster
- Zotero：文献集合、来源元数据和引用记录的组织方式。https://github.com/zotero/zotero
- WebLLM：浏览器 WebGPU / Web Worker 本地模型生命周期与 OpenAI 兼容生成接口。前端固定使用 `@mlc-ai/web-llm@0.2.85`，模型仅在用户主动启用后下载；部署方仍需独立核验所选模型许可证。https://github.com/mlc-ai/web-llm
- RAGFlow：材料解析、稳定分块、检索、引用和人工复核工作流的架构参考；本项目未复制其品牌资源或服务端实现。https://github.com/infiniflow/ragflow
- 2EZ-exam：Python 技术英语课程的信息架构与考试交互参考，固定参考提交 `333427c5080ddbebb8d70198df653173876fb0f9`。SkyViewLab 保留旧卡片版自有课程内容，使用 React、Go 与 Python clean-room 重写，不嵌入上游品牌或运行服务。https://github.com/dvrone/2EZ-exam

## AI+专利交底书工作台

该工作台基于 MIT 许可对 `Dyp130/Patent-assistant` 的工作流进行 React、Go 与 Python 等价重写，固定参考提交为 `7123187a1e071b402c4e87ff6d2ce8d1aff825e4`。版权与许可全文保存在 [`vendor/patent-assistant/LICENSE.txt`](vendor/patent-assistant/LICENSE.txt)，来源和改写边界保存在 [`vendor/patent-assistant/SOURCE.md`](vendor/patent-assistant/SOURCE.md)。

旧仓库中原有第三方库、许可证和版本记录仍保存在 [`../SkyViewLab-Internal-push-worktree/OPEN_SOURCE_NOTICES.md`](../SkyViewLab-Internal-push-worktree/OPEN_SOURCE_NOTICES.md)。将旧版第三方运行时重新引入 React 或后端时，应同时迁移对应许可证和 NOTICE。
