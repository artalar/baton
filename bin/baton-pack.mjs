#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// Node >= 22.6 runs the TypeScript sources directly (no build step).
import { run } from "../src/cli/baton-pack.ts";
run();
