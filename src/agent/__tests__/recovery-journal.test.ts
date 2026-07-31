import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acknowledgeAll, handoffRecoveries, readUnacknowledged, recordRecovery } from '../recovery-journal.js'

describe('recovery journal session isolation', () => {
  const dirs: string[] = []

  function cwd(): string {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-recovery-journal-'))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('does not expose another session or legacy journal entries as current recovery work', () => {
    const dir = cwd()
    recordRecovery(dir, { file: 'src/old.ts', action: 'restore', linesLost: 2 }, 'old-session')
    recordRecovery(dir, { file: 'src/current.ts', action: 'restore', linesLost: 1 }, 'current-session')
    recordRecovery(dir, { file: 'src/legacy.ts', action: 'restore', linesLost: 1 })

    assert.deepEqual(readUnacknowledged(dir, 'current-session').map(entry => entry.file), ['src/current.ts'])
  })

  it('acknowledges or hands off only the source session while preserving peer entries', () => {
    const dir = cwd()
    recordRecovery(dir, { file: 'src/a.ts', action: 'restore', linesLost: 1 }, 'source')
    recordRecovery(dir, { file: 'src/b.ts', action: 'restore', linesLost: 1 }, 'peer')

    handoffRecoveries(dir, 'source')
    assert.equal(readUnacknowledged(dir, 'source').length, 0)
    assert.deepEqual(readUnacknowledged(dir, 'peer').map(entry => entry.file), ['src/b.ts'])

    acknowledgeAll(dir, 'peer')
    assert.equal(readUnacknowledged(dir, 'peer').length, 0)
  })
})
