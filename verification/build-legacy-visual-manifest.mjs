import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const gateRoot = path.join(workspace, "verification", "acceptance", "_platform", "gate-a");
const screenshotRoot = path.join(gateRoot, "10-visual-a11y", "legacy-desktop-1440x1000");
const routes = JSON.parse(fs.readFileSync(path.join(gateRoot, "01-legacy-baseline", "routes.json"), "utf8"));
const safeName = (oldPath) => oldPath.replace(/[\\/]/g, "-").replace(/\.html$/i, "");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const captures = routes.map((route) => {
  const file = route.id + "-" + safeName(route.oldPath) + ".png";
  const absolute = path.join(screenshotRoot, file);
  if (!fs.existsSync(absolute)) throw new Error("Missing screenshot: " + absolute);
  const size = fs.statSync(absolute).size;
  return {
    id: route.id,
    oldPath: route.oldPath,
    reactPath: route.reactPath,
    file: "legacy-desktop-1440x1000/" + file,
    bytes: size,
    sha256: sha256(absolute),
    captureStatus: "captured",
    reviewStatus: size < 100000 ? "needs-review-possible-loading-or-auth-state" : "pending-product-review",
  };
});

const manifest = {
  schemaVersion: 1,
  baselineCommit: "8a754dcdb8ab97c7a90ca588693a17b21ee1f41b",
  viewport: {width: 1440, height: 1000, deviceScaleFactor: 1},
  captureUrlBase: "http://127.0.0.1:4181/",
  browser: "Microsoft Edge 152.0.4191.66",
  note: "A capture proves that pixels were recorded, not that asynchronous content or every interaction is correct.",
  captures,
};

fs.writeFileSync(
  path.join(gateRoot, "10-visual-a11y", "visual-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
);
console.log("Wrote " + captures.length + " visual records.");
