import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const gateRoot = path.join(workspace, "verification", "acceptance", "_platform", "gate-a");
const output = path.join(gateRoot, "00-manifest", "gate-a-deliverables.json");
const evidenceDirectories = [
  "02-requirements",
  "03-api-and-data",
  "04-permissions",
  "05-audit-and-provenance",
  "07-runtime-and-science",
  "09-tests",
  "10-visual-a11y",
  "11-security-recovery",
  "12-supply-chain-license",
];
const files = [];
const collect = (item) => {
  for (const entry of fs.readdirSync(item, {withFileTypes: true})) {
    const full = path.join(item, entry.name);
    if (entry.isDirectory()) collect(full);
    else files.push(full);
  }
};
for (const directory of evidenceDirectories) collect(path.join(gateRoot, directory));
for (const source of [
  "verification/build-gate-a-deliverable-manifest.mjs",
  "verification/build-legacy-dom-inventory.mjs",
  "verification/build-legacy-visual-manifest.mjs",
  "verification/build-source-sboms.mjs",
  "verification/validate-gate-a.mjs",
  "verification/verify-card-baseline.ps1",
  "verification/verify-gate-a.ps1",
]) files.push(path.join(workspace, ...source.split("/")));

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const relative = (file) => path.relative(workspace, file).split(path.sep).join("/");
const artifacts = [...new Set(files)].sort((a, b) => relative(a).localeCompare(relative(b), "en")).map((file) => ({
  path: relative(file),
  bytes: fs.statSync(file).size,
  sha256: sha256(file),
}));
const manifest = {
  schema: "skyview-gate-a-deliverables",
  schemaVersion: 1,
  status: "conditional-no-go",
  generatedOn: "2026-09-08",
  baselineCommit: "8a754dcdb8ab97c7a90ca588693a17b21ee1f41b",
  note: "Hashes prove evidence integrity, not product or legal approval.",
  artifactCount: artifacts.length,
  artifacts,
};
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log("Wrote Gate A deliverable manifest with " + artifacts.length + " artifacts.");
