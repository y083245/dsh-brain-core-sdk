#!/usr/bin/env node
import { main } from './main.ts'

process.exitCode = await main(process.argv.slice(2), { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) })
