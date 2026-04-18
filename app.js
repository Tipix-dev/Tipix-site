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
const INDEX_FILE = join(STORAGE_DIR, "index.json");

[STORAGE_DIR, TMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =====================
// 📦 INDEX HELPERS
// =====================
function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return [];
  return JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
}

function saveIndex(pkg) {
  let index = loadIndex();

  index = index.filter(
    p => !(p.name === pkg.name && p.version === pkg.version)
  );

  index.push(pkg);

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

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
// 📦 READ PACKAGE.JSON FROM TAR
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

// =====================
// 📦 VERSION CHECK
// =====================
function versionExists(name, version) {
  return fs.readdirSync(STORAGE_DIR).some(file => {
    if (!file.endsWith(".olsp")) return false;
    const clean = file.replace(".olsp", "");
    const [n, v] = clean.split("@");
    return n === name && v === version;
  });
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
  const packages = loadIndex();
  res.render("projects/OLSP/main", { packages });
});

app.get("/p/OLSP/upload", (req, res) => {
  res.render("projects/OLSP/upload");
});

// =====================
// 📦 UPLOAD PIPELINE
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

  if (versionExists(name, version)) {
    fs.unlinkSync(req.file.path);
    return res.status(409).json({
      ok: false,
      error: "VERSION_ALREADY_EXISTS"
    });
  }

  const finalName = `${name}@${version}.olsp`;
  const finalPath = join(STORAGE_DIR, finalName);

  fs.renameSync(req.file.path, finalPath);

  saveIndex({
    name,
    version,
    description: description || "",
    author: author || ""
  });

  return res.json({
    ok: true,
    name,
    version,
    description,
    author,
    file: finalName,
    url: `/pkg/${name}/${version}`,
    latest: `/pkg/${name}/latest`
  });
});

// =====================
// ❌ NO GET FOR UPLOAD API
// =====================
app.get("/api/upload", (req, res) => {
  res.redirect("/p/OLSP/upload");
});

// =====================
// 🚀 START SERVER
// =====================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OLSP running on ${PORT}`);
});