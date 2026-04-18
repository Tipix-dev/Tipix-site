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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// =====================
// 📦 MULTER
// =====================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith(".olsp")) {
      return cb(new Error("ONLY_OLSP_ALLOWED"));
    }
    cb(null, true);
  }
});

// =====================
// 📦 READ package.json FROM .olsp (tar)
// =====================
async function readPackageFromArchive(filePath) {
  const tempDir = fs.mkdtempSync("/tmp/olsp-");

  try {
    await tar.x({
      file: filePath,
      cwd: tempDir
    });

    const walk = (dir) => {
      const files = fs.readdirSync(dir);

      for (const file of files) {
        const full = join(dir, file);

        if (file === "package.json") {
          return JSON.parse(fs.readFileSync(full, "utf-8"));
        }

        if (fs.statSync(full).isDirectory()) {
          const res = walk(full);
          if (res) return res;
        }
      }

      return null;
    };

    return walk(tempDir);
  } catch (err) {
    console.error("readPackage error:", err);
    return null;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return [];

    const raw = fs.readFileSync(INDEX_FILE, "utf-8").trim();
    if (!raw) return [];

    return JSON.parse(raw);
  } catch (err) {
    console.error("INDEX PARSE ERROR:", err);
    return [];
  }
}

// =====================
// 🌐 VIEW ENGINE
// =====================
app.set("view engine", "ejs");
app.use(express.static(join(__dirname, "public")));

// =====================
// 🌐 ROUTES
// =====================
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/projects", (req, res) => {
  res.render("projects");
});

app.get("/p/OLS", (req, res) => {
  res.render("projects/OLS/main");
});

app.get("/p/OLSP", (req, res) => {
  let packages = loadIndex()
  res.render("projects/OLSP/main", { packages });
});

app.get("/p/OLSP/upload", (req, res) => {
  res.render("projects/OLSP/upload");
});

// =====================
// 📦 UPLOAD (OVERWRITE VERSION)
// =====================
app.post("/api/upload", upload.single("package"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "NO_FILE" });
  }

  const pkg = await readPackageFromArchive(req.file.path);

  if (!pkg || !pkg.name || !pkg.version) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ ok: false, error: "INVALID_PACKAGE" });
  }

  const { name, version, description, author } = pkg;

  const finalName = `${name}@${version}.olsp`;
  const finalPath = join(STORAGE_DIR, finalName);

  try {
    if (fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
    }

    fs.copyFileSync(req.file.path, finalPath);
    fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error("FS ERROR:", err);
    return res.status(500).json({ ok: false, error: "FS_ERROR" });
  }

  return res.json({
    ok: true,
    name,
    version,
    description: description || "",
    author: author || "",
    file: finalName,
    url: `/pkg/${name}/${version}`,
    latest: `/pkg/${name}/latest`
  });
});

// =====================
// 📥 DOWNLOAD LATEST VERSION
// =====================
app.get("/api/download/:name", (req, res) => {
  const { name } = req.params;

  const files = fs.readdirSync(STORAGE_DIR)
    .filter(f => f.startsWith(name + "@"))
    .sort();

  const latest = files.at(-1);

  if (!latest) {
    return res.status(404).send("Package not found");
  }

  const filePath = join(STORAGE_DIR, latest);

  res.download(filePath);
});

// =====================
// ❌ HANDLE WRONG METHOD
// =====================
app.all("/api/upload", (req, res) => {
  res.redirect("/p/OLSP");
});

// =====================
// 🚀 START SERVER
// =====================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OLSP running on ${PORT}`);
});