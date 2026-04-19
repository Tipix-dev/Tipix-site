import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as tar from "tar";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 8080;

// =====================
// PATHS
// =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const STORAGE_DIR = path.join(__dirname, "public/pkg");

const TMP_DIR = path.join(__dirname, "tmp");

[STORAGE_DIR, TMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// =====================
// EJS
// =====================
app.set("view engine", "ejs");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// =====================
// MULTER
// =====================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname}`),
  }),
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith(".olsp")) {
      return cb(new Error("ONLY_OLSP_ALLOWED"));
    }
    cb(null, true);
  },
});

// =====================
// EXTRACT package.json
// =====================
async function extractPackageMeta(filePath) {
  const tempDir = fs.mkdtempSync(path.join(TMP_DIR, "ex-"));

  try {
    await tar.x({
      file: filePath,
      cwd: tempDir,
    });

    const findPkg = (dir) => {
      const files = fs.readdirSync(dir);

      for (const f of files) {
        const full = path.join(dir, f);

        if (f === "package.json") {
          return JSON.parse(fs.readFileSync(full, "utf-8"));
        }

        if (fs.statSync(full).isDirectory()) {
          const res = findPkg(full);
          if (res) return res;
        }
      }

      return null;
    };

    return findPkg(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// =====================
// FIND EXISTING PACKAGE
// =====================
function findExistingPackage(name) {
  const files = fs.readdirSync(STORAGE_DIR);

  const file = files.find(
    (f) => f.startsWith(name + "@") && f.endsWith(".olsp")
  );

  if (!file) return null;

  const match = file.match(/@(.+)\.olsp$/);

  return {
    file,
    version: match?.[1],
  };
}

// =====================
// SHA256
// =====================
function sha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

// =====================
// LIST PACKAGES
// =====================
function listPackages() {
  const files = fs.readdirSync(STORAGE_DIR);

  return files
    .filter((f) => f.endsWith(".olsp"))
    .map((file) => {
      const match = file.match(/(.+)@(.+)\.olsp/);

      return {
        name: match?.[1],
        version: match?.[2],
      };
    });
}

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/projects", (req, res) => {
  res.render("projects");
});

app.get("/p/OLS", (req, res) => {
  const packages = listPackages();
  res.render("projects/OLS/main", { packages });
});


app.get("/p/OLSP", (req, res) => {
  const packages = listPackages();
  res.render("projects/OLSP/main", { packages });
});

app.get("/p/OLSP/upload", (req, res) => {
  res.render("projects/OLSP/upload");
});

app.post("/api/upload", upload.single("package"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "NO_FILE" });
  }

  const tmpFile = req.file.path;

  const meta = await extractPackageMeta(tmpFile);

  if (!meta || !meta.name || !meta.version) {
    fs.unlinkSync(tmpFile);
    return res.status(400).json({ ok: false, error: "INVALID_PACKAGE" });
  }

  const { name, version, description, author } = meta;

  const existing = findExistingPackage(name);

  if (existing && existing.version === version) {
    fs.unlinkSync(tmpFile);
    return res.status(400).json({
      ok: false,
      error: "VERSION_ALREADY_EXISTS",
    });
  }

  const finalName = `${name}@${version}.olsp`;
  const finalPath = path.join(STORAGE_DIR, finalName);

  try {
    if (existing) {
      fs.unlinkSync(path.join(STORAGE_DIR, existing.file));
    }

    fs.copyFileSync(tmpFile, finalPath);

    
    fs.unlinkSync(tmpFile);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "FS_ERROR" });
  }

  return res.json({
    ok: true,
    name,
    version,
    description: description || "not description",
    author: author || "not author",
    checksum: sha256(finalPath),
    download: `/api/download/${name}`,
  });
});

app.get("/api/download/:name", (req, res) => {
  const { name } = req.params;

  const files = fs.readdirSync(STORAGE_DIR)
    .filter((f) => f.startsWith(name + "@"));

  if (files.length === 0) {
    return res.status(404).send("Package not found");
  }

  res.download(path.join(STORAGE_DIR, files[0]));
});


app.listen(PORT, () => {
  console.log(`OLSP running on ${PORT}`);
});