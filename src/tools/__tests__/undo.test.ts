import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUndoTool } from '../undo.js'
import { FileHistory } from '../../agent/file-history.js'
import { cpuPool } from '../../workers/cpu-pool.js'

const TMP = join(import.meta.dirname, '.undo-test-tmp')
const BACKUP = join(import.meta.dirname, '.undo-test-backup')

// preview 路径（getDiffStats）会懒加载 spawn CPU worker；其 MessagePort
// 即使 unref 也会让 node:test runner 等不到进程退出而挂起。测试结束必须
// 显式 dispose（否则 tsx --test 在套件完成后永久挂起）。
after(() => {
  cpuPool.dispose()
})

describe('createUndoTool', () => {
  let history: FileHistory

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    mkdirSync(BACKUP, { recursive: true })
    history = new FileHistory(BACKUP, 'undo-session')
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    rmSync(BACKUP, { recursive: true, force: true })
  })

  it('returns error when no history available', async () => {
    const tool = createUndoTool(() => undefined)
    const result = await tool.execute({ input: {}, toolUseId: 't', cwd: '/' })
    assert.equal(result.isError, true)
  })

  it('shows preview without confirm', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    writeFileSync(file, 'v2')

    const tool = createUndoTool(() => history)
    const result = await tool.execute({ input: {}, toolUseId: 't', cwd: '/' })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('预览'))
    assert.ok(result.content.includes('a.txt'))
  })

  it('restores files with confirm', async () => {
    const file = join(TMP, 'a.txt')
    writeFileSync(file, 'v1')
    await history.trackEdit(file, 'msg_1')
    writeFileSync(file, 'v2')

    const tool = createUndoTool(() => history)
    const result = await tool.execute({ input: { confirm: true }, toolUseId: 't', cwd: '/' })
    assert.ok(result.content.includes('已恢复'))
    assert.equal(readFileSync(file, 'utf-8'), 'v1')
  })

  it('has correct tool name', () => {
    const tool = createUndoTool(() => undefined!)
    assert.equal(tool.definition.name, 'undo')
  })

  it('requires approval', () => {
    const tool = createUndoTool(() => undefined!)
    assert.equal(tool.requiresApproval({ input: {}, toolUseId: 't', cwd: '/' }), true)
  })
})
