import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(workspace, "verification", "acceptance", "_platform", "gate-a", "12-supply-chain-license");
const write = (name, value) => fs.writeFileSync(path.join(outputRoot, name), JSON.stringify(value, null, 2) + "\n", "utf8");
const purlName = (value) => encodeURIComponent(value).replace(/%2F/gi, "/");
const component = (type, name, version) => ({
  type: "library",
  name,
  version,
  purl: "pkg:" + type + "/" + purlName(name) + "@" + encodeURIComponent(version),
});
const bom = (name, components) => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: {type: "application", name},
    properties: [
      {name: "skyviewlab:evidence-status", value: "source-lock-not-container-sbom"},
      {name: "skyviewlab:generated-on", value: "2026-09-08"},
    ],
  },
  components,
});

const npmText = execFileSync(
  process.execPath,
  [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), "sbom", "--package-lock-only", "--omit=dev", "--sbom-format", "cyclonedx"],
  {cwd: path.join(workspace, "web_react"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024},
);
const npmBom = JSON.parse(npmText);
npmBom.metadata = npmBom.metadata ?? {};
npmBom.metadata.properties = [
  ...(npmBom.metadata.properties ?? []),
  {name: "skyviewlab:evidence-status", value: "package-lock-runtime-not-container-sbom"},
];
write("web-react-npm.cdx.json", npmBom);

const goMod = fs.readFileSync(path.join(workspace, "backend_go", "go.mod"), "utf8");
const goComponents = [...goMod.matchAll(/^\s*([a-z0-9._-]+\.[a-z0-9._/-]+)\s+(v[^\s]+)(?:\s+\/\/\s+indirect)?\s*$/gim)]
  .map((match) => component("golang", match[1], match[2]))
  .sort((a, b) => a.name.localeCompare(b.name, "en"));
write("backend-go-modules.cdx.json", bom("skyviewlab-backend-go", goComponents));

const pythonRequirements = fs.readFileSync(path.join(workspace, "backend_python", "requirements.txt"), "utf8");
const pythonComponents = pythonRequirements.split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => {
    const parts = line.split("==");
    if (parts.length !== 2) throw new Error("Python runtime requirement is not exactly pinned: " + line);
    return component("pypi", parts[0], parts[1]);
  })
  .sort((a, b) => a.name.localeCompare(b.name, "en"));
const pythonBom = bom("skyviewlab-backend-python-runtime-requirements", pythonComponents);
pythonBom.metadata.properties.push({
  name: "skyviewlab:scope-note",
  value: "Direct requirements only; resolved transitive and production image SBOM remain required.",
});
write("backend-python-requirements.cdx.json", pythonBom);

console.log("Wrote source SBOMs: npm=" + (npmBom.components?.length ?? 0) + ", go=" + goComponents.length + ", python=" + pythonComponents.length);
