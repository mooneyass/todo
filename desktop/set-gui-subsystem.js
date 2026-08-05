// Flips a Windows executable from the console subsystem to the GUI subsystem,
// so launching it doesn't create a console window.
//
// node.exe is built as a console program, and Windows decides whether to spawn
// a console purely from this one field in the PE header — before any of our
// code runs, so it can't be undone from inside the process.
//
// Usage: node desktop/set-gui-subsystem.js dist/RoundTuit.exe

"use strict";

const fs = require("node:fs");

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3; // console

const file = process.argv[2];
if (!file) {
  console.error("usage: node set-gui-subsystem.js <exe>");
  process.exit(1);
}

// Antivirus tends to scan a freshly written 80MB binary, holding it open for a
// second or two. Retry rather than failing the build over it.
function withRetries(what, action, attempts = 20, waitMs = 500) {
  for (let i = 1; ; i++) {
    try {
      return action();
    } catch (err) {
      if (err.code !== "EBUSY" && err.code !== "EPERM") throw err;
      if (i >= attempts) {
        console.error(`Could not ${what}: the file stayed locked for ${(attempts * waitMs) / 1000}s.`);
        throw err;
      }
      if (i === 1) console.log("     file is locked, waiting for it to be released...");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

const buf = withRetries("read the executable", () => fs.readFileSync(file));

// DOS header: "MZ", with the PE header's offset stored at 0x3C.
if (buf.readUInt16LE(0) !== 0x5a4d) {
  console.error(`${file} is not a Windows executable (no MZ signature).`);
  process.exit(1);
}
const peOffset = buf.readUInt32LE(0x3c);

if (buf.readUInt32LE(peOffset) !== 0x00004550) {
  console.error(`${file} has no PE signature at 0x${peOffset.toString(16)}.`);
  process.exit(1);
}

// PE signature (4) + COFF header (20) lands on the optional header. The
// Subsystem field sits 68 bytes into it — the same offset for PE32 and PE32+,
// since PE32's extra BaseOfData field is offset by its smaller ImageBase.
const optionalHeader = peOffset + 24;
const subsystemAt = optionalHeader + 68;

const magic = buf.readUInt16LE(optionalHeader);
if (magic !== 0x10b && magic !== 0x20b) {
  console.error(`Unexpected optional header magic 0x${magic.toString(16)}.`);
  process.exit(1);
}

const current = buf.readUInt16LE(subsystemAt);
if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
  console.log("     already GUI subsystem, nothing to do");
  process.exit(0);
}
if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
  console.error(`Refusing to patch: subsystem is ${current}, expected console (3).`);
  process.exit(1);
}

buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystemAt);
withRetries("write the executable", () => fs.writeFileSync(file, buf));
console.log("     console -> GUI subsystem (no console window)");
