import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import fs from "fs";
import * as tar from "tar";
const app = express();

const PORT = process.env.PORT || 8080;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// =====================
// 📦 STORAGE
// =====================
const STORAGE_DIR = join(__dirname, "public/pkg");
const TMP_DIR = "/tmp/olsp";

[STORAGE_DIR, TMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =====================
// 📦 MULTER
// =====================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, file.originalname)
  })
});

// =====================
// 📦 READ PACKAGE.JSON FROM TAR
// =====================
async function readPackage(filePath) {
  const tempDir = join(TMP_DIR, "ext-" + Date.now() + "-" + Math.random());

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    await tar.x({
      file: filePath,
      cwd: tempDir
    });

    const pkgPath = join(tempDir, "package.json");

    if (!fs.existsSync(pkgPath)) return null;

    return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    console.error("tar error:", err);
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// =====================
// 📦 VERSION CHECK
// =====================
function versionExists(name, version) {
  const files = fs.readdirSync(STORAGE_DIR);

  return files.some(file => {
    const clean = file.replace(".olsp", "");
    const [n, v] = clean.split("@");
    return n === name && v === version;
  });
}

// =====================
// 🌐 VIEW ENGINE
// =====================
app.set("view engine", "ejs");

app.get("/p/OLSP", (req, res) => {
  res.render("projects/OLSP/main");
});

app.get("/p/OLSP/upload", (req, res) => {
  res.render("projects/OLSP/upload");
});

// =====================
// 📦 UPLOAD (CORE)
// =====================
app.post("/api/upload", upload.single("package"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "NO_FILE"
    });
  }

  const tempPath = req.file.path;

  const pkg = await readPackage(tempPath);

  if (!pkg || !pkg.name || !pkg.version) {
    fs.unlinkSync(tempPath);
    return res.status(400).json({
      ok: false,
      error: "INVALID_PACKAGE"
    });
  }

  const { name, version } = pkg;

  // strict immutable version rule
  if (versionExists(name, version)) {
    fs.unlinkSync(tempPath);
    return res.status(409).json({
      ok: false,
      error: "VERSION_ALREADY_EXISTS"
    });
  }

  const finalName = `${name}@${version}.olsp`;
  const finalPath = join(STORAGE_DIR, finalName);

  fs.renameSync(tempPath, finalPath);

  return res.json({
    ok: true,
    name,
    version,
    file: finalName,
    url: `/pkg/${name}/${version}`,
    latest: `/pkg/${name}/latest`
  });
});

// =====================
// 🚀 SERVER START
// =====================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OLSP running on ${PORT}`);
});