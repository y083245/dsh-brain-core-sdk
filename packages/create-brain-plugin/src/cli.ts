#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { runCli } from './index.ts'

const readline = createInterface({ input: process.stdin, output: process.stdout })
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text) },
    stderr: (text) => { process.stderr.write(text) },
    question: (prompt) => readline.question(prompt),
  })
} finally {
  readline.close()
}
