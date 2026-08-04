import type { Tool } from './types.js'
import { skillRegistry, listSkillFiles } from '../skills/skill-loader.js'

/**
 * Tier-2 skill activation. The discovery block (volatile appendix) lists every
 * available skill's name + description; this tool loads the FULL body of one of
 * them on demand. The body is returned as an ordinary tool result ? append-only
 * to history ? so the whole session can see it. There is NO truncation here;
 * oversized bodies are handled by the tool pipeline's existing artifact
 * intercept, the same as any other large tool output.
 *
 * The static definition deliberately does NOT embed any concrete skill name, so
 * the tool description stays byte-stable across sessions and the prefix cache is
 * preserved. The set of loadable skills lives only in the volatile discovery
 * block.
 */
export const SKILL_TOOL: Tool = {
  definition: {
    name: 'skill',
    description: `??????? skill ???????????

skill ???????? playbook?available-skills ??????? skill ?????????? skill ?????????????????????????????????????????

??????? skill ???? skill(name="<name>", complete=true) ?????????????? skill ???????????????

???skill(name="brainstorming")`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '????????? skill ??????? available-skills ????' },
        complete: { type: 'boolean', description: '? true ???? skill ?????????????? skill ???????????????' },
      },
      required: ['name'],
    },
  },

  async execute(params) {
    const raw = params.input.name
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: '???name ??', isError: true }
    }
    const name = raw.trim()

    const skill = skillRegistry.get(name) ?? skillRegistry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
    if (!skill) {
      const available = skillRegistry.list().map(s => s.name).sort()
      const list = available.length > 0 ? available.join(', ') : '?????? skill?'
      return {
        content: `??? skill??${name}??\n?? skill?${list}`,
        isError: true,
      }
    }

    if (params.input.complete === true) {
      params.onSkillCompleted?.(skill.name)
      return { content: `Skill?${skill.name}????????`, uiContent: `??? skill?${skill.name}` }
    }

    params.onSkillInvoked?.(skill.name)

    const body = `<skill name="${skill.name}">\n${skill.body}\n</skill>`
    // Flat (no skillDir) skills have no sub-files ? return body as-is.
    if (!skill.skillDir) {
      return { content: body, uiContent: `??? skill?${skill.name}` }
    }
    const files = listSkillFiles(skill.skillDir)
    if (files.length === 0) {
      return { content: body, uiContent: `??? skill?${skill.name}` }
    }
    // Directory skill: append the sub-file tree so the model knows what it can
    // read on demand (Tier-3). The body itself is never truncated.
    const tree = files.map(f => `  ${f.path}`).join('\n')
    const filesBlock = [
      `<skill-files dir="${skill.skillDir}" note="?????????? read_file/grep/glob ??????????????????? read_file(focus=...) ??????????? offset/limit ???????????????">`,
      tree,
      '</skill-files>',
    ].join('\n')
    return {
      content: `${body}\n${filesBlock}`,
      uiContent: `??? skill?${skill.name}?+${files.length} ????`,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
