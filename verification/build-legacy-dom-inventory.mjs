import fs from "node:fs";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(workspace, "SkyViewLab-Internal-push-worktree");
const gateRoot = path.join(workspace, "verification", "acceptance", "_platform", "gate-a");
const routes = JSON.parse(fs.readFileSync(path.join(gateRoot, "01-legacy-baseline", "routes.json"), "utf8"));
const pageAssets = JSON.parse(fs.readFileSync(path.join(gateRoot, "01-legacy-baseline", "page-assets.json"), "utf8"));
const assetsById = new Map(pageAssets.map((entry) => [entry.id, entry.assets]));

const unique = (values) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
const attr = (tag, name) => {
  const pattern = "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))";
  const match = tag.match(new RegExp(pattern, "i"));
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : null;
};
const cleanText = (value) => value.replace(/<[^>]*>/g, " ").replace(/&[a-z0-9#]+;/gi, " ").replace(/\s+/g, " ").trim();
const tags = (source, name) => [...source.matchAll(new RegExp("<" + name + "\\b[^>]*>", "gi"))].map((match) => match[0]);
const paired = (source, name) => [...source.matchAll(new RegExp("<" + name + "\\b([^>]*)>([\\s\\S]*?)<\\/" + name + ">", "gi"))];
const dataAttributes = (source) => unique([...source.matchAll(/\b(data-[a-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi)]
  .map((match) => match[1].toLowerCase() + "=" + (match[2] ?? match[3] ?? match[4] ?? "")));

const inventory = routes.map((route) => {
  const htmlPath = path.join(sourceRoot, route.oldPath);
  const html = fs.readFileSync(htmlPath, "utf8");
  const scriptPaths = unique((assetsById.get(route.id) ?? [])
    .filter((item) => item.attribute === "src" && item.exists && item.path?.endsWith(".js"))
    .map((item) => item.path));
  const scriptSource = scriptPaths.map((item) => fs.readFileSync(path.join(sourceRoot, item), "utf8")).join("\n");
  const allSource = html + "\n" + scriptSource;
  const controls = ["input", "select", "textarea"].flatMap((name) => tags(html, name).map((tag) => ({
    element: name,
    id: attr(tag, "id"),
    name: attr(tag, "name"),
    type: attr(tag, "type"),
    placeholder: attr(tag, "placeholder"),
    required: /\brequired(?:\s|>|=)/i.test(tag),
    data: dataAttributes(tag),
  })));
  const buttons = paired(html, "button").map((match) => ({
    text: cleanText(match[2]),
    type: attr(match[0], "type"),
    data: dataAttributes(match[0]),
  }));
  const headings = ["h1", "h2", "h3"].flatMap((name) => paired(html, name).map((match) => ({
    level: name,
    text: cleanText(match[2]),
  })));
  const actionTokens = unique([
    ...allSource.matchAll(/\bdata-(?:action|view|tab|section|export|import|tool|mode)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi),
  ].map((match) => match[1] ?? match[2] ?? match[3]));
  const keyboardShortcuts = unique([
    ...allSource.matchAll(/(?:Ctrl|Meta|Alt|Shift)(?:\s*\+\s*[A-Za-z0-9]+)+/g),
  ].map((match) => match[0].replace(/\s+/g, "")));
  return {
    id: route.id,
    oldPath: route.oldPath,
    reactPath: route.reactPath,
    title: cleanText((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) ?? [null, ""])[1]),
    headings,
    staticControls: controls,
    staticButtons: buttons,
    dataAttributes: dataAttributes(allSource),
    actionTokens,
    keyboardShortcuts,
    referencedScripts: scriptPaths,
  };
});

const output = {
  schemaVersion: 1,
  baselineCommit: "8a754dcdb8ab97c7a90ca588693a17b21ee1f41b",
  note: "Static source inventory includes controls in HTML plus data-action tokens in referenced scripts. It is not a browser accessibility tree or interaction video.",
  routes: inventory,
};

fs.writeFileSync(
  path.join(gateRoot, "10-visual-a11y", "legacy-dom-fields.json"),
  JSON.stringify(output, null, 2) + "\n",
  "utf8",
);
console.log("Wrote " + inventory.length + " route inventories.");
