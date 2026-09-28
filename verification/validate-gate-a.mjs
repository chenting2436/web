import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";

const workspace = path.resolve(import.meta.dirname, "..");
const gateRoot = path.join(workspace, "verification", "acceptance", "_platform", "gate-a");
const require = createRequire(import.meta.url);
const yaml = require(path.join(workspace, "web_react", "node_modules", "js-yaml"));
const fail = (message) => {
  throw new Error(message);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const gateFile = (...segments) => path.join(gateRoot, ...segments);

const requiredDocuments = [
  ["02-requirements", "DECISION_STATUS.md"],
  ["02-requirements", "ARCHITECTURE_REVIEW.md"],
  ["03-api-and-data", "target-openapi.yaml"],
  ["03-api-and-data", "TARGET_DOMAIN_MODEL.md"],
  ["03-api-and-data", "FIELD_GROUP_TRACEABILITY.md"],
  ["04-permissions", "PERMISSION_MATRIX.md"],
  ["05-audit-and-provenance", "DOMAIN_EVENT_CATALOG.md"],
  ["07-runtime-and-science", "GOLDEN_DATASET_REGISTER.md"],
  ["09-tests", "FORMAT_FIXTURE_REGISTER.md"],
  ["10-visual-a11y", "VISUAL_AND_INTERACTION_BASELINE.md"],
  ["11-security-recovery", "THREAT_MODEL.md"],
  ["12-supply-chain-license", "THIRD_PARTY_LOCK_REGISTER.md"],
  ["12-supply-chain-license", "REFERENCE_SELECTION.md"],
];
for (const segments of requiredDocuments) {
  const file = gateFile(...segments);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) fail("Missing Gate A document: " + file);
}

const targetPath = gateFile("03-api-and-data", "target-openapi.yaml");
const target = yaml.load(fs.readFileSync(targetPath, "utf8"));
if (target.openapi !== "3.1.0") fail("Target contract must use OpenAPI 3.1.0.");
if (target["x-contract-status"] !== "design-only") fail("Target contract must not claim implemented status.");
if (Object.keys(target.paths ?? {}).length !== 40) fail("Expected 40 target paths.");
const traceKeys = Object.keys(target["x-workbench-trace"] ?? {});
const expectedTrace = ["T01","T02","T03","T04","T05","T06","T07","T08","R01","R02","R03","R04","R05","R06","R07-R08","R09","E01","E02","E03"];
if (JSON.stringify(traceKeys) !== JSON.stringify(expectedTrace)) fail("Target workbench trace is incomplete or reordered.");

const pointer = (document, reference) => {
  if (!reference.startsWith("#/")) fail("External OpenAPI reference is not allowed in Gate A: " + reference);
  return reference.slice(2).split("/").reduce((value, part) => {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value == null || !(key in value)) fail("Unresolved OpenAPI reference: " + reference);
    return value[key];
  }, document);
};
const visitedObjects = new Set();
const visit = (value) => {
  if (value == null || typeof value !== "object" || visitedObjects.has(value)) return;
  visitedObjects.add(value);
  if (typeof value.$ref === "string") pointer(target, value.$ref);
  for (const child of Object.values(value)) visit(child);
};
visit(target);

const operationIds = [];
for (const item of Object.values(target.paths)) {
  if (item.$ref) pointer(target, item.$ref);
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const operation = item[method];
    if (operation?.operationId) operationIds.push(operation.operationId);
  }
}
if (new Set(operationIds).size !== operationIds.length) fail("Duplicate target operationId.");

const routes = readJson(gateFile("01-legacy-baseline", "routes.json"));
const dom = readJson(gateFile("10-visual-a11y", "legacy-dom-fields.json"));
const visual = readJson(gateFile("10-visual-a11y", "visual-manifest.json"));
if (routes.length !== 32 || dom.routes.length !== 32 || visual.captures.length !== 32) {
  fail("Route, DOM and visual inventories must each contain 32 entries.");
}
const routeIds = routes.map((item) => item.id).join(",");
if (dom.routes.map((item) => item.id).join(",") !== routeIds) fail("DOM inventory route order mismatch.");
if (visual.captures.map((item) => item.id).join(",") !== routeIds) fail("Visual inventory route order mismatch.");
for (const capture of visual.captures) {
  const file = gateFile("10-visual-a11y", ...capture.file.split("/"));
  if (!fs.existsSync(file)) fail("Visual capture missing: " + file);
  if (fs.statSync(file).size !== capture.bytes) fail("Visual capture size mismatch: " + file);
  if (sha256(file) !== capture.sha256) fail("Visual capture hash mismatch: " + file);
}

const fixtureRoot = gateFile("09-tests", "fixtures");
const fixtureFiles = [];
const collect = (dir) => {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const item = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(item);
    else fixtureFiles.push(item);
  }
};
collect(fixtureRoot);
if (fixtureFiles.length < 15) fail("Expected at least 15 initial fixtures.");
for (const file of fixtureFiles.filter((item) => item.endsWith(".json"))) readJson(file);

const golden = readJson(gateFile("07-runtime-and-science", "golden", "legacy-compatibility-expectations.json"));
if (golden.cases.length !== 8) fail("Expected eight legacy compatibility golden cases.");
if (golden.baselineCommit !== "8a754dcdb8ab97c7a90ca588693a17b21ee1f41b") fail("Golden cases use wrong baseline.");

for (const name of ["web-react-npm.cdx.json", "backend-go-modules.cdx.json", "backend-python-requirements.cdx.json"]) {
  const sbom = readJson(gateFile("12-supply-chain-license", name));
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components) || sbom.components.length === 0) {
    fail("Invalid or empty source SBOM: " + name);
  }
}

const deliverableManifest = readJson(gateFile("00-manifest", "gate-a-deliverables.json"));
if (deliverableManifest.schema !== "skyview-gate-a-deliverables" || deliverableManifest.status !== "conditional-no-go") {
  fail("Gate A deliverable manifest has an invalid schema or status.");
}
if (deliverableManifest.artifactCount !== deliverableManifest.artifacts.length) fail("Deliverable manifest count mismatch.");
for (const artifact of deliverableManifest.artifacts) {
  const file = path.join(workspace, ...artifact.path.split("/"));
  if (!fs.existsSync(file)) fail("Deliverable missing: " + artifact.path);
  if (fs.statSync(file).size !== artifact.bytes) fail("Deliverable size mismatch: " + artifact.path);
  if (sha256(file) !== artifact.sha256) fail("Deliverable hash mismatch: " + artifact.path);
}

console.log("Gate A deliverable validation passed.");
console.log("Target OpenAPI paths: " + Object.keys(target.paths).length);
console.log("Workbench trace entries: " + traceKeys.length + " (20 workbenches; R07/R08 share a family endpoint)");
console.log("Visual captures: " + visual.captures.length);
console.log("DOM/field inventories: " + dom.routes.length);
console.log("Initial fixtures: " + fixtureFiles.length);
console.log("Legacy compatibility golden cases: " + golden.cases.length);
console.log("Hashed Gate A deliverables: " + deliverableManifest.artifactCount);
