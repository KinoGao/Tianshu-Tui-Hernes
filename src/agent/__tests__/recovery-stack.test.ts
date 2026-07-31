import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { restoreLatestBackup, trackFileChange, trackFileRestore, renderRecoveryStack } from '../recovery-stack.js'
import { readUnacknowledged } from '../recovery-journal.js'

describe('recovery-stack', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-recovery-'))

  it('tracks file restore events in journal', () => {
    trackFileRestore(cwd, 'src/a.ts', 'undo tool restore', 5)
    const entries = readUnacknowledged(cwd)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.file, 'src/a.ts')
    assert.match(renderRecoveryStack(cwd), /src\/a.ts/)
  })

  it('records an actual backup restore, not the ordinary write backup', () => {
    const file = join(cwd, 'src', 'restore.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(file, 'before\n')

    trackFileChange(cwd, { filePath: 'src/restore.ts', action: 'edit', toolCallId: 'test' })
    assert.equal(readUnacknowledged(cwd, 'session-a').length, 0)

    writeFileSync(file, 'after\n')
    assert.equal(restoreLatestBackup(cwd, 'src/restore.ts', 'session-a'), true)
    assert.deepEqual(readUnacknowledged(cwd, 'session-a').map(entry => entry.file), ['src/restore.ts'])
  })

  after(() => {
    rmSync(cwd, { recursive: true, force: true })
  })
})
