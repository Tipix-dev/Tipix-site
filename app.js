import "dotenv/config";

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
import { createClient } from "@supabase/supabase-js";

const app = express();

const PORT = process.env.PORT || 8080;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const md = new MarkdownIt();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// =====================
// CONSTANTS
// =====================

const SUPABASE_BUCKET = "pkg";

// Пока оставляем package.json.
// Когда переедешь на manifest.json,
// достаточно поменять эту строку.
const MANIFEST_FILE = "package.json";

const tickets = new Map();

// =====================
// PATHS
// =====================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ВАЖНО:
// Здесь больше НЕТ постоянного STORAGE_DIR.
//
// .olsp файлы теперь живут в Supabase Storage.
//
// tmp/ нужен только временно:
// загрузить архив -> проверить -> отправить в Supabase.
const TMP_DIR = path.join(__dirname, "tmp");

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

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
    destination: (req, file, cb) => {
      cb(null, TMP_DIR);
    },

    filename: (req, file, cb) => {
      cb(
        null,
        `${Date.now()}-${file.originalname}`,
      );
    },
  }),

  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith(".olsp")) {
      return cb(
        new Error("ONLY_OLSP_ALLOWED"),
      );
    }

    cb(null, true);
  },
});

// =====================
// EXTRACT MANIFEST
// =====================

async function extractPackageMeta(filePath) {
  const tempDir = fs.mkdtempSync(
    path.join(TMP_DIR, "ex-"),
  );

  try {
    await tar.x({
      file: filePath,
      cwd: tempDir,
    });

    const findManifest = (dir) => {
      const files = fs.readdirSync(dir);

      for (const file of files) {
        const fullPath = path.join(dir, file);

        if (file === MANIFEST_FILE) {
          return JSON.parse(
            fs.readFileSync(
              fullPath,
              "utf-8",
            ),
          );
        }

        if (
          fs.statSync(fullPath).isDirectory()
        ) {
          const result =
            findManifest(fullPath);

          if (result) {
            return result;
          }
        }
      }

      return null;
    };

    return findManifest(tempDir);
  } finally {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
    });
  }
}

// =====================
// LIST STORAGE FILES
// =====================

async function listStoragePackages() {
  const {
    data,
    error,
  } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .list("", {
      limit: 100,
    });

  if (error) {
    throw error;
  }

  return data.filter(
    (file) =>
      file.name.endsWith(".olsp"),
  );
}

// =====================
// FIND EXISTING PACKAGE
// =====================

async function listPackages() {
  const files = await listStoragePackages();

  const packages = [];

  for (const file of files) {
    const match = file.name.match(
      /(.+)@(.+)\.olsp$/,
    );

    if (!match) {
      continue;
    }

    try {
      const meta =
        await extractPackageMetaFromStorage(
          file.name,
        );

      if (!meta) {
        continue;
      }

      packages.push({
        name: meta.name || match[1],
        version: meta.version || match[2],
        author: meta.author || "not author",
        description:
          meta.description || "not description",
      });
    } catch (error) {
      console.error(
        `Failed to read manifest from ${file.name}:`,
        error,
      );
    }
  }

  return packages;
}

// =====================
// READ MANIFEST FROM STORAGE
// =====================

async function extractPackageMetaFromStorage(
  storagePath,
) {
  const {
    data,
    error,
  } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .download(storagePath);

  if (error) {
    throw error;
  }

  const arrayBuffer =
    await data.arrayBuffer();

  const buffer =
    Buffer.from(arrayBuffer);

  const tempFile = path.join(
    TMP_DIR,
    `storage-${crypto.randomUUID()}.olsp`,
  );

  fs.writeFileSync(
    tempFile,
    buffer,
  );

  try {
    return await extractPackageMeta(
      tempFile,
    );
  } finally {
    if (
      fs.existsSync(tempFile)
    ) {
      fs.unlinkSync(tempFile);
    }
  }
}

// =====================
// SHA256
// =====================

function sha256(filePath) {
  const data =
    fs.readFileSync(filePath);

  return crypto
    .createHash("sha256")
    .update(data)
    .digest("hex");
}

// =====================
// LIST PACKAGES
// =====================

async function listPackages() {
  const files =
    await listStoragePackages();
  return files
    .map((file) => {
      const match =
        file.name.match(
          /(.+)@(.+)\.olsp$/,
        );

      if (!match) {
        return null;
      }

      return {
        name: match[1],
        version: match[2],
      };
    })
    .filter(Boolean);
}

// =====================
// STRIPE WEBHOOK
// =====================

app.post(
  "/stripe/webhook",
  express.raw({
    type: "application/json",
  }),
  async (req, res) => {
    const sig =
      req.headers["stripe-signature"];

    let event;

    try {
      event =
        stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env
            .STRIPE_WEBHOOK_SECRET,
        );
    } catch (err) {
      return res
        .status(400)
        .send(
          `Webhook Error: ${err.message}`,
        );
    }

    if (
      event.type ===
      "checkout.session.completed"
    ) {
      const session =
        event.data.object;

      const ticketId =
        session.metadata?.ticketId ||
        session.payment_intent
          ?.metadata?.ticketId;

      const ticket =
        tickets.get(ticketId);

      if (!ticket) {
        return res.sendStatus(200);
      }

      ticket.status = "paid";

      console.log(
        "TICKET:",
        ticket,
      );

      await sendEmail(ticket);

      console.log(
        "AFTER EMAIL",
      );

      console.log(
        "🔥 WEBHOOK HIT",
      );

      console.log(
        "EVENT:",
        event.type,
      );
    }

    res.sendStatus(200);
  },
);

// =====================
// SMTP
// =====================

const transporter =
  nodemailer.createTransport({
    host: "smtp.zoho.eu",
    port: 587,
    secure: false,

    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

// =====================
// SEND EMAIL
// =====================

async function sendEmail(ticket) {
  await transporter.sendMail({
    from: ticket.email,

    to: process.env.SMTP_USER,

    subject:
      `💰 Paid support: ${ticket.title}`,

    html: `
      <h2>${ticket.title}</h2>

      <p>
        <b>User email:</b>
        ${ticket.email}
      </p>

      <div>
        ${md.render(ticket.description)}
      </div>

      <p>
        <b>ID:</b>
        ${ticket.id}
      </p>
    `,
  });
}

// =====================
// SUPPORT CREATE
// =====================

app.post(
  "/support/create",
  async (req, res) => {
    try {
      const {
        title,
        description,
        email,
      } = req.body;

      const ticketId =
        "t_" + Date.now();

      tickets.set(ticketId, {
        id: ticketId,
        title,
        description,
        email,
        status: "pending_payment",
      });

      console.log(
        "FORM DATA:",
        req.body,
      );

      const session =
        await stripe.checkout.sessions.create(
          {
            mode: "payment",

            payment_method_types: [
              "card",
            ],

            line_items: [
              {
                price_data: {
                  currency: "usd",

                  product_data: {
                    name:
                      "Tipix Support: " +
                      title,
                  },

                  unit_amount: 1000,
                },

                quantity: 1,
              },
            ],

            metadata: {
              ticketId,
            },

            payment_intent_data: {
              metadata: {
                ticketId,
              },
            },

            success_url:
              `${process.env.BASE_URL}` +
              `support/success` +
              `?session_id={CHECKOUT_SESSION_ID}` +
              `&ticket=${ticketId}`,

            cancel_url:
              `${process.env.BASE_URL}support`,
          },
        );

      return res.redirect(
        session.url,
      );
    } catch (err) {
      console.error(
        "❌ SUPPORT CREATE ERROR:",
        err,
      );

      return res
        .status(500)
        .send(
          "Internal Server Error",
        );
    }
  },
);

// =====================
// SUPPORT SUCCESS
// =====================

app.get(
  "/support/success",
  async (req, res) => {
    try {
      console.log(
        "SUCCESS QUERY:",
        req.query,
      );

      const sessionId =
        req.query.session_id;

      if (!sessionId) {
        return res
          .status(400)
          .send(
            "Missing session_id",
          );
      }

      const session =
        await stripe.checkout.sessions.retrieve(
          sessionId,
        );

      console.log(
        "SESSION:",
        session,
      );

      const ticket =
        tickets.get(
          req.query.ticket,
        );

      console.log(
        "TICKET:",
        ticket,
      );

      if (ticket) {
        sendEmail(ticket);
      }

      res.send(
        "Payment OK 🚀",
      );

      console.log(
        "ALL TICKETS:",
        [...tickets.keys()],
      );

      console.log(
        "LOOKING FOR:",
        req.query.ticket,
      );
    } catch (err) {
      console.error(
        "❌ SUCCESS ROUTE ERROR:",
      );

      console.error(err);

      res
        .status(500)
        .send(err.message);
    }
  },
);

// =====================
// SUPPORT
// =====================

app.get(
  "/support",
  (req, res) => {
    res.render(
      "support/main",
    );
  },
);

// =====================
// HOME
// =====================

app.get(
  "/",
  (req, res) => {
    res.render("index");
  },
);

// =====================
// PROJECTS
// =====================

app.get(
  "/projects",
  (req, res) => {
    res.render("projects");
  },
);

// =====================
// OLS
// =====================

app.get(
  "/p/OLS",
  (req, res) => {
    res.render(
      "projects/OLS/main",
    );
  },
);

// =====================
// OLSP
// =====================

app.get(
  "/p/OLSP",
  async (req, res) => {
    try {
      const packages =
        await listPackages();

      res.render(
        "projects/OLSP/main",
        {
          packages,
        },
      );
    } catch (err) {
      console.error(
        "❌ LIST PACKAGES ERROR:",
        err,
      );

      res
        .status(500)
        .send(
          "Failed to load packages",
        );
    }
  },
);

// =====================
// OLSP UPLOAD PAGE
// =====================

app.get(
  "/p/OLSP/upload",
  (req, res) => {
    res.render(
      "projects/OLSP/upload",
    );
  },
);

// =====================
// UPLOAD OLSP
// =====================

app.post(
  "/api/upload",
  upload.single("package"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "NO_FILE",
      });
    }

    const tmpFile =
      req.file.path;

    try {
      // =====================
      // READ NEW MANIFEST
      // =====================

      const meta =
        await extractPackageMeta(
          tmpFile,
        );

      if (
        !meta ||
        !meta.name ||
        !meta.version ||
        !meta.author
      ) {
        fs.unlinkSync(
          tmpFile,
        );

        return res.status(400).json({
          ok: false,
          error:
            "INVALID_PACKAGE_MANIFEST",
        });
      }

      const {
        name,
        version,
        description,
        author,
      } = meta;

      // =====================
      // CHECK FILE NAME
      // =====================

      const finalName =
        `${name}@${version}.olsp`;

      // =====================
      // FIND EXISTING PACKAGE
      // =====================

      const existing =
        await findExistingPackage(
          name,
        );

      // =====================
      // SAME VERSION
      // =====================

      if (
        existing &&
        existing.version === version
      ) {
        fs.unlinkSync(
          tmpFile,
        );

        return res.status(400).json({
          ok: false,
          error:
            "VERSION_ALREADY_EXISTS",
        });
      }

      // =====================
      // AUTHOR CHECK
      // =====================

      if (existing) {
        console.log(
          `Checking author for ${name}`,
        );

        console.log(
          `Existing package: ${existing.file}`,
        );

        const oldMeta =
          await extractPackageMetaFromStorage(
            existing.file,
          );

        if (
          !oldMeta ||
          !oldMeta.author
        ) {
          fs.unlinkSync(
            tmpFile,
          );

          return res.status(409).json({
            ok: false,
            error:
              "EXISTING_PACKAGE_HAS_NO_AUTHOR",
          });
        }

        console.log(
          "OLD AUTHOR:",
          oldMeta.author,
        );

        console.log(
          "NEW AUTHOR:",
          author,
        );

        if (
          oldMeta.author !== author
        ) {
          fs.unlinkSync(
            tmpFile,
          );

          return res.status(403).json({
            ok: false,
            error:
              "AUTHOR_MISMATCH",
          });
        }

        console.log(
          "✅ AUTHOR MATCH",
        );
      }

      // =====================
      // SHA256
      // =====================

      const checksum =
        sha256(tmpFile);

      // =====================
      // READ FILE
      // =====================

      const fileBuffer =
        fs.readFileSync(
          tmpFile,
        );

      // =====================
      // UPLOAD NEW VERSION
      // =====================

      console.log(
        `Uploading ${finalName}...`,
      );

      const {
        error: uploadError,
      } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(
          finalName,
          fileBuffer,
          {
            contentType:
              "application/octet-stream",

            upsert: false,
          },
        );

      if (uploadError) {
        console.error(
          "❌ SUPABASE UPLOAD ERROR:",
          uploadError,
        );

        fs.unlinkSync(
          tmpFile,
        );

        return res.status(500).json({
          ok: false,
          error:
            "STORAGE_UPLOAD_ERROR",
        });
      }

      console.log(
        `✅ Uploaded ${finalName}`,
      );

      // =====================
      // DELETE OLD VERSION
      // =====================

      if (existing) {
        console.log(
          `Deleting old version: ${existing.file}`,
        );

        const {
          error: deleteError,
        } = await supabase.storage
          .from(SUPABASE_BUCKET)
          .remove([
            existing.file,
          ]);

        if (deleteError) {
          console.error(
            "❌ DELETE OLD PACKAGE ERROR:",
            deleteError,
          );

          // Новая версия уже загружена.
          // Старую пока оставляем.
          //
          // Это лучше, чем потерять пакет.
          //
          // В результате временно могут
          // существовать две версии.

          fs.unlinkSync(
            tmpFile,
          );

          return res.status(500).json({
            ok: false,
            error:
              "STORAGE_DELETE_ERROR",
          });
        }

        console.log(
          `✅ Deleted ${existing.file}`,
        );
      }

      // =====================
      // DELETE TEMP FILE
      // =====================

      fs.unlinkSync(
        tmpFile,
      );

      // =====================
      // RESPONSE
      // =====================

      return res.json({
        ok: true,

        name,
        version,

        description:
          description ||
          "not description",

        author:
          author ||
          "not author",

        checksum,

        download:
          `/api/download/${encodeURIComponent(
            name,
          )}`,
      });
    } catch (err) {
      console.error(
        "❌ UPLOAD ERROR:",
        err,
      );

      if (
        fs.existsSync(tmpFile)
      ) {
        fs.unlinkSync(
          tmpFile,
        );
      }

      return res.status(500).json({
        ok: false,
        error: "UPLOAD_ERROR",
      });
    }
  },
);

// =====================
// DOWNLOAD OLSP
// =====================

app.get(
  "/api/download/:name",
  async (req, res) => {
    const { name } =
      req.params;

    try {
      // =====================
      // FIND PACKAGE
      // =====================

      const files =
        await listStoragePackages();

      const file = files.find(
        (file) =>
          file.name.startsWith(
            `${name}@`,
          ),
      );

      if (!file) {
        return res
          .status(404)
          .send(
            "Package not found",
          );
      }

      // =====================
      // DOWNLOAD
      // =====================

      const {
        data,
        error,
      } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .download(
          file.name,
        );

      if (error) {
        console.error(
          "❌ STORAGE DOWNLOAD ERROR:",
          error,
        );

        return res
          .status(500)
          .send(
            "Download error",
          );
      }

      const arrayBuffer =
        await data.arrayBuffer();

      const buffer =
        Buffer.from(
          arrayBuffer,
        );

      // =====================
      // RESPONSE
      // =====================

      res.setHeader(
        "Content-Type",
        "application/octet-stream",
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${file.name}"`,
      );

      res.setHeader(
        "Content-Length",
        buffer.length,
      );

      return res.send(
        buffer,
      );
    } catch (err) {
      console.error(
        "❌ DOWNLOAD ERROR:",
        err,
      );

      return res
        .status(500)
        .send(
          "Download error",
        );
    }
  },
);

// =====================
// JSON
// =====================

app.use(
  express.json(),
);

// =====================
// SERVER
// =====================

app.listen(
  PORT,
  () => {
    console.log(
      `OLSP running on ${PORT}`,
    );
  },
);
