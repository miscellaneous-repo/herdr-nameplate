#!/usr/bin/env node
// bin/ar.mjs — thin CLI wrapper. herdr invokes this file for every event.
import { main } from "../src/main.mjs";

const code = await main(process.argv.slice(2));
process.exit(code);