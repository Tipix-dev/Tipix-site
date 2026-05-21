import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as tar from "tar";
import crypto from "crypto";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import MarkdownIt from "markdown-it";

const app = express();

const PORT = process.env.PORT || 8080;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const md = new MarkdownIt();

const tickets = new Map();

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
app.use(express.urlencoded({ extended: true }));

// =====================
// MULTER
// =====================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
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
    (f) => f.startsWith(name + "@") && f.endsWith(".olsp"),
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
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const ticketId =
        session.metadata?.ticketId ||
        session.payment_intent?.metadata?.ticketId;
      const ticket = tickets.get(ticketId);

      if (!ticket) return res.sendStatus(200);

      ticket.status = "paid";
      console.log("TICKET:", ticket);

      await sendEmail(ticket);

      console.log("AFTER EMAIL");
      console.log("🔥 WEBHOOK HIT");
      console.log("EVENT:", event.type);
    }

    res.sendStatus(200);
  },
);

const transporter = nodemailer.createTransport({
  host: "smtp.zoho.eu",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(ticket) {
  await transporter.sendMail({
    from: ticket.email,

    to: process.env.SMTP_USER,
    subject: `💰 Paid support: ${ticket.title}`,

    html: `
      <h2>${ticket.title}</h2>
      <p><b>User email:</b> ${ticket.email}</p>
      <div>${md.render(ticket.description)}</div>
      <p><b>ID:</b> ${ticket.id}</p>
    `,
  });
}

app.post("/support/create", async (req, res) => {
  try {
    const { title, description, email } = req.body;

    const ticketId = "t_" + Date.now();

    tickets.set(ticketId, {
      id: ticketId,
      title,
      description,
      email,
      status: "pending_payment",
    });
    console.log("FORM DATA:", req.body);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Tipix Support: " + title,
            },
            unit_amount: 1000,
          },
          quantity: 1,
        },
      ],

      metadata: { ticketId },

      payment_intent_data: {
        metadata: { ticketId }, // 🔥 ВОТ ЭТО ГЛАВНОЕ
      },

      success_url: `${process.env.BASE_URL}support/success?session_id={CHECKOUT_SESSION_ID}&ticket=${ticketId}`,
      cancel_url: `${process.env.BASE_URL}support`,
    });

    return res.redirect(session.url);
  } catch (err) {
    console.error("❌ SUPPORT CREATE ERROR:", err);
    return res.status(500).send("Internal Server Error");
  }
});

app.get("/support/success", async (req, res) => {
  try {
    console.log("SUCCESS QUERY:", req.query);

    const sessionId = req.query.session_id;

    if (!sessionId) {
      return res.status(400).send("Missing session_id");
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    console.log("SESSION:", session);

    const ticket = tickets.get(req.query.ticket);

    console.log("TICKET:", ticket);

    if (ticket) {
      sendEmail(ticket);
    }

    res.send("Payment OK 🚀");
    console.log("ALL TICKETS:", [...tickets.keys()]);
    console.log("LOOKING FOR:", req.query.ticket);
  } catch (err) {
    console.error("❌ SUCCESS ROUTE ERROR:");
    console.error(err);

    res.status(500).send(err.message);
  }
});

app.get("/support", (req, res) => {
  res.render("support/main");
});

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

  const files = fs
    .readdirSync(STORAGE_DIR)
    .filter((f) => f.startsWith(name + "@"));

  if (files.length === 0) {
    return res.status(404).send("Package not found");
  }

  res.download(path.join(STORAGE_DIR, files[0]));
});

app.use(express.json());

app.listen(PORT, () => {
  console.log(`OLSP running on ${PORT}`);
});
