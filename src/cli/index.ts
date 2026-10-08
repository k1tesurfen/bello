#!/usr/bin/env node
/** Bello CLI entry point (PLAN §2). */
import { main } from './program.js';

process.exitCode = await main(process.argv);
