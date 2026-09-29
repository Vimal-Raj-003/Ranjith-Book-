#!/usr/bin/env node
// Used only by tests/cancel.test.mts, to prove a cancelled run's child
// process is actually killed (SIGKILL) rather than merely abandoned by a
// promise that gives up waiting on it.
//
// Writes its own pid to the file named in argv[2] the instant it starts, then
// hangs forever — it only ever exits via a signal, never on its own.
import fs from "node:fs";

fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 60_000);
