export type SectionKey = 'research' | 'engineering' | 'teaching';

export type Workbench = {
  slug: string;
  section: SectionKey;
  title: string;
  description: string;
  image: string;
  tags: string[];
  capabilities: string[];
};

export type DeliveryStatus = 'prototype' | 'planned' | 'security-blocked';

export type WorkbenchReadiness = {
  status: DeliveryStatus;
  label: string;
  summary: string;
  executionAllowed: boolean;
};

export type PlatformSection = {
  key: SectionKey;
  eyebrow: string;
  title: string;
  description: string;
};

export const sections: Record<SectionKey, PlatformSection> = {
  research: {
    key: 'research',
    eyebrow: '科研能力地图',
    title: '科研成果与研究工作台',
    description: '论文、遥感、地震、专利与知识系统工具。',
  },
  engineering: {
    key: 'engineering',
    eyebrow: '工程工具与交付',
    title: '工程与产业化',
    description: '监测、数据治理、风险识别与现场研判工具。',
  },
  teaching: {
    key: 'teaching',
    eyebrow: '项目式学习',
    title: '课程与教学工具',
    description: '编程、数据处理、项目实践与评测工具。',
  },
};

export const workbenches: Workbench[] = [
  {
    slug: 'paper-writing',
    section: 'research',
    title: '论文研究与写作',
    description: '从研究问题、证据与实验记录出发，形成可审阅、可修订的论文交付流程。',
    image: '/assets/images/function-cards/paper-writing.jpg',
    tags: ['证据链', '版本审阅'],
    capabilities: ['研究问题与方法记录', '引用证据与主张关联', '多轮审阅与交付导出'],
  },
  {
    slug: 'disaster-remote-sensing',
    section: 'research',
    title: '灾害遥感损毁评估',
    description: '处理多时相遥感材料，记录损毁候选、分区影响和独立验证结果。',
    image: '/assets/images/function-cards/remote-sensing.jpg',
    tags: ['遥感', '损毁评估'],
    capabilities: ['影像与网格质量检查', '多时相变化分析', '证据化评估报告'],
  },
  {
    slug: 'seismic-physics',
    section: 'research',
    title: '地震与物理分析',
    description: '面向波形、频谱、震相与事件目录的轻量分析工作台。',
    image: '/assets/images/function-cards/seismic-analysis.jpg',
    tags: ['波形', '频谱'],
    capabilities: ['波形预处理', 'STA/LTA 事件检测', '震相与事件目录管理'],
  },
  {
    slug: 'patent-transfer',
    section: 'research',
    title: '专利转化',
    description: '连接发明披露、现有技术、权利要求、成熟度和转化风险。',
    image: '/assets/images/function-cards/patent-licensing.jpg',
    tags: ['知识产权', '成果转化'],
    capabilities: ['发明披露结构化', '现有技术对比矩阵', 'TRL 与转化风险检查'],
  },
  {
    slug: 'skill-evolution',
    section: 'research',
    title: 'Skill 进化',
    description: '管理能力规格、工作流、评测、安全检查与语义化发布。',
    image: '/assets/images/function-cards/skill-evolution.jpg',
    tags: ['Agent Skills', '评测'],
    capabilities: ['输入输出契约', '基线与回归评测', '安全扫描和发布门禁'],
  },
  {
    slug: 'research-automation',
    section: 'research',
    title: '研究自动化',
    description: '编排研究步骤、依赖、变量和重试策略，并保留运行轨迹。',
    image: '/assets/images/function-cards/research-automation.jpg',
    tags: ['工作流', '自动化'],
    capabilities: ['流程模板与依赖校验', '运行变量和重试策略', '节点日志与历史记录'],
  },
  {
    slug: 'knowledge-system',
    section: 'research',
    title: '个人知识系统',
    description: '将本地研究材料组织为可检索、可引用、可持续维护的知识库。',
    image: '/assets/images/function-cards/knowledge-system.jpg',
    tags: ['知识库', '检索'],
    capabilities: ['多格式材料入库', '混合检索与来源定位', '知识库备份与恢复'],
  },
  {
    slug: 'research-radar',
    section: 'research',
    title: '研究雷达',
    description: '追踪研究主题、筛选文献、建立证据矩阵并维护监测基线。',
    image: '/assets/images/function-cards/research-radar.jpg',
    tags: ['文献发现', '趋势'],
    capabilities: ['跨来源文献发现', '筛选与集合管理', '趋势和证据矩阵'],
  },
  {
    slug: 'mine-safety-radar',
    section: 'research',
    title: 'AI+矿山安全研究雷达',
    description: '按照矿山安全领域分类追踪方法、验证场景与工程就绪度信号。',
    image: '/assets/images/function-cards/mine-safety.jpg',
    tags: ['矿山安全', 'AI'],
    capabilities: ['领域分类与主题识别', '工程就绪度信号', '研究证据汇总'],
  },
  {
    slug: 'flac3d-slope-stability',
    section: 'research',
    title: '边坡数值分析',
    description: '网页端完成快速验算，并向二维、三维有限元计算节点提交精细分析任务。',
    image: '/assets/images/function-cards/flac3d-slope-stability.png',
    tags: ['边坡稳定', '有限元'],
    capabilities: ['三维几何与本构参数', '强度折减与运行编排', '塑性区、位移场和交付导出'],
  },
  {
    slug: 'scientific-animation-studio',
    section: 'research',
    title: '科学动画工作室',
    description: '用场景、时间轴、数据绑定和可复核脚本制作数学与科学解释动画。',
    image: '/assets/images/function-cards/scientific-animation-studio.svg',
    tags: ['科学可视化', '动画'],
    capabilities: ['场景与时间轴编排', '数据驱动动画与逐帧检查', 'ManimGL 脚本和工程包交付'],
  },
  {
    slug: 'data-gateway',
    section: 'engineering',
    title: '数据网关',
    description: '用可视化数据流组织采集、清洗、质量门禁、路由和数据溯源。',
    image: '/assets/images/function-cards/data-gateway.jpg',
    tags: ['DataFlow', '数据治理'],
    capabilities: ['处理器与连接编排', '质量门禁和条件路由', '数据溯源与重放'],
  },
  {
    slug: 'ambient-noise-imaging',
    section: 'engineering',
    title: '面波背景噪声成像',
    description: '从多通道波形到互相关、频散拾取和网格成像的完整分析链。',
    image: '/assets/images/function-cards/ambient-noise-map.jpg',
    tags: ['地球物理', '成像'],
    capabilities: ['波形预处理与频谱检查', '台站对互相关', '频散拾取与网格成像'],
  },
  {
    slug: 'patent-disclosure',
    section: 'engineering',
    title: 'AI 专利交底书',
    description: '从核心构思形成十章节交底书，保留核验项和版本记录。',
    image: '/assets/images/function-cards/ai-patent-drawing.png',
    tags: ['专利交底', '版本'],
    capabilities: ['核心构思分析', '十章节生成与编辑', '核验和版本交付'],
  },
  {
    slug: 'warning-platform',
    section: 'engineering',
    title: '灾害监测预警平台',
    description: '整合监测指标、阈值、事件和处置记录，支持连续风险研判。',
    image: '/assets/images/function-cards/warning-platform.jpg',
    tags: ['监测', '预警'],
    capabilities: ['监测指标总览', '阈值与事件管理', '预警处置闭环'],
  },
  {
    slug: 'uav-inspection',
    section: 'engineering',
    title: '无人机巡检',
    description: '组织航线、巡检影像、异常点和复核任务，服务工程现场管理。',
    image: '/assets/images/function-cards/uav-inspection.jpg',
    tags: ['无人机', '巡检'],
    capabilities: ['巡检任务编排', '异常点标注', '复核与报告交付'],
  },
  {
    slug: 'fusion-console',
    section: 'engineering',
    title: '多源监测融合',
    description: '对齐不同来源的监测数据，在统一时间线上形成可解释的研判线索。',
    image: '/assets/images/function-cards/fusion-console.jpg',
    tags: ['多源数据', '融合'],
    capabilities: ['数据源接入状态', '时间线对齐', '联合指标与异常线索'],
  },
  {
    slug: 'emergency-console',
    section: 'engineering',
    title: '应急研判中心',
    description: '汇集事件态势、证据、任务和关键决策，形成协同处置记录。',
    image: '/assets/images/function-cards/emergency-operations-center.jpg',
    tags: ['应急', '协同'],
    capabilities: ['事件态势汇总', '任务与责任分配', '决策记录和复盘'],
  },
  {
    slug: 'python-lab',
    section: 'teaching',
    title: 'Python 编译器',
    description: '面向课程实验的代码编辑、运行反馈与学习记录界面。',
    image: '/assets/images/function-cards/python-compiler.jpg',
    tags: ['Python', '实验'],
    capabilities: ['代码编辑与运行', '实验材料组织', '学习记录保存'],
  },
  {
    slug: 'daily-practice',
    section: 'teaching',
    title: '日常做题',
    description: '用多题型练习、计时测验和错题回顾支持稳定学习节奏。',
    image: '/assets/images/function-cards/daily-practice.jpg',
    tags: ['题库', '测验'],
    capabilities: ['多题型练习', '计时模拟考试', '错题与尝试记录'],
  },
  {
    slug: 'project-workspace',
    section: 'teaching',
    title: '在线项目开发',
    description: '以看板、里程碑和时间线组织课程项目的推进过程。',
    image: '/assets/images/function-cards/project-development.jpg',
    tags: ['项目制学习', '协作'],
    capabilities: ['项目看板与列表', '里程碑时间线', '项目交换与归档'],
  },
  {
    slug: 'data-lab',
    section: 'teaching',
    title: '数据清洗工作台',
    description: '在浏览器中完成字段分析、筛选、清洗、撤销和结果导出。',
    image: '/assets/images/function-cards/data-processing.jpg',
    tags: ['数据清洗', '可复现'],
    capabilities: ['字段画像与分面筛选', '可回放清洗操作', '多格式结果导出'],
  },
  {
    slug: 'ai-report',
    section: 'teaching',
    title: 'AI 辅助解释与报告',
    description: '围绕已选材料生成带来源定位的解释、报告和验证记录。',
    image: '/assets/images/function-cards/ai-report.jpg',
    tags: ['AI', '证据引用'],
    capabilities: ['多格式材料管理', '材料约束问答', '报告版本与验证'],
  },
  {
    slug: 'python-english',
    section: 'teaching',
    title: 'Python 编程英语',
    description: '通过词汇、闪卡、测验、发音和打字模式学习编程英语。',
    image: '/assets/images/function-cards/python-english.jpg',
    tags: ['编程英语', '训练'],
    capabilities: ['主题词汇课程', '五种学习模式', '进度与考试记录'],
  },
  {
    slug: 'ai-assessment',
    section: 'teaching',
    title: 'AI 测试与提交',
    description: '面向多语言任务的公开测试、隐藏测试、诊断与提交历史。',
    image: '/assets/images/function-cards/ai-assessment.jpg',
    tags: ['Judge0', '评测'],
    capabilities: ['多语言任务目录', '批量测试与判题', '提交历史和诊断'],
  },
  {
    slug: 'project-submission',
    section: 'teaching',
    title: '项目提交',
    description: '整理项目目录、校验文件并生成便于教学审核的提交包。',
    image: '/assets/images/function-cards/project-submission.jpg',
    tags: ['提交', '校验'],
    capabilities: ['目录与文件检查', 'SHA-256 完整性校验', '提交包与审核记录'],
  },
];

export function getSectionWorkbenches(section: SectionKey) {
  return workbenches.filter((workbench) => workbench.section === section);
}

export function getWorkbench(slug: string) {
  return workbenches.find((workbench) => workbench.slug === slug);
}

const plannedWorkbenches = new Set<string>();

const securityBlockedWorkbenches = new Set([
  'project-submission',
]);

export function getWorkbenchReadiness(slug: string): WorkbenchReadiness {
  if (plannedWorkbenches.has(slug)) {
    return {
      status: 'planned',
      label: '规划中',
      summary: '旧版没有可迁移的完整实现，当前简化动作已停用，正在按生产蓝图从零建设。',
      executionAllowed: false,
    };
  }

  if (securityBlockedWorkbenches.has(slug)) {
    return {
      status: 'security-blocked',
      label: '安全整改中',
      summary: '高风险执行入口已冻结；隔离运行时、对象存储和权限审计通过验收后再开放。',
      executionAllowed: false,
    };
  }

  return {
    status: 'prototype',
    label: '原型',
    summary: '当前仅用于流程和交互评审，结果不作为正式科研、法律、教学评分或安全决策依据。',
    executionAllowed: true,
  };
}
