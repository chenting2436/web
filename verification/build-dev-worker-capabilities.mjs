import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const workspace = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const ts = require(path.join(workspace, 'web_react', 'node_modules', 'typescript'));
const sourcePath = path.join(workspace, 'web_react', 'lib', 'tool-definitions.ts');
const source = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

let definitions;
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'toolDefinitions' && ts.isObjectLiteralExpression(node.initializer)) {
    definitions = node.initializer;
  }
  ts.forEachChild(node, visit);
};
visit(source);

if (!definitions) throw new Error('toolDefinitions object was not found');

const textValue = (node) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
};

const capabilities = definitions.properties.map((property) => {
  if (!ts.isPropertyAssignment(property)) throw new Error('Unsupported tool definition property');
  const slug = textValue(property.name) ?? property.name.getText(source);
  if (!ts.isObjectLiteralExpression(property.initializer)) throw new Error(`Invalid definition for ${slug}`);
  const actionsProperty = property.initializer.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === 'actions');
  if (!actionsProperty || !ts.isPropertyAssignment(actionsProperty) || !ts.isArrayLiteralExpression(actionsProperty.initializer)) {
    throw new Error(`Missing actions for ${slug}`);
  }
  const actions = actionsProperty.initializer.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error(`Invalid action for ${slug}`);
    const idProperty = element.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === 'id');
    if (!idProperty || !ts.isPropertyAssignment(idProperty)) throw new Error(`Missing action id for ${slug}`);
    const id = textValue(idProperty.initializer);
    if (!id) throw new Error(`Non-literal action id for ${slug}`);
    return id;
  });
  return { slug, actions };
});

const nonExecutable = new Set([
  'project-submission',
]);

const ambient = capabilities.find((item) => item.slug === 'ambient-noise-imaging');
if (!ambient) throw new Error('ambient-noise-imaging capability is missing');
ambient.actions = ['load-sample', 'preprocess', 'correlate', 'dispersion', 'tomography', 'checkerboard', 'run-all'];

const seismic = capabilities.find((item) => item.slug === 'seismic-physics');
if (!seismic) throw new Error('seismic-physics capability is missing');
seismic.actions = [
  'source-distance', 'smooth', 'spectrum', 'load-sample', 'preprocess',
  'detect', 'spectrum-workbench', 'aic-pick', 'physics', 'validate', 'run-all',
];

const patentTransfer = capabilities.find((item) => item.slug === 'patent-transfer');
if (!patentTransfer) throw new Error('patent-transfer capability is missing');
patentTransfer.actions = [
  'claim-lint', 'trl-assess', 'valuation', 'risk-register', 'load-sample',
  'analyze', 'search-landscape', 'novelty-matrix', 'claim-workbench',
  'fto-assess', 'transfer-assess', 'deadline-check', 'export', 'run-all',
];

const skillEvolution = capabilities.find((item) => item.slug === 'skill-evolution');
if (!skillEvolution) throw new Error('skill-evolution capability is missing');
skillEvolution.actions = [
  'validate', 'contract-validate', 'release-check', 'load-sample',
  'validate-spec', 'validate-contract', 'validate-workflow', 'run', 'evaluate',
  'security-scan', 'export', 'run-all', 'publish', 'import-package', 'import-dataset',
];

const knowledgeSystem = capabilities.find((item) => item.slug === 'knowledge-system');
if (!knowledgeSystem) throw new Error('knowledge-system capability is missing');
knowledgeSystem.actions = [
  'index', 'query', 'concept-map', 'evaluate-retrieval', 'load-sample', 'search',
  'ask', 'ingest-file', 'ingest-text', 'update-chunk', 'reindex-document',
  'delete-document', 'evaluate', 'export', 'import-backup', 'run-all',
];

const researchRadar = capabilities.find((item) => item.slug === 'research-radar');
if (!researchRadar) throw new Error('research-radar capability is missing');
researchRadar.actions = [
  'search-all', 'search-openalex', 'export-bibtex', 'load-sample', 'search',
  'search-live', 'import-records', 'dedupe', 'update-library', 'update-evidence',
  'run-monitor', 'transfer', 'export', 'run-all',
];

const mineSafetyRadar = capabilities.find((item) => item.slug === 'mine-safety-radar');
if (!mineSafetyRadar) throw new Error('mine-safety-radar capability is missing');
mineSafetyRadar.actions = [
  'readiness', 'load-sample', 'search', 'search-live', 'classify',
  'import-records', 'dedupe', 'update-library', 'update-evidence',
  'run-monitor', 'transfer', 'export', 'run-all',
];

const researchAutomation = capabilities.find((item) => item.slug === 'research-automation');
if (!researchAutomation) throw new Error('research-automation capability is missing');
researchAutomation.actions = [
  'validate', 'run', 'load-sample', 'validate-workflow', 'update-workflow',
  'apply-template', 'select-workflow', 'add-node', 'update-node', 'delete-node',
  'add-variable', 'delete-variable', 'run-preview', 'retry-step', 'approve',
  'cancel-run', 'publish', 'import-workflow', 'export', 'run-all',
];

const pythonLab = capabilities.find((item) => item.slug === 'python-lab');
if (!pythonLab) throw new Error('python-lab capability is missing');
pythonLab.actions = [
  'load-sample', 'validate-workspace', 'save-file', 'create-file',
  'create-folder', 'rename-path', 'delete-path', 'apply-template',
  'save-notebook', 'record-cell-run', 'update-run-config', 'install-package', 'record-run', 'create-snapshot',
  'restore-snapshot', 'import-workspace', 'export', 'run-all',
];

const dailyPractice = capabilities.find((item) => item.slug === 'daily-practice');
if (!dailyPractice) throw new Error('daily-practice capability is missing');
dailyPractice.actions = [
  'load-sample', 'upgrade-bank', 'answer-practice', 'build-adaptive-session', 'toggle-favorite', 'start-exam',
  'save-exam-answer', 'resume-exam', 'submit-exam', 'reset-progress',
  'validate-bank', 'export', 'run-all',
];

const aiAssessment = capabilities.find((item) => item.slug === 'ai-assessment');
if (!aiAssessment) throw new Error('ai-assessment capability is missing');
aiAssessment.actions = [
  'load-sample', 'select-context', 'save-draft', 'review-source', 'refresh-runtime',
  'submit', 'rejudge', 'validate-bank', 'import-problems',
  'delete-custom-problem', 'export', 'run-all', 'review',
];

const warningPlatform = capabilities.find((item) => item.slug === 'warning-platform');
if (!warningPlatform) throw new Error('warning-platform capability is missing');
warningPlatform.actions = [
  'load-sample', 'ingest-observations', 'evaluate-rules',
  'acknowledge-alarm', 'assign-alarm', 'close-alarm', 'suppress-alarm',
  'approve-rule', 'publish-rule', 'create-maintenance-window',
  'validate', 'connector-status', 'export', 'run-all',
];

const uavInspection = capabilities.find((item) => item.slug === 'uav-inspection');
if (!uavInspection) throw new Error('uav-inspection capability is missing');
uavInspection.actions = [
  'load-sample', 'update-flight-plan', 'validate-flight-plan',
  'import-image-manifest', 'prepare-photogrammetry', 'run-defect-analysis',
  'review-detection', 'update-annotation', 'create-work-order',
  'update-work-order', 'compare-missions', 'runtime-status',
  'validate', 'export', 'run-all',
];

const fusionConsole = capabilities.find((item) => item.slug === 'fusion-console');
if (!fusionConsole) throw new Error('fusion-console capability is missing');
fusionConsole.actions = [
  'align', 'load-sample', 'register-source', 'govern-schema', 'calibrate-source',
  'import-observations', 'run-quality-checks', 'align-observations',
  'build-features', 'run-fusion', 'review-fused-event',
  'publish-model-version', 'replay-window', 'runtime-status',
  'validate', 'export', 'run-all',
];

const emergencyConsole = capabilities.find((item) => item.slug === 'emergency-console');
if (!emergencyConsole) throw new Error('emergency-console capability is missing');
emergencyConsole.actions = [
  'plan', 'load-sample', 'create-incident', 'update-incident', 'import-reports',
  'verify-report', 'create-task', 'update-task', 'assign-resource',
  'record-decision', 'send-communication', 'handover-shift',
  'publish-situation-report', 'close-incident', 'after-action-review',
  'runtime-status', 'validate', 'export', 'run-all',
];

const projectWorkspace = capabilities.find((item) => item.slug === 'project-workspace');
if (!projectWorkspace) throw new Error('project-workspace capability is missing');
projectWorkspace.actions = [
  'summary', 'load-sample', 'select-project', 'create-project', 'update-project',
  'archive-project', 'restore-project', 'create-task', 'update-task',
  'move-task', 'archive-task', 'delete-task', 'restore-task',
  'add-dependency', 'add-comment', 'add-attachment', 'add-member',
  'update-member', 'remove-member', 'create-cycle', 'update-cycle',
  'create-milestone', 'update-milestone', 'update-note',
  'create-snapshot', 'restore-snapshot', 'import-project',
  'runtime-status', 'validate', 'export', 'run-all',
];

const scientificAnimation = capabilities.find((item) => item.slug === 'scientific-animation-studio');
if (!scientificAnimation) throw new Error('scientific-animation-studio capability is missing');
scientificAnimation.actions = [
  'load-sample', 'run-all', 'select-scene', 'create-scene', 'update-scene',
  'select-object', 'add-object', 'update-object', 'delete-object',
  'add-keyframe', 'update-keyframe', 'remove-keyframe', 'reorder-layer',
  'update-camera', 'seek', 'create-snapshot', 'import-project',
  'prepare-render', 'record-render', 'render-preview', 'validate-scene',
  'create-storyboard', 'runtime-status', 'export',
];

const dataLab = capabilities.find((item) => item.slug === 'data-lab');
if (!dataLab) throw new Error('data-lab capability is missing');
dataLab.actions = [
  'profile', 'clean', 'load-sample', 'run-all', 'update-project', 'import-data',
  'apply-operation', 'edit-cell', 'undo', 'redo', 'jump-history',
  'set-view', 'set-facet', 'clear-facets', 'set-sort', 'replay-operations',
  'create-snapshot', 'restore-snapshot', 'import-project', 'validate',
  'runtime-status', 'export',
];

const aiReport = capabilities.find((item) => item.slug === 'ai-report');
if (!aiReport) throw new Error('ai-report capability is missing');
aiReport.actions = [
  'draft', 'audit', 'source-index', 'load-sample', 'run-all', 'update-project', 'update-config',
  'import-material', 'import-text', 'register-url', 'toggle-material',
  'toggle-chunk', 'delete-material', 'set-active-material',
  'generate-extractive', 'record-local-generation', 'ask-extractive',
  'record-local-chat', 'update-report', 'audit-report', 'create-version',
  'restore-version', 'clear-chat', 'import-project', 'runtime-status',
  'validate', 'export',
];

const pythonEnglish = capabilities.find((item) => item.slug === 'python-english');
if (!pythonEnglish) throw new Error('python-english capability is missing');
pythonEnglish.actions = [
  'grade', 'load-sample', 'run-all', 'select-set', 'select-mode',
  'record-learn', 'record-card', 'record-quiz', 'record-typing',
  'record-pronunciation', 'start-exam', 'save-exam-answer',
  'submit-exam', 'mark-reference-read', 'update-preferences',
  'import-vocabulary', 'import-exam', 'reset-progress',
  'runtime-status', 'validate', 'export',
];

process.stdout.write(JSON.stringify(capabilities.filter((item) => !nonExecutable.has(item.slug))));
