package store

import "skyviewlab/backend_go/internal/model"

const seedUpdatedAt = "2026-09-07T00:00:00Z"

type MemoryStore struct {
	workbenches []model.Workbench
	bySlug      map[string]model.Workbench
}

func NewMemoryStore() *MemoryStore {
	items := []model.Workbench{
		workbench("research-paper-writing", "paper-writing", "论文研究与写作", "从研究问题、证据与实验记录出发，形成可审阅、可修订的论文交付流程。", "prototype", true),
		workbench("research-disaster-remote-sensing", "disaster-remote-sensing", "灾害遥感损毁评估", "处理多时相遥感材料，记录损毁候选、分区影响和独立验证结果。", "prototype", true),
		workbench("research-seismic-physics", "seismic-physics", "地震与物理分析", "面向波形、频谱、震相与事件目录的轻量分析工作台。", "prototype", true),
		workbench("research-patent-transfer", "patent-transfer", "专利转化", "连接发明披露、现有技术、权利要求、成熟度和转化风险。", "prototype", true),
		workbench("research-skill-evolution", "skill-evolution", "Skill 进化", "管理能力规格、工作流、评测、安全检查与语义化发布。", "prototype", true),
		workbench("research-automation", "research-automation", "研究自动化", "编排研究步骤、依赖、变量和重试策略，并保留运行轨迹。", "prototype", true),
		workbench("research-knowledge-system", "knowledge-system", "个人知识系统", "将本地研究材料组织为可检索、可引用、可持续维护的知识库。", "prototype", true),
		workbench("research-radar", "research-radar", "研究雷达", "追踪研究主题、筛选文献、建立证据矩阵并维护监测基线。", "prototype", true),
		workbench("research-mine-safety-radar", "mine-safety-radar", "AI+矿山安全研究雷达", "按照矿山安全领域分类追踪方法、验证场景与工程就绪度信号。", "prototype", true),
		workbench("research-flac3d-slope-stability", "flac3d-slope-stability", "边坡数值分析", "通过网页运行快速验算与服务端有限元计算，复核安全系数、塑性区和位移场。", "prototype", true),
		workbench("research-scientific-animation-studio", "scientific-animation-studio", "科学动画工作室", "用场景、时间轴、数据绑定和可复核脚本制作数学与科学解释动画。", "prototype", true),
		workbench("engineering-data-gateway", "data-gateway", "数据网关", "用可视化数据流组织采集、清洗、质量门禁、路由和数据溯源。", "prototype", true),
		workbench("engineering-ambient-noise-imaging", "ambient-noise-imaging", "面波背景噪声成像", "从多通道波形到互相关、频散拾取和网格成像的完整分析链。", "prototype", true),
		workbench("engineering-patent-disclosure", "patent-disclosure", "AI 专利交底书", "从核心构思到十章节交底书、核验和版本交付。", "prototype", true),
		workbench("engineering-warning-platform", "warning-platform", "灾害监测预警平台", "整合监测指标、阈值、事件和处置记录，支持连续风险研判。", "prototype", true),
		workbench("engineering-uav-inspection", "uav-inspection", "无人机巡检", "组织航线、巡检影像、异常点和复核任务，服务工程现场管理。", "prototype", true),
		workbench("engineering-fusion-console", "fusion-console", "多源监测融合", "对齐不同来源的监测数据，在统一时间线上形成可解释的研判线索。", "prototype", true),
		workbench("engineering-emergency-console", "emergency-console", "应急研判中心", "汇集事件态势、证据、任务和关键决策，形成协同处置记录。", "prototype", true),
		workbench("teaching-python-lab", "python-lab", "Python 编译器", "面向课程实验的代码编辑、运行反馈与学习记录界面。", "prototype", true),
		workbench("teaching-daily-practice", "daily-practice", "日常做题", "用多题型练习、计时测验和错题回顾支持稳定学习节奏。", "prototype", true),
		workbench("teaching-project-workspace", "project-workspace", "在线项目开发", "以看板、里程碑和时间线组织课程项目的推进过程。", "prototype", true),
		workbench("teaching-data-lab", "data-lab", "数据清洗工作台", "在浏览器中完成字段分析、筛选、清洗、撤销和结果导出。", "prototype", true),
		workbench("teaching-ai-report", "ai-report", "AI 辅助解释与报告", "围绕已选材料生成带来源定位的解释、报告和验证记录。", "prototype", true),
		workbench("teaching-python-english", "python-english", "Python English", "通过词汇、闪卡、测验、发音和打字模式学习编程英语。", "prototype", true),
		workbench("teaching-ai-assessment", "ai-assessment", "AI 测试与提交", "面向多语言任务的公开测试、隐藏测试、诊断与提交历史。", "prototype", true),
		workbench("teaching-project-submission", "project-submission", "项目提交", "整理项目目录、校验文件并生成便于教学审核的提交包。", "security-blocked", false),
	}

	bySlug := make(map[string]model.Workbench, len(items))
	for _, item := range items {
		bySlug[item.Slug] = item
	}
	return &MemoryStore{workbenches: items, bySlug: bySlug}
}

func workbench(id, slug, title, description, status string, executionAllowed bool) model.Workbench {
	return model.Workbench{
		ID:               id,
		Slug:             slug,
		Title:            title,
		Description:      description,
		UpdatedAt:        seedUpdatedAt,
		Status:           status,
		ExecutionAllowed: executionAllowed,
		State:            map[string]any{},
	}
}

func (store *MemoryStore) List(page, pageSize int) model.Paginated[model.WorkbenchSummary] {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 1
	}
	total := len(store.workbenches)
	start := total
	// Check the requested page against the finite collection before doing
	// multiplication. A very large, otherwise valid page value must produce an
	// empty page instead of overflowing int and becoming a negative slice index.
	if page == 1 {
		start = 0
	} else if page-1 <= total/pageSize {
		start = (page - 1) * pageSize
		if start > total {
			start = total
		}
	}
	end := total
	if pageSize < total-start {
		end = start + pageSize
	}

	items := make([]model.WorkbenchSummary, 0, end-start)
	for _, item := range store.workbenches[start:end] {
		items = append(items, model.WorkbenchSummary{
			ID: item.ID, Slug: item.Slug, Title: item.Title, UpdatedAt: item.UpdatedAt,
			Status: item.Status, ExecutionAllowed: item.ExecutionAllowed,
		})
	}
	return model.Paginated[model.WorkbenchSummary]{
		Items: items, Page: page, PageSize: pageSize, Total: total,
	}
}

func (store *MemoryStore) Get(slug string) (model.Workbench, bool) {
	item, ok := store.bySlug[slug]
	return item, ok
}

// ExecutableSlugs returns the exact built-in dispatch catalog in stable order.
// It is used only to construct an explicitly tenant/workspace-bound development
// worker scope; production worker scopes always come from the credential file.
func (store *MemoryStore) ExecutableSlugs() []string {
	result := make([]string, 0, len(store.workbenches))
	for _, item := range store.workbenches {
		if item.ExecutionAllowed {
			result = append(result, item.Slug)
		}
	}
	return result
}
