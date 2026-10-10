import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";

import { protectPrivateFile, writePrivateFile } from "./file-security.mjs";
import {
  CALLER_SECRET_PATH,
  CURSOR_PUBLIC_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  STATE_DIR,
} from "./paths.mjs";

const command = process.argv[2] || "status";
const generatedSecretPattern = /^[A-Za-z0-9_-]{32,}$/;
if (!new Set(["ensure", "status"]).has(command)) {
  console.error("Usage: secret.mjs ensure|status");
  process.exit(2);
}

function validSecret(target) {
  if (!existsSync(target)) return false;
  try {
    return generatedSecretPattern.test(readFileSync(target, "utf8").trim());
  } catch {
    return false;
  }
}

function ensureSecret(target) {
  if (!validSecret(target)) {
    writePrivateFile(target, `${randomBytes(48).toString("base64url")}\n`);
    return true;
  }
  return false;
}

function status(target, alreadyProtected = false) {
  const present = validSecret(target);
  if (present && !alreadyProtected) protectPrivateFile(target);
  return {
    present,
    mode: present ? statSync(target).mode & 0o777 : null,
  };
}

const newlyProtected = new Set();
if (command === "ensure") {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  for (const target of [INTERNAL_SECRET_PATH, CALLER_SECRET_PATH, CURSOR_PUBLIC_SECRET_PATH]) {
    if (ensureSecret(target)) newlyProtected.add(target);
  }
}

// Existing keys still get ACL repair on ensure and status. Keys published by
// this invocation already carried the private temporary's ACL through rename.
const internal = status(INTERNAL_SECRET_PATH, newlyProtected.has(INTERNAL_SECRET_PATH));
const caller = status(CALLER_SECRET_PATH, newlyProtected.has(CALLER_SECRET_PATH));
const cursorPublic = status(CURSOR_PUBLIC_SECRET_PATH, newlyProtected.has(CURSOR_PUBLIC_SECRET_PATH));
process.stdout.write(
  `${JSON.stringify({
    present: internal.present && caller.present && cursorPublic.present,
    mode: internal.mode,
    internal,
    caller,
    cursorPublic,
  })}\n`,
);
if (!internal.present || !caller.present || !cursorPublic.present) process.exitCode = 1;
