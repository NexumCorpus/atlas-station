#!/usr/bin/env node
'use strict';
// Credential-expiry sentinel status. Lists all tracked keys; exit 1 if any is EXPIRED.
const path = require("path");
const keys = require(path.join(__dirname, "..", "provider-keys.cjs"));
const rows = keys.status();
if (!rows.length) { console.log("no keys registered"); process.exit(0); }
let expired = false;
for (const r of rows) {
  if (r.state === "expired") expired = true;
  console.log((r.label || r.provider || "?") + ": " + r.state + (r.daysLeft != null ? " (" + r.daysLeft + "d left)" : "") + " fp:" + r.fingerprint);
}
process.exit(expired ? 1 : 0);