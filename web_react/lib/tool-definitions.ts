export type ToolField = {
  key: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'select';
  defaultValue?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
};

export type ToolAction = {
  id: string;
  label: string;
  submitLabel: string;
  fields: ToolField[];
};

export type ToolDefinition = {
  slug: string;
  actions: ToolAction[];
};

const text = (
  key: string,
  label: string,
  defaultValue = '',
  placeholder = '',
): ToolField => ({
  key,
  label,
  defaultValue,
  placeholder,
});
const area = (
  key: string,
  label: string,
  defaultValue = '',
  placeholder = '',
): ToolField => ({
  key,
  label,
  type: 'textarea',
  defaultValue,
  placeholder,
});
const number = (
  key: string,
  label: string,
  defaultValue: string,
): ToolField => ({
  key,
  label,
  type: 'number',
  defaultValue,
});
const select = (
  key: string,
  label: string,
  defaultValue: string,
  options: ToolField['options'],
): ToolField => ({
  key,
  label,
  type: 'select',
  defaultValue,
  options,
});

export const toolDefinitions: Record<string, ToolDefinition> = {
  'paper-writing': {
    slug: 'paper-writing',
    actions: [
      {
        id: 'generate-draft',
        label: '结构稿',
        submitLabel: '生成结构稿',
        fields: [
          text('title', '论文题目', '多源监测数据融合对滑坡预警准确率的影响'),
          area(
            'question',
            '研究问题',
            '不同监测源的时间对齐如何影响滑坡预警准确率？',
          ),
          area(
            'design',
            '数据与方法',
            '使用 GNSS、降雨和微震数据，以统一时间窗口对齐，并进行消融对比。',
          ),
          area(
            'sources',
            '已核验来源（每行一项）',
            'Crossref DOI: 10.xxxx/example\n现场监测记录：2026-Q3',
          ),
          area(
            'findings',
            '已核验结果（每行一项）',
            '融合模型在验证集上的误报率低于单源模型。',
          ),
        ],
      },
      {
        id: 'outline',
        label: '生成提纲',
        submitLabel: '生成',
        fields: [
          text('topic', '研究主题', '城市滑坡监测中的多源数据融合'),
          area(
            'question',
            '研究问题',
            '不同监测源的时间对齐如何影响预警准确率？',
          ),
        ],
      },
      {
        id: 'audit',
        label: '稿件检查',
        submitLabel: '检查',
        fields: [
          area(
            'manuscript',
            '稿件',
            '# 方法\n说明数据和方法。\n\n# 结果\n展示主要结果 [1]。\n\n# 讨论\n讨论不确定性。\n\n# 结论\n给出结论。',
          ),
        ],
      },
      {
        id: 'bibtex-import',
        label: 'BibTeX 证据库',
        submitLabel: '解析并去重',
        fields: [
          area(
            'bibtex',
            'BibTeX',
            '@article{Li2026,\n  title={Multi-source monitoring for slope safety},\n  author={Li, J.},\n  year={2026},\n  doi={10.1000/example}\n}',
          ),
        ],
      },
      {
        id: 'peer-review',
        label: '五角色审稿',
        submitLabel: '开始审稿',
        fields: [
          area(
            'manuscript',
            '完整稿件',
            '# 标题\n\n## 摘要\n研究摘要。\n\n## 方法\n说明数据、样本与复现方法 [1]。\n\n## 结果\n给出结果。\n\n## 讨论\n讨论局限、不确定性与替代解释。\n\n## 结论\n给出结论。',
          ),
        ],
      },
      {
        id: 'create',
        label: '建立论文项目',
        submitLabel: '建立',
        fields: [
          text('title', '论文题目'),
          text('paperType', '论文类型', 'empirical'),
        ],
      },
      {
        id: 'crossref-search',
        label: 'Crossref 真实元数据检索',
        submitLabel: '检索',
        fields: [text('query', '题名、作者或关键词')],
      },
      {
        id: 'integrity',
        label: '双阶段完整性核验',
        submitLabel: '运行核验',
        fields: [
          area('project', '项目 JSON'),
          select('phase', '核验阶段', 'pre', [
            { value: 'pre', label: '预审' },
            { value: 'final', label: '最终' },
          ]),
        ],
      },
      {
        id: 'review',
        label: '五角色审稿报告',
        submitLabel: '审稿',
        fields: [area('project', '项目 JSON')],
      },
      {
        id: 'rereview',
        label: '修订复审',
        submitLabel: '复审',
        fields: [area('project', '项目 JSON')],
      },
      {
        id: 'adopt-roadmap',
        label: '采用修订路线图',
        submitLabel: '采用',
        fields: [area('project', '项目 JSON'), text('reviewId', '审稿编号')],
      },
      {
        id: 'prepare-stage',
        label: '提交阶段检查',
        submitLabel: '检查',
        fields: [area('project', '项目 JSON'), text('stageId', '阶段')],
      },
      {
        id: 'confirm-stage',
        label: '作者确认阶段',
        submitLabel: '确认',
        fields: [
          area('project', '项目 JSON'),
          text('stageId', '阶段'),
          area('note', '作者确认说明'),
        ],
      },
      {
        id: 'snapshot',
        label: '正文快照',
        submitLabel: '保存快照',
        fields: [area('project', '项目 JSON'), text('label', '快照名称')],
      },
      {
        id: 'restore',
        label: '恢复正文快照',
        submitLabel: '恢复',
        fields: [area('project', '项目 JSON'), text('snapshotId', '快照编号')],
      },
      {
        id: 'finalize',
        label: '锁定定稿记录',
        submitLabel: '定稿',
        fields: [area('project', '项目 JSON')],
      },
      {
        id: 'export',
        label: '投稿材料包',
        submitLabel: '生成交付文件',
        fields: [area('project', '项目 JSON')],
      },
    ],
  },
  'disaster-remote-sensing': {
    slug: 'disaster-remote-sensing',
    actions: [
      {
        id: 'load-sample',
        label: '合成基准',
        submitLabel: '生成完整基准',
        fields: [],
      },
      {
        id: 'run-all',
        label: '完整分析链',
        submitLabel: '执行完整分析',
        fields: [],
      },
      {
        id: 'analyze',
        label: '变化检测与斑块',
        submitLabel: '执行分析',
        fields: [],
      },
      {
        id: 'screening',
        label: '损毁候选筛查',
        submitLabel: '执行筛查',
        fields: [],
      },
      {
        id: 'assess',
        label: '综合分区评估',
        submitLabel: '执行评估',
        fields: [],
      },
      {
        id: 'validate',
        label: '独立精度验证',
        submitLabel: '执行验证',
        fields: [],
      },
      {
        id: 'export',
        label: '成果归档',
        submitLabel: '生成交付文件',
        fields: [],
      },
      {
        id: 'describe',
        label: '栅格质量检查',
        submitLabel: '检查',
        fields: [
          area(
            'before',
            '灾前像元',
            '0.12,0.18,0.20,0.22,0.19,0.17,0.21,0.20,0.18,0.17,0.23,0.25,0.21,0.19,0.18,0.20',
          ),
          area(
            'after',
            '灾后像元',
            '0.13,0.19,0.71,0.24,0.20,0.62,0.23,0.19,0.20,0.18,0.70,0.26,0.22,0.21,0.19,0.22',
          ),
        ],
      },
      {
        id: 'change-detection',
        label: '变化检测',
        submitLabel: '计算变化',
        fields: [
          area(
            'before',
            '灾前像元',
            '0.12, 0.18, 0.20, 0.22, 0.19, 0.17, 0.21, 0.20',
          ),
          area(
            'after',
            '灾后像元',
            '0.13, 0.19, 0.71, 0.24, 0.20, 0.62, 0.23, 0.19',
          ),
          number('threshold', '变化阈值（0 为自动）', '0'),
        ],
      },
      {
        id: 'zone-assessment',
        label: '4×4 分区评估',
        submitLabel: '评估分区',
        fields: [
          area('before', '灾前像元', '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0'),
          area(
            'after',
            '灾后像元',
            '0,0.4,0,0,0.3,0.5,0,0,0,0,0.6,0,0,0,0.2,0',
          ),
          number('width', '栅格宽度', '4'),
          number('threshold', '变化阈值', '0.2'),
        ],
      },
    ],
  },
  'seismic-physics': {
    slug: 'seismic-physics',
    actions: [
      {
        id: 'smooth',
        label: '波形预处理',
        submitLabel: '平滑',
        fields: [
          area(
            'values',
            '波形采样值',
            '0,0.2,-0.1,0.1,0,0.3,-0.2,0.1,0,1.8,2.1,1.2,0.3,0.08,0.02,0,-0.1',
          ),
          number('window', '平滑窗口', '5'),
        ],
      },
      {
        id: 'spectrum',
        label: '频谱分析',
        submitLabel: '计算频谱',
        fields: [
          area('values', '波形采样值', '0,1,0,-1,0,1,0,-1,0,1,0,-1,0,1,0,-1'),
          number('sampleRate', '采样率（Hz）', '20'),
        ],
      },
      {
        id: 'detect',
        label: '事件检测',
        submitLabel: '检测',
        fields: [
          area(
            'values',
            '波形采样值',
            '0,0.02,-0.01,0.01,0,0.03,-0.02,0.01,0,0.02,0.01,-0.01,0,0.03,-0.02,0.01,0,0.02,1.8,2.1,1.2,0.3,0.08,0.02,0,-0.01,0.01,0,0.02,-0.01',
          ),
          number('sampleRate', '采样率（Hz）', '10'),
          number('sta', 'STA 窗口', '3'),
          number('lta', 'LTA 窗口', '12'),
          number('threshold', '触发阈值', '2.2'),
        ],
      },
      {
        id: 'source-distance',
        label: '震源距离',
        submitLabel: '计算距离',
        fields: [
          number('pTime', 'P 波到时（秒）', '12.4'),
          number('sTime', 'S 波到时（秒）', '19.1'),
          number('vp', 'P 波速度（km/s）', '6'),
          number('vs', 'S 波速度（km/s）', '3.5'),
        ],
      },
    ],
  },
  'patent-transfer': {
    slug: 'patent-transfer',
    actions: [
      {
        id: 'claim-lint',
        label: '权利要求检查',
        submitLabel: '检查',
        fields: [
          area(
            'claims',
            '权利要求（每行一项）',
            '一种多源监测方法，其特征在于：包括数据采集、时间对齐和风险判定。\n根据权利要求1所述的方法，其中时间对齐采用统一窗口。',
          ),
          area(
            'features',
            '技术特征（每行一项）',
            '数据采集\n时间对齐\n风险判定',
          ),
        ],
      },
      {
        id: 'valuation',
        label: '许可估值',
        submitLabel: '计算估值',
        fields: [
          number('annualRevenue', '预计年收入', '2000000'),
          number('royalty', '许可费率（%）', '3'),
          number('probability', '实现概率（%）', '60'),
          number('discount', '折现率（%）', '12'),
          number('years', '年限', '5'),
        ],
      },
      {
        id: 'trl-assess',
        label: 'TRL 成熟度',
        submitLabel: '评估',
        fields: [
          area(
            'evidence',
            '成熟度证据 JSON',
            '[\n  {"name":"原理验证","passed":true},\n  {"name":"实验室样机","passed":true},\n  {"name":"相关环境验证","passed":true},\n  {"name":"现场示范","passed":false},\n  {"name":"规模化运行","passed":false}\n]',
          ),
        ],
      },
      {
        id: 'risk-register',
        label: '现有技术风险',
        submitLabel: '分析风险',
        fields: [
          area(
            'description',
            '技术方案',
            '融合 GNSS 与微震传感器，通过统一时间窗口判断边坡风险。',
          ),
          area(
            'priorArt',
            '现有技术 JSON',
            '[\n  {"title":"多传感器边坡监测方法","abstract":"GNSS 和微震传感器融合监测边坡","status":"待核验"},\n  {"title":"单一位移阈值预警","abstract":"使用位移阈值进行预警","status":"已阅读"}\n]',
          ),
        ],
      },
    ],
  },
  'skill-evolution': {
    slug: 'skill-evolution',
    actions: [
      {
        id: 'validate',
        label: '规格校验',
        submitLabel: '校验',
        fields: [
          area(
            'specification',
            'SKILL.md',
            '---\nname: data-check\ndescription: 检查研究数据质量。\n---\n\n# 使用方法\n\n读取输入数据，检查缺失值和重复行，并返回可复核的结果。',
          ),
        ],
      },
      {
        id: 'security-scan',
        label: '安全扫描',
        submitLabel: '扫描',
        fields: [
          area(
            'specification',
            '技能内容',
            '# 数据检查\n读取用户提供的数据，执行字段和质量检查。',
          ),
        ],
      },
      {
        id: 'contract-validate',
        label: '输入输出契约',
        submitLabel: '校验契约',
        fields: [
          area(
            'inputSchema',
            '输入 JSON Schema',
            '{"type":"object","properties":{"csv":{"type":"string"}},"required":["csv"]}',
          ),
          area(
            'outputSchema',
            '输出 JSON Schema',
            '{"type":"object","properties":{"rows":{"type":"integer"}},"required":["rows"]}',
          ),
        ],
      },
      {
        id: 'release-check',
        label: '发布门禁',
        submitLabel: '检查发布',
        fields: [
          select('specValid', '规格有效', 'true', [
            { value: 'true', label: '是' },
            { value: 'false', label: '否' },
          ]),
          number('tests', '测试数量', '6'),
          number('assertionRate', '断言通过率（%）', '96'),
          number('highFindings', '高危发现数', '0'),
          text('version', '候选版本', '1.2.0'),
        ],
      },
    ],
  },
  'research-automation': {
    slug: 'research-automation',
    actions: [
      {
        id: 'validate',
        label: '流程校验',
        submitLabel: '校验',
        fields: [
          area(
            'nodes',
            '节点 JSON',
            '[\n  {"id":"collect","name":"采集"},\n  {"id":"clean","name":"清洗","dependsOn":["collect"]},\n  {"id":"report","name":"报告","dependsOn":["clean"]}\n]',
          ),
        ],
      },
      {
        id: 'run',
        label: '模拟运行',
        submitLabel: '运行',
        fields: [
          area(
            'nodes',
            '节点 JSON',
            '[\n  {"id":"collect","name":"采集"},\n  {"id":"clean","name":"清洗","dependsOn":["collect"]},\n  {"id":"report","name":"报告","dependsOn":["clean"]}\n]',
          ),
        ],
      },
    ],
  },
  'knowledge-system': {
    slug: 'knowledge-system',
    actions: [
      {
        id: 'index',
        label: '材料索引',
        submitLabel: '建立索引',
        fields: [
          area(
            'material',
            '研究材料',
            '台站 A 在 8 月出现持续位移。\n\n降雨量在同期显著增加。现场复核发现坡脚排水不畅。',
          ),
        ],
      },
      {
        id: 'query',
        label: '材料检索',
        submitLabel: '检索',
        fields: [
          area(
            'material',
            '研究材料',
            '台站 A 在 8 月出现持续位移。\n\n降雨量在同期显著增加。现场复核发现坡脚排水不畅。',
          ),
          text('query', '问题', '位移变化可能与什么有关？'),
        ],
      },
      {
        id: 'concept-map',
        label: '概念关系',
        submitLabel: '构建关系',
        fields: [
          area(
            'material',
            '研究材料',
            '微震监测用于识别岩体破裂。边坡位移监测可结合降雨数据。微震与位移数据融合有助于风险研判。',
          ),
        ],
      },
      {
        id: 'evaluate-retrieval',
        label: '检索评测',
        submitLabel: '运行评测',
        fields: [
          area(
            'material',
            '研究材料',
            '微震监测用于识别岩体破裂。\n\n边坡位移监测可结合降雨数据。',
          ),
          area(
            'tests',
            '测试集 JSON',
            '[\n  {"query":"什么用于识别岩体破裂？","expected":["微震"]},\n  {"query":"位移监测结合什么数据？","expected":["降雨"]}\n]',
          ),
        ],
      },
    ],
  },
  'research-radar': {
    slug: 'research-radar',
    actions: [
      {
        id: 'search-all',
        label: 'Crossref + OpenAlex',
        submitLabel: '双源检索',
        fields: [
          text('query', '研究主题', 'ambient noise tomography'),
          number('limit', '每源数量', '8'),
        ],
      },
      {
        id: 'search',
        label: 'Crossref 检索',
        submitLabel: '检索',
        fields: [
          text('query', '研究主题', 'ambient noise tomography'),
          number('limit', '返回数量', '8'),
        ],
      },
      {
        id: 'search-openalex',
        label: 'OpenAlex 检索',
        submitLabel: '检索',
        fields: [
          text('query', '研究主题', 'ambient noise tomography'),
          number('limit', '返回数量', '8'),
        ],
      },
      {
        id: 'export-bibtex',
        label: 'BibTeX 导出',
        submitLabel: '生成 BibTeX',
        fields: [
          area(
            'records',
            '文献记录 JSON',
            '[{"title":"Ambient noise tomography","year":2026,"doi":"10.1000/example","url":"https://doi.org/10.1000/example"}]',
          ),
        ],
      },
    ],
  },
  'mine-safety-radar': {
    slug: 'mine-safety-radar',
    actions: [
      {
        id: 'classify',
        label: '领域分类',
        submitLabel: '识别',
        fields: [
          area(
            'text',
            '标题或摘要',
            '基于微震与瓦斯传感器融合的煤矿冲击地压风险预警方法',
          ),
        ],
      },
      {
        id: 'readiness',
        label: '工程就绪度',
        submitLabel: '检查证据',
        fields: [
          area(
            'text',
            '标题或摘要',
            '在某矿现场使用微震传感器验证模型，并与基线比较。公开数据集和代码，报告不确定性。',
          ),
        ],
      },
    ],
  },
  'data-gateway': {
    slug: 'data-gateway',
    actions: [
      { id: 'catalog', label: '流程目录', submitLabel: '载入', fields: [] },
      {
        id: 'preview',
        label: '数据预览',
        submitLabel: '解析',
        fields: [area('content', 'CSV、TSV 或 JSON 数据')],
      },
      {
        id: 'run',
        label: '运行数据流',
        submitLabel: '运行',
        fields: [area('flow', 'skyview-nifi-flow v2 JSON')],
      },
      {
        id: 'replay',
        label: '溯源重放',
        submitLabel: 'Replay',
        fields: [
          area('flow', '流程 JSON'),
          text('eventId', '事件 ID'),
          text('connectionId', '目标连接 ID', 'c-ingest-convert'),
        ],
      },
      {
        id: 'export',
        label: '导出数据流',
        submitLabel: '导出',
        fields: [area('flow', '流程 JSON')],
      },
      {
        id: 'validate-flow',
        label: '数据流编排',
        submitLabel: '校验流程',
        fields: [
          area(
            'nodes',
            '处理器节点 JSON',
            '[\n  {"id":"ingest","type":"GetFile","properties":{"path":"ref:input_path"}},\n  {"id":"quality","type":"ValidateRecord"},\n  {"id":"publish","type":"PutDatabaseRecord","properties":{"password":"ref:database_password"}}\n]',
          ),
          area(
            'connections',
            '连接 JSON',
            '[{"source":"ingest","target":"quality"},{"source":"quality","target":"publish"}]',
          ),
        ],
      },
      {
        id: 'process',
        label: '记录处理',
        submitLabel: '处理',
        fields: [
          area(
            'csv',
            'CSV 数据',
            'station,time,value\nA,2026-09-07T10:00:00Z,12.4\nB,2026-09-07T10:01:00Z,\nA,2026-09-07T10:02:00Z,13.1',
          ),
          area(
            'mappings',
            '字段映射 JSON',
            '{"station":"station_id","time":"observed_at"}',
          ),
          area(
            'requiredFields',
            '必填字段 JSON',
            '["station_id","observed_at","value"]',
          ),
        ],
      },
    ],
  },
  'ambient-noise-imaging': {
    slug: 'ambient-noise-imaging',
    actions: [
      {
        id: 'preprocess',
        label: '波形预处理',
        submitLabel: '处理',
        fields: [
          area('values', '波形', '0,1,2,1,0,-1,-2,-1,0,1,2,1'),
          number('taper', '边缘渐变比例', '0.05'),
        ],
      },
      {
        id: 'spectrum',
        label: '频谱检查',
        submitLabel: '计算频谱',
        fields: [
          area('values', '波形', '0,1,2,1,0,-1,-2,-1,0,1,2,1'),
          number('sampleRate', '采样率（Hz）', '20'),
        ],
      },
      {
        id: 'correlate',
        label: '台站对互相关',
        submitLabel: '计算',
        fields: [
          area('left', '通道 A', '0,1,2,1,0,-1,-2,-1,0,1,2,1'),
          area('right', '通道 B', '0,0,1,2,1,0,-1,-2,-1,0,1,2'),
          number('maxLag', '最大延迟', '4'),
        ],
      },
      {
        id: 'dispersion',
        label: '频散拾取',
        submitLabel: '计算速度',
        fields: [
          area('periods', '周期', '2,4,6,8'),
          area('distances', '距离（km）', '12,18,25,32'),
          area('travelTimes', '传播时间（秒）', '4.2,5.8,7.5,9.1'),
        ],
      },
    ],
  },
  'patent-disclosure': {
    slug: 'patent-disclosure',
    actions: [
      {
        id: 'create',
        label: '新建专利项目',
        submitLabel: '创建',
        fields: [
          select('patentType', '专利类型', '发明专利', [
            { value: '发明专利', label: '发明专利' },
            { value: '实用新型', label: '实用新型' },
            { value: '外观设计', label: '外观设计' },
          ]),
          text('title', '发明名称'),
          area('concept', '核心技术构思'),
        ],
      },
      {
        id: 'analyze',
        label: '技术特征分析',
        submitLabel: '分析',
        fields: [area('concept', '核心技术构思')],
      },
      {
        id: 'generate-chapter',
        label: '逐章生成',
        submitLabel: '生成章节',
        fields: [
          area('project', '项目 JSON'),
          text('chapterKey', '章节键', 'technical_solution'),
        ],
      },
      {
        id: 'generate-all',
        label: '生成十章节',
        submitLabel: '全部生成',
        fields: [area('project', '项目 JSON')],
      },
      {
        id: 'structure',
        label: '核心构思分析',
        submitLabel: '分析',
        fields: [
          area(
            'concept',
            '核心构思',
            '利用多源传感器的时空一致性，对矿山边坡异常进行交叉核验。',
          ),
          area('problem', '技术问题', '单一传感器容易受噪声影响，造成误报。'),
          area(
            'mechanism',
            '工作机理',
            '对位移、降雨与微震数据进行时间对齐，再按证据一致性分级。',
          ),
          area('evidence', '验证证据', '现场试验记录了误报率和提前量。'),
        ],
      },
      {
        id: 'generate',
        label: '生成交底书',
        submitLabel: '生成十章节',
        fields: [
          area(
            'concept',
            '核心构思',
            '利用多源传感器的时空一致性，对矿山边坡异常进行交叉核验。',
          ),
          area('problem', '技术问题', '单一传感器容易受噪声影响，造成误报。'),
          area(
            'mechanism',
            '技术方案',
            '对位移、降雨与微震数据进行时间对齐，再按证据一致性分级。',
          ),
          area('evidence', '技术效果证据', '现场试验记录了误报率和提前量。'),
        ],
      },
      {
        id: 'audit',
        label: '完整性检查',
        submitLabel: '检查',
        fields: [
          area('concept', '核心构思', '多源监测预警装置'),
          area(
            'disclosure',
            '交底书正文',
            '技术领域\n背景技术\n现有技术缺陷\n发明目的\n技术方案\n关键创新点\n实施方式\n技术效果\n附图说明\n可替代方案',
          ),
        ],
      },
      {
        id: 'export',
        label: '成果导出',
        submitLabel: '生成导出文件',
        fields: [area('project', '项目 JSON')],
      },
    ],
  },
  'warning-platform': {
    slug: 'warning-platform',
    actions: [
      {
        id: 'evaluate',
        label: '阈值研判',
        submitLabel: '研判',
        fields: [
          area('values', '监测值', '42,48,55,63,72,84,79,58'),
          number('warning', '预警阈值', '60'),
          number('critical', '严重阈值', '80'),
        ],
      },
    ],
  },
  'uav-inspection': {
    slug: 'uav-inspection',
    actions: [
      {
        id: 'prioritize',
        label: '异常排序',
        submitLabel: '排序',
        fields: [
          area(
            'anomalies',
            '异常点 JSON',
            '[\n  {"id":"A-01","type":"裂缝","severity":5,"confidence":0.92,"exposure":4},\n  {"id":"A-02","type":"渗水","severity":3,"confidence":0.81,"exposure":3}\n]',
          ),
        ],
      },
    ],
  },
  'fusion-console': {
    slug: 'fusion-console',
    actions: [
      {
        id: 'align',
        label: '时间对齐',
        submitLabel: '对齐',
        fields: [
          area(
            'observations',
            '观测数据 JSON',
            '[\n  {"source":"gnss","timestamp":"2026-09-07T10:00:12Z","value":12.3},\n  {"source":"rain","timestamp":"2026-09-07T10:00:45Z","value":18.2},\n  {"source":"gnss","timestamp":"2026-09-07T10:01:08Z","value":12.8}\n]',
          ),
          number('windowSeconds', '对齐窗口（秒）', '60'),
        ],
      },
    ],
  },
  'emergency-console': {
    slug: 'emergency-console',
    actions: [
      {
        id: 'plan',
        label: '处置计划',
        submitLabel: '生成计划',
        fields: [
          area(
            'incident',
            '事件情况',
            '矿区北侧边坡位移速率持续上升，需要现场复核并控制人员进入。',
          ),
          select('severity', '事件等级', 'high', [
            { value: 'low', label: '低' },
            { value: 'medium', label: '中' },
            { value: 'high', label: '高' },
            { value: 'critical', label: '严重' },
          ]),
          area(
            'tasks',
            '任务 JSON',
            '[\n  {"title":"封控危险区","owner":"现场组"},\n  {"title":"复核监测数据","owner":"监测组"},\n  {"title":"通知项目负责人"}\n]',
          ),
        ],
      },
    ],
  },
  'python-lab': {
    slug: 'python-lab',
    actions: [
      {
        id: 'run',
        label: '运行代码',
        submitLabel: '运行',
        fields: [
          area(
            'code',
            'Python 代码',
            'numbers = [3, 5, 8, 13]\nprint(sum(numbers))\nprint(max(numbers))',
          ),
          area('stdin', '标准输入', '', '可留空'),
        ],
      },
    ],
  },
  'daily-practice': {
    slug: 'daily-practice',
    actions: [
      {
        id: 'grade',
        label: '答案批改',
        submitLabel: '批改',
        fields: [
          area(
            'expected',
            '标准答案（每行一题）',
            'list\ndictionary\nfunction',
          ),
          area('answers', '我的答案（每行一题）', 'list\ndict\nfunction'),
        ],
      },
    ],
  },
  'project-workspace': {
    slug: 'project-workspace',
    actions: [
      {
        id: 'summary',
        label: '进度汇总',
        submitLabel: '汇总',
        fields: [
          area(
            'tasks',
            '任务 JSON',
            '[\n  {"id":"T1","title":"整理数据","status":"done","owner":"小林"},\n  {"id":"T2","title":"完成分析","status":"doing","owner":"小周"},\n  {"id":"T3","title":"提交报告","status":"todo"}\n]',
          ),
        ],
      },
      {
        id: 'validate',
        label: '任务校验',
        submitLabel: '校验',
        fields: [
          area(
            'tasks',
            '任务 JSON',
            '[\n  {"id":"T1","title":"整理数据","status":"done"},\n  {"id":"T2","title":"完成分析","status":"doing"}\n]',
          ),
        ],
      },
    ],
  },
  'scientific-animation-studio': {
    slug: 'scientific-animation-studio',
    actions: [
      {
        id: 'validate-scene',
        label: '场景质量检查',
        submitLabel: '开始检查',
        fields: [
          text('sceneId', '场景编号', 'scene-wave'),
        ],
      },
    ],
  },
  'data-lab': {
    slug: 'data-lab',
    actions: [
      {
        id: 'profile',
        label: '字段画像',
        submitLabel: '分析',
        fields: [
          area(
            'csv',
            'CSV 数据',
            'name,value,group\nAlpha,12,A\nBeta,18,B\nBeta,18,B\n,21,A',
          ),
        ],
      },
      {
        id: 'clean',
        label: '操作历史与清洗',
        submitLabel: '执行操作',
        fields: [
          area(
            'csv',
            'CSV 数据',
            'name,value,group\n  Alpha  ,12,A\nBeta,18,B\nBeta,18,B\n,,\nGamma,  21 ,A',
          ),
          area(
            'operations',
            '操作 JSON',
            '["trim","collapse-whitespace","remove-empty","deduplicate"]',
          ),
        ],
      },
    ],
  },
  'ai-report': {
    slug: 'ai-report',
    actions: [
      {
        id: 'draft',
        label: '生成报告',
        submitLabel: '生成',
        fields: [
          text('title', '报告标题', '边坡监测材料分析'),
          text('focus', '分析重点', '位移与降雨关系'),
          area(
            'material',
            '依据材料',
            '台站 A 位移在连续降雨后加速。\n\n同期累计降雨量达到 86 毫米。\n\n现场巡查发现排水沟局部堵塞。',
          ),
        ],
      },
      {
        id: 'audit',
        label: '引用检查',
        submitLabel: '检查',
        fields: [
          area(
            'material',
            '依据材料',
            '台站 A 位移在连续降雨后加速。\n\n同期累计降雨量达到 86 毫米。',
          ),
          area(
            'report',
            '报告内容',
            '# 研判\n\n位移变化与连续降雨同期出现 [S1.1]。\n\n## 局限\n\n当前材料不足以确认因果关系。',
          ),
        ],
      },
      {
        id: 'source-index',
        label: '来源索引',
        submitLabel: '生成索引',
        fields: [
          area(
            'material',
            '依据材料',
            '台站 A 位移在连续降雨后加速。\n\n同期累计降雨量达到 86 毫米。',
          ),
          area(
            'report',
            '报告内容',
            '位移变化与连续降雨同期出现 [S1.1]。累计降雨量达到 86 毫米 [S1.2]。',
          ),
        ],
      },
    ],
  },
  'python-english': {
    slug: 'python-english',
    actions: [
      {
        id: 'grade',
        label: '词汇测验',
        submitLabel: '评分',
        fields: [
          area(
            'questions',
            '题目 JSON',
            '[\n  {"term":"loop","answer":"循环"},\n  {"term":"variable","answer":"变量"},\n  {"term":"return","answer":"返回"}\n]',
          ),
          area('answers', '答案 JSON', '["循环","变量","返回"]'),
        ],
      },
      {
        id: 'mastery',
        label: '掌握度',
        submitLabel: '计算掌握度',
        fields: [
          area(
            'progress',
            '学习记录 JSON',
            '[\n  {"word":"loop","attempts":5,"correct":5},\n  {"word":"variable","attempts":3,"correct":2},\n  {"word":"iterator","attempts":0,"correct":0}\n]',
          ),
        ],
      },
    ],
  },
  'ai-assessment': {
    slug: 'ai-assessment',
    actions: [
      {
        id: 'load-sample', label: '载入评测基准', submitLabel: '载入', fields: [],
      },
      {
        id: 'select-context', label: '选择题目与语言', submitLabel: '切换', fields: [text('problemId', '题目标识'), text('language', '语言', 'python')],
      },
      {
        id: 'save-draft', label: '保存源码草稿', submitLabel: '保存', fields: [text('problemId', '题目标识'), text('language', '语言', 'python'), area('code', '源码')],
      },
      { id: 'review-source', label: '源码静态检查', submitLabel: '检查', fields: [text('language', '语言', 'python'), area('code', '源码')] },
      { id: 'refresh-runtime', label: '刷新执行节点', submitLabel: '刷新', fields: [] },
      { id: 'submit', label: '提交隔离评测', submitLabel: '提交', fields: [text('problemId', '题目标识'), text('language', '语言', 'python'), area('code', '源码')] },
      { id: 'rejudge', label: '重新判题', submitLabel: '重新判题', fields: [text('submissionId', '提交编号')] },
      { id: 'validate-bank', label: '题库质量校验', submitLabel: '校验', fields: [] },
      { id: 'import-problems', label: '导入题库', submitLabel: '导入', fields: [area('problems', '题目 JSON')] },
      { id: 'delete-custom-problem', label: '删除自定义题目', submitLabel: '删除', fields: [text('problemId', '题目标识')] },
      { id: 'export', label: '生成交付包', submitLabel: '导出', fields: [] },
      { id: 'run-all', label: '恢复完整基准', submitLabel: '恢复', fields: [] },
    ],
  },
  'flac3d-slope-stability': {
    slug: 'flac3d-slope-stability',
    actions: [
      { id: 'load-sample', label: '载入基准算例', submitLabel: '载入', fields: [] },
      { id: 'update-model', label: '更新模型参数', submitLabel: '更新', fields: [] },
      { id: 'validate-model', label: '模型质量检查', submitLabel: '检查', fields: [] },
      { id: 'screen-stability', label: '快速稳定筛查', submitLabel: '筛查', fields: [] },
      { id: 'runtime-status', label: '求解器状态', submitLabel: '检查', fields: [] },
      { id: 'prepare-run', label: '生成运行包', submitLabel: '生成', fields: [] },
      { id: 'import-results', label: '导入分区结果', submitLabel: '导入', fields: [area('csv', 'FLAC3D 分区结果 CSV')] },
      { id: 'execute-flac3d', label: '执行高保真计算', submitLabel: '执行', fields: [] },
      { id: 'export', label: '生成交付成果', submitLabel: '生成', fields: [] },
      { id: 'run-all', label: '恢复完整基准', submitLabel: '恢复', fields: [] },
    ],
  },
  'project-submission': {
    slug: 'project-submission',
    actions: [
      {
        id: 'manifest',
        label: '文件清单',
        submitLabel: '检查',
        fields: [
          area(
            'files',
            '文件 JSON',
            '[\n  {"path":"README.md","content":"# 课程项目\\n运行方法见下文。"},\n  {"path":"src/main.py","content":"print(\\"hello\\")"}\n]',
          ),
        ],
      },
      {
        id: 'package',
        label: '生成提交包',
        submitLabel: '打包',
        fields: [
          area(
            'files',
            '文件 JSON',
            '[\n  {"path":"README.md","content":"# 课程项目\\n运行方法见下文。"},\n  {"path":"src/main.py","content":"print(\\"hello\\")"}\n]',
          ),
        ],
      },
    ],
  },
};

export function getToolDefinition(slug: string) {
  return toolDefinitions[slug];
}
