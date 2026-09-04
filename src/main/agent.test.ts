import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCodingAgentSystemPrompt,
  commandDenialReason,
  compactConversation,
  MAX_CONVERSATION_CHARACTERS,
  normalizeWorkerPath,
  runCodingAgent,
  type WorkerTask
} from './agent'
import { ProjectTools } from './project-tools'

const temporaryDirectories: string[] = []

describe('normalizeWorkerPath', () => {
  it('collapses Windows case and trailing-dot aliases without changing Linux case', () => {
    expect(normalizeWorkerPath('./Src/Index.ts. ', 'win32')).toBe('src/index.ts')
    expect(normalizeWorkerPath('src\\INDEX.ts', 'win32')).toBe('src/index.ts')
    expect(normalizeWorkerPath('Src/Index.ts', 'linux')).toBe('Src/Index.ts')
  })
})

describe('agent guardrails', () => {
  it('builds a focused Stellan prompt with coordinator and child-worker rules', () => {
    const coordinator = buildCodingAgentSystemPrompt({
      isGitRepository: true,
      spawnWorkers: vi.fn(),
      writeScope: undefined
    })
    const child = buildCodingAgentSystemPrompt({
      isGitRepository: true,
      spawnWorkers: undefined,
      writeScope: new Set(['src/index.ts'])
    })

    expect(coordinator).toContain('Tu es Stellan')
    expect(coordinator).toContain('Aucun fichier ne doit appartenir à deux workers')
    expect(coordinator).toContain('css/styles.css en une seule entrée')
    expect(coordinator).toContain('les autres attendent automatiquement')
    expect(coordinator).toContain('une seule nouvelle tentative worker est permise')
    expect(coordinator).toContain('Ne répète pas aveuglément la même action')
    expect(coordinator).toContain('appelle les outils de fichiers au lieu de lui donner du code à copier')
    expect(coordinator).toContain('Le fait qu’un projet soit ouvert ne signifie pas que chaque demande concerne son code')
    expect(coordinator).toContain('réponds directement sans outil')
    expect(coordinator).toContain('Ne simule pas toi-même un état ou une vérification')
    expect(coordinator).toContain('avance avec l’hypothèse la plus raisonnable')
    expect(coordinator).toContain('action à risque élevé exige une confirmation')
    expect(coordinator).toContain('Ne crée un commit ou un push que si l’utilisateur le demande explicitement')
    expect(child).toContain('tu ne modifies que les chemins de fichiers exacts')
    expect(child).toContain('write_file crée automatiquement leurs dossiers parents')
    expect(coordinator.length).toBeLessThan(10_000)

    const advised = buildCodingAgentSystemPrompt({
      isGitRepository: true,
      spawnWorkers: undefined,
      writeScope: undefined,
      consultAdvisor: vi.fn()
    })
    expect(advised).toContain('utilise consult_advisor avec une question précise')

    const activityPrompt = buildCodingAgentSystemPrompt({
      isGitRepository: false,
      startActivity: vi.fn(),
      activityContext: '{"activityId":"active-id","publicView":{"word":"_ _ _ _"}}'
    })
    expect(activityPrompt).toContain('activity_start pour démarrer, puis activity_action')
    expect(activityPrompt).toContain('état public autoritatif')
    expect(activityPrompt).not.toContain('mot secret')
  })

  it('keeps an explicitly conversational request in the chat without forcing file tools', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { message: { content: 'Très bien. Je pense à quelque chose qui éclaire la nuit. Que proposes-tu ?' }, done: true }
    ]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Je veux jouer à une devinette avec toi dans le chat, pas de code.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith(expect.stringContaining('Que proposes-tu'))
  })

  it('consults a local read-only advisor and returns its result to the main model', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'consult_advisor', arguments: { question: 'Quel compromis choisir ?' } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Je retiens le compromis vérifié.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const consultAdvisor = vi.fn().mockResolvedValue({ model: 'granite4.1:8b', advice: 'Choisir la solution A.' })

    await runCodingAgent({
      model: 'qwen3.5:9b',
      messages: [{ role: 'user', content: 'Analyse ce compromis architectural complexe.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      consultAdvisor
    })

    expect(consultAdvisor).toHaveBeenCalledWith('Quel compromis choisir ?')
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('Choisir la solution A.')
  })

  it('blocks destructive command bypasses and gates Git writes', () => {
    const none = { gitCommit: false, gitPush: false }

    expect(commandDenialReason('rm', ['-rf', '.'], none)).toMatch(/bloquée/)
    expect(commandDenialReason('rm.exe', ['-rf', '.'], none)).toMatch(/bloquée/)
    expect(commandDenialReason('busybox', ['rm', '-rf', '.'], none)).toMatch(/bloquée/)
    expect(commandDenialReason('powershell.exe', ['-Command', 'Remove-Item'], none)).toMatch(/bloquée/)
    expect(commandDenialReason('node', ['--eval', 'deleteEverything()'], none)).toMatch(/bloquée/)
    expect(commandDenialReason('find', ['.', '-delete'], none)).toMatch(/bloquées/)
    expect(commandDenialReason('git', ['status'], none)).toBeNull()
    expect(commandDenialReason('git', ['commit', '-m', 'change'], none)).toMatch(/explicitement/)
    expect(commandDenialReason('git', ['commit', '-m', 'change'], { ...none, gitCommit: true })).toBeNull()
    expect(commandDenialReason('git', ['push'], { ...none, gitPush: true })).toBeNull()
    expect(commandDenialReason('git', ['reset', '--hard'], { gitCommit: true, gitPush: true })).toMatch(/n’est pas autorisée/)
  })
})

function streamResponse(lines: unknown[]): Response {
  const body = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return new Response(body, { status: 200 })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true })
  ))
})

describe('runCodingAgent', () => {
  it('starts a reliable activity with only the activity tool and formats the trusted result', async () => {
    const startActivity = vi.fn().mockReturnValue({
      ok: true,
      activityId: 'b7eeae4c-bf63-4ac6-908e-ee3204766a7c',
      engineId: 'hangman',
      version: 0,
      status: 'active',
      message: 'L’activité est démarrée.',
      publicView: { word: '_ _ _ _', letterCount: 4, remainingAttempts: 6 }
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [{ function: { name: 'activity_start', arguments: { engineId: 'hangman', input: { difficulty: 'facile' } } } }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Le mot comporte 4 lettres : _ _ _ _. Tu as 6 essais.' },
        done: true
      }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'un pend uça te dit ?' }],
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      startActivity,
      applyActivity: vi.fn()
    })

    expect(startActivity).toHaveBeenCalledWith('hangman', { difficulty: 'facile' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['activity_start'])
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).not.toContain('todo_write')
    expect(onContent).toHaveBeenCalledWith(expect.stringContaining('Mot à deviner :\n_ _ _ _ (4 lettres)'))
  })

  it('suppresses an invented hangman answer and forces the reliable engine instead', async () => {
    const startActivity = vi.fn().mockReturnValue({
      ok: true,
      activityId: 'b7eeae4c-bf63-4ac6-908e-ee3204766a7c',
      engineId: 'hangman',
      version: 0,
      status: 'active',
      message: 'L’activité est démarrée.',
      publicView: { word: '_ _ _ _', letterCount: 4, remainingAttempts: 6 }
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Mon mot secret est PHOTOSHOP.' },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [{ function: { name: 'activity_start', arguments: { engineId: 'hangman', input: { difficulty: 'facile' } } } }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Le mot comporte 4 lettres : _ _ _ _. Propose une lettre.' },
        done: true
      }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Viens, on joue une partie de pendu.' }],
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      startActivity,
      applyActivity: vi.fn()
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(startActivity).toHaveBeenCalledOnce()
    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).not.toHaveBeenCalledWith(expect.stringContaining('PHOTOSHOP'))
  })

  it('treats a website about hangman as software work instead of starting the game', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{
          function: {
            name: 'write_file',
            arguments: { path: 'index.html', content: '<h1>Jeu du pendu</h1>\n' }
          }
        }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Le site du pendu est créé.' },
        done: true
      }]))
    vi.stubGlobal('fetch', fetcher)
    const startActivity = vi.fn()
    const applyActivity = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée-moi un site web sur le jeu du pendu.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      startActivity,
      applyActivity
    })

    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    const toolNames = request.tools.map((tool: { function: { name: string } }) => tool.function.name)
    expect(toolNames).toContain('write_file')
    expect(toolNames).not.toContain('activity_start')
    expect(toolNames).not.toContain('activity_action')
    expect(startActivity).not.toHaveBeenCalled()
    expect(applyActivity).not.toHaveBeenCalled()
    await expect(readFile(join(projectPath, 'index.html'), 'utf8')).resolves.toBe('<h1>Jeu du pendu</h1>\n')
  })

  it('explains hangman rules without starting or continuing the activity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([{
      message: { content: 'Le but est de deviner le mot lettre par lettre.' }, done: true
    }]))
    vi.stubGlobal('fetch', fetcher)
    const startActivity = vi.fn()
    const applyActivity = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Explique-moi les règles du pendu.' }],
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: '{"activityId":"active","engineId":"hangman","publicView":{"word":"_ _ _ _"}}',
      startActivity,
      applyActivity
    })

    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name.startsWith('activity_'))).toBe(false)
    expect(startActivity).not.toHaveBeenCalled()
    expect(applyActivity).not.toHaveBeenCalled()
  })

  it('plays an unsupported conversational game without starting hangman', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([{
      message: { content: 'D’accord. Pose-moi des questions, je ne dois dire ni oui ni non !' }, done: true
    }]))
    vi.stubGlobal('fetch', fetcher)
    const startActivity = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Viens, on joue au ni oui ni non.' }],
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      startActivity,
      applyActivity: vi.fn(),
      intentClassification: {
        intent: 'activity',
        clear: false,
        source: 'model',
        reason: 'model-classification'
      }
    })

    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name.startsWith('activity_'))).toBe(false)
    expect(startActivity).not.toHaveBeenCalled()
  })

  it('leaves an active hangman game when the user asks to build a hangman website', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{
          function: {
            name: 'write_file',
            arguments: { path: 'index.html', content: '<h1>Pendu</h1>\n' }
          }
        }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Le site est construit dans le projet.' },
        done: true
      }]))
    vi.stubGlobal('fetch', fetcher)
    const startActivity = vi.fn()
    const applyActivity = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée une page web pour jouer au pendu.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: '{"activityId":"active","engineId":"hangman","publicView":{"word":"_ _ _ _"}}',
      startActivity,
      applyActivity
    })

    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(request.messages[0].content).not.toContain('ACTIVITÉ FIABLE ACTIVE')
    expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name.startsWith('activity_'))).toBe(false)
    expect(startActivity).not.toHaveBeenCalled()
    expect(applyActivity).not.toHaveBeenCalled()
  })

  it('applies a single-letter guess directly without an inference call', async () => {
    const applyActivity = vi.fn().mockReturnValue({
      ok: false,
      error: {
        code: 'LETTER_ALREADY_PLAYED',
        message: 'La lettre A a déjà été proposée.',
        retryable: true
      },
      publicView: { word: '_ _ A _', remainingAttempts: 6 }
    })
    const fetcher = vi.fn<typeof fetch>((url) => Promise.resolve(
      String(url).endsWith('/api/ps')
        ? new Response(JSON.stringify({ models: [] }), { status: 200 })
        : streamResponse([{
            message: {
              tool_calls: [{ function: { name: 'activity_action', arguments: { action: { type: 'guess', letter: 'A' } } } }]
            },
            done: true
          }])
    ))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()
    const onInferenceLog = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'A' }],
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      onInferenceLog,
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: '{"activityId":"b7eeae4c-bf63-4ac6-908e-ee3204766a7c","engineId":"hangman","version":1,"publicView":{"word":"_ _ A _","remainingAttempts":6}}',
      startActivity: vi.fn(),
      applyActivity
    })

    expect(applyActivity).toHaveBeenCalledWith(undefined, { type: 'guess', letter: 'A' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(onInferenceLog).toHaveBeenCalledWith(expect.stringMatching(/directActivity=true completedSteps=0$/))
    expect(onContent).toHaveBeenCalledWith('La lettre A a déjà été proposée.')
  })

  it('suppresses an invented hint and forces the trusted hint action', async () => {
    const applyActivity = vi.fn().mockReturnValue({
      ok: true,
      activityId: 'b7eeae4c-bf63-4ac6-908e-ee3204766a7c',
      engineId: 'hangman',
      version: 2,
      status: 'active',
      message: 'C’est un animal domestique connu pour ronronner.',
      publicView: {
        word: '_ _ A _',
        guessedLetters: ['A'],
        hint: 'C’est un animal domestique connu pour ronronner.',
        remainingAttempts: 6
      }
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'La première lettre est peut-être G.' },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'activity_action', arguments: { action: { type: 'hint' } } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Indice : c’est un animal domestique connu pour ronronner.' },
        done: true
      }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Donne-moi un indice.' }],
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: '{"activityId":"b7eeae4c-bf63-4ac6-908e-ee3204766a7c","engineId":"hangman","publicView":{"word":"_ _ A _"}}',
      startActivity: vi.fn(),
      applyActivity
    })

    expect(applyActivity).toHaveBeenCalledWith(undefined, { type: 'hint' })
    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).not.toHaveBeenCalledWith(expect.stringContaining('peut-être G'))
    expect(onContent).toHaveBeenCalledWith(expect.stringContaining('ronronner'))
  })

  it('returns the engine refusal directly for unsupported active-activity requests', async () => {
    const applyActivity = vi.fn().mockReturnValue({
      ok: false,
      error: {
        code: 'UNSUPPORTED_ACTIVITY_REQUEST',
        message: 'Je ne peux pas faire cela sans inventer.',
        retryable: true
      },
      publicView: { word: '_ _ _ _' }
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([{
      message: { tool_calls: [{ function: { name: 'activity_action', arguments: { action: { type: 'unsupported' } } } }] },
      done: true
    }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Donne-moi une fausse première lettre.' }],
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: '{"activityId":"b7eeae4c-bf63-4ac6-908e-ee3204766a7c","engineId":"hangman","publicView":{"word":"_ _ _ _"}}',
      startActivity: vi.fn(),
      applyActivity
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith('Je ne peux pas faire cela sans inventer.')
  })

  it('closes an active activity in code and handles the remaining message as normal conversation', async () => {
    const applyActivity = vi.fn().mockReturnValue({
      ok: true,
      activityId: 'b7eeae4c-bf63-4ac6-908e-ee3204766a7c',
      engineId: 'hangman',
      status: 'completed',
      message: 'La partie est arrêtée.',
      publicView: { status: 'cancelled', word: '_ _ _ _' }
    })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => streamResponse([{
      message: { content: 'Ça va bien, merci ! Et toi ?' },
      done: true
    }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'on joue plus, comment tu vas toi ?' }],
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: '{"activityId":"b7eeae4c-bf63-4ac6-908e-ee3204766a7c","engineId":"hangman","publicView":{"word":"_ _ _ _"}}',
      startActivity: vi.fn(),
      applyActivity
    })

    expect(applyActivity).toHaveBeenCalledWith(undefined, { type: 'exit' })
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(request.messages).toHaveLength(2)
    expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'activity_start')).toBe(false)
    expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'activity_action')).toBe(false)
    expect(onContent).toHaveBeenCalledWith('Ça va bien, merci ! Et toi ?')
  })

  it('closes an active activity directly for stop without asking the narrator', async () => {
    const applyActivity = vi.fn().mockReturnValue({
      ok: true,
      activityId: 'b7eeae4c-bf63-4ac6-908e-ee3204766a7c',
      engineId: 'hangman',
      status: 'completed',
      message: 'La partie est arrêtée.',
      publicView: { status: 'cancelled', word: '_ _ _ _' }
    })
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Stop' }],
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: '{"activityId":"b7eeae4c-bf63-4ac6-908e-ee3204766a7c","engineId":"hangman","publicView":{"word":"_ _ _ _"}}',
      applyActivity
    })

    expect(applyActivity).toHaveBeenCalledWith(undefined, { type: 'exit' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(onContent).toHaveBeenCalledWith('La partie est arrêtée.')
  })

  it('recognizes no-longer-wanting-to-play before routing the rest of the message', async () => {
    const applyActivity = vi.fn().mockReturnValue({ ok: true, message: 'La partie est arrêtée.' })
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => streamResponse([{
      message: { content: 'Je ne connais pas votre ville pour donner la météo.' }, done: true
    }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: "J'ai plus envie de jouer, quel temps fait-il ?" }],
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: '{"activityId":"active","engineId":"hangman","publicView":{"word":"_ _ _ _"}}',
      applyActivity
    })

    expect(applyActivity).toHaveBeenCalledWith(undefined, { type: 'exit' })
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name.startsWith('activity_'))).toBe(false)
  })

  it('does not restart a completed activity when the user says they no longer want to play', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([{
      message: { content: 'D’accord, on arrête de jouer.' },
      done: true
    }]))
    vi.stubGlobal('fetch', fetcher)
    const startActivity = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'j’ai dit je veut plus jouer !' }],
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      startActivity,
      applyActivity: vi.fn()
    })

    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(request.tools.some((tool: { function: { name: string } }) => tool.function.name === 'activity_start')).toBe(false)
    expect(startActivity).not.toHaveBeenCalled()
  })

  it('repairs legacy hangman calls and hides invented private start fields from the narrator', async () => {
    const activityId = '51c458d9-46ad-463a-b178-ba9278f7000f'
    const startActivity = vi.fn().mockReturnValue({
      ok: true,
      activityId,
      engineId: 'hangman',
      status: 'active',
      message: 'L’activité est démarrée.',
      publicView: { word: '_ _ _ _ _', letterCount: 5, guessedLetters: [], remainingAttempts: 6 }
    })
    const applyActivity = vi.fn().mockReturnValue({
      ok: true,
      activityId,
      engineId: 'hangman',
      publicView: { word: 'P _ _ _ _', letterCount: 5, remainingAttempts: 6 }
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: {
          name: 'activity_start',
          arguments: { engineId: 'hangman', input: { language: 'fr', word: 'POMPES', difficulty: 'medium', mode: 'standard' } }
        } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Le mot comporte 5 lettres : _ _ _ _ _.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Jouons au pendu.' }],
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      startActivity,
      applyActivity,
      consultAdvisor: vi.fn()
    })

    expect(startActivity).toHaveBeenCalledWith('hangman', { difficulty: 'medium' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    fetcher.mockReset()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: {
          name: 'activity_action',
          arguments: { action: JSON.stringify({ activityId, action: { guess: 'P' } }) }
        } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Bien joué : P _ _ _ _.' }, done: true }]))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'P' }],
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      activityContext: JSON.stringify({ activityId, engineId: 'hangman', publicView: { word: '_ _ _ _ _' } }),
      startActivity,
      applyActivity,
      consultAdvisor: vi.fn()
    })

    expect(applyActivity).toHaveBeenCalledWith(undefined, { type: 'guess', letter: 'P' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('executes a read-only tool and continues to a final answer', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'hello.txt'), 'contenu local')
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([
        { message: { content: 'Le fichier contient du contenu local.' }, done: true }
      ]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()
    const onTool = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Lis le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool,
      authorize: vi.fn().mockResolvedValue(false)
    })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(onTool).toHaveBeenNthCalledWith(1, 'read_file', 'running')
    expect(onTool).toHaveBeenNthCalledWith(2, 'read_file', 'done')
    expect(onContent).toHaveBeenCalledWith('Le fichier contient du contenu local.')
  })

  it('keeps tool-turn commentary hidden until tools finish and publishes only the final answer', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'hello.txt'), 'contenu local')
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          content: 'Je vais lire le fichier.',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Voici le résultat final.' }, done: true }])))
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Lis le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(false)
    })

    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith('Voici le résultat final.')
  })

  it('forces a tool retry when a model only pastes code for a requested file change', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Création de styles.css\nbody { color: white; }\nAjoutez ce fichier vous-même.' },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [
          { function: { name: 'write_file', arguments: { path: 'css/styles.css', content: 'body { color: white; }\n' } } },
          { function: { name: 'write_file', arguments: { path: 'js/script.js', content: 'console.log("ready")\n' } } }
        ] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Les fichiers CSS et JavaScript ont été créés.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Il manque le CSS et le JS.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('Applique-le maintenant avec write_file')
    expect(onContent).toHaveBeenCalledOnce()
    expect(onContent).toHaveBeenCalledWith('Les fichiers CSS et JavaScript ont été créés.')
    await expect(readFile(join(projectPath, 'css/styles.css'), 'utf8')).resolves.toBe('body { color: white; }\n')
    await expect(readFile(join(projectPath, 'js/script.js'), 'utf8')).resolves.toBe('console.log("ready")\n')
  })

  it('does not finish until every explicitly separated web file has been written', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{ message: { tool_calls: [{
        function: { name: 'write_file', arguments: { path: 'index.html', content: '<link rel="stylesheet" href="styles.css"><script src="script.js"></script>' } }
      }] }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'La page est terminée.' }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { tool_calls: [
        { function: { name: 'write_file', arguments: { path: 'styles.css', content: 'body { color: green; }' } } },
        { function: { name: 'write_file', arguments: { path: 'script.js', content: 'console.log("ready")' } } }
      ] }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Les trois fichiers sont créés.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée une page web Minecraft et sépare bien les fichiers CSS, JS et index.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(String(fetcher.mock.calls[2]?.[1]?.body)).toContain('il manque encore : CSS, JavaScript')
    await expect(readFile(join(projectPath, 'styles.css'), 'utf8')).resolves.toContain('green')
    await expect(readFile(join(projectPath, 'script.js'), 'utf8')).resolves.toContain('ready')
    expect(onContent).toHaveBeenCalledWith('Les trois fichiers sont créés.')
  })

  it('reports that nothing changed when a model refuses file tools twice', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Copiez ce code dans styles.css.' }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Ajoutez ensuite script.js.' }, done: true }])))
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée le CSS et le JavaScript.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(onContent).toHaveBeenCalledOnce()
    expect(onContent).toHaveBeenCalledWith(expect.stringContaining('Aucun fichier n’a été modifié'))
    await expect(readFile(join(projectPath, 'styles.css'), 'utf8')).rejects.toThrow()
  })

  it('writes strict fallback file blocks when a small model cannot call tools', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Voici le code de la page.' }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: '<stellan_file path="index.html">\n<h1>Minecraft</h1>\n</stellan_file>\n<stellan_file path="css/styles.css">\nbody { color: #62c462; }\n</stellan_file>' },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'La page Minecraft a été créée.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const authorize = vi.fn().mockResolvedValue(true)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'Crée une page web Minecraft.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize
    })

    expect(authorize).toHaveBeenCalledTimes(2)
    expect(await readFile(join(projectPath, 'index.html'), 'utf8')).toBe('<h1>Minecraft</h1>\n')
    expect(await readFile(join(projectPath, 'css/styles.css'), 'utf8')).toBe('body { color: #62c462; }\n')
    expect(onContent).toHaveBeenCalledWith('La page Minecraft a été créée.')
  })

  it('accepts the official Qwen-Agent textual tool-call format on recovery', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Je vais créer la page.' }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: '<tool_call>\n{"name":"write_file","arguments":{"path":"index.html","content":"<h1>Minecraft</h1>\\n"}}\n</tool_call>' },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'La page est prête.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'Crée une page Minecraft.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).not.toHaveProperty('tools')
    await expect(readFile(join(projectPath, 'index.html'), 'utf8')).resolves.toBe('<h1>Minecraft</h1>\n')
  })

  it('recovers from malformed Ollama tool XML with the textual tool-call format', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{ error: 'XML syntax error on line 100: element <function> closed by </parameter>', done: true }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: '<tool_call>\n{"name":"write_file","arguments":{"path":"index.html","content":"<h1>Bonjour</h1>"}}\n</tool_call>' },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'La page a été créée.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Tu peux me créer une page web ?' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(await readFile(join(projectPath, 'index.html'), 'utf8')).toBe('<h1>Bonjour</h1>')
    expect(fetcher).toHaveBeenCalledTimes(3)
    const recoveryRequest = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(recoveryRequest.tools).toBeUndefined()
  })

  it('accepts a complete tool-call JSON object emitted in message content', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { content: '{"name":"write_file","arguments":{"path":"index.html","content":"<main>Minecraft</main>\\n"}}' },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Terminé.' }, done: true }])))

    await runCodingAgent({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'Crée une page Minecraft.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    await expect(readFile(join(projectPath, 'index.html'), 'utf8')).resolves.toBe('<main>Minecraft</main>\n')
  })

  it('deletes files with the dedicated tool instead of a shell command', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'obsolete.css'), 'one\ntwo\n')
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'delete_file', arguments: { path: 'obsolete.css' } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Le fichier a été supprimé.' }, done: true }])))
    const authorize = vi.fn().mockResolvedValue(true)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Supprime obsolete.css.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize
    })

    expect(authorize).toHaveBeenCalledWith('delete_file', 'Supprimer obsolete.css')
    await expect(readFile(join(projectPath, 'obsolete.css'), 'utf8')).rejects.toThrow()
  })

  it('requires explicit confirmation before a high-risk tool inferred from an unclear request', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'obsolete.css'), 'content\n')
    const project = await ProjectTools.create(projectPath)
    const onToolEvent = vi.fn()
    const authorize = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'delete_file', arguments: { path: 'obsolete.css' } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { content: 'Voulez-vous confirmer la suppression de obsolete.css ?' }, done: true
      }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Fais le ménage.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      onToolEvent,
      authorize,
      intentClassification: {
        intent: 'code',
        clear: false,
        source: 'model',
        reason: 'model-classification'
      }
    })

    await expect(readFile(join(projectPath, 'obsolete.css'), 'utf8')).resolves.toBe('content\n')
    expect(authorize).not.toHaveBeenCalled()
    expect(onToolEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'finished',
      status: 'denied',
      result: expect.stringContaining('risque élevé')
    }))
  })

  it('supports targeted edits, undo, and persistent todo tools', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'app.ts'), 'const value = 1\n')
    const project = await ProjectTools.create(projectPath)
    let todos: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'low' | 'medium' | 'high' }> = []
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{ message: { tool_calls: [{
        function: { name: 'edit_file', arguments: { path: 'app.ts', oldText: 'value = 1', newText: 'value = 2' } }
      }] }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { tool_calls: [{
        function: { name: 'undo_edit', arguments: { path: 'app.ts' } }
      }] }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { tool_calls: [{
        function: { name: 'todo_write', arguments: { todos: [
          { id: 'fix', content: 'Corriger', status: 'in_progress' },
          { id: 'plan', content: 'Planifier' }
        ] } }
      }] }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { tool_calls: [{ function: { name: 'todo_read', arguments: {} } }] }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Plan conservé et modification annulée.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Modifie puis annule le changement et conserve le plan.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      readTodos: () => todos,
      writeTodos: (next) => { todos = next; return todos }
    })

    await expect(readFile(join(projectPath, 'app.ts'), 'utf8')).resolves.toBe('const value = 1\n')
    expect(todos).toEqual([
      { id: 'fix', content: 'Corriger', status: 'in_progress', priority: 'medium' },
      { id: 'plan', content: 'Planifier', status: 'pending', priority: 'medium' }
    ])
    expect(String(fetcher.mock.calls[4]?.[1]?.body)).toContain('Corriger')
  })

  it('limits the number of files deleted by one agent request', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const paths = Array.from({ length: 21 }, (_, index) => `file-${index}.txt`)
    await Promise.all(paths.map((file) => writeFile(join(projectPath, file), 'content\n')))
    const project = await ProjectTools.create(projectPath)
    const toolCalls = paths.map((file) => ({
      function: { name: 'delete_file', arguments: { path: file } }
    }))
    const onToolEvent = vi.fn()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{ message: { tool_calls: toolCalls }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Suppression partielle terminée.' }, done: true }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Supprime ces fichiers.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      onToolEvent,
      authorize: vi.fn().mockResolvedValue(true)
    })

    await expect(readFile(join(projectPath, paths[19] as string), 'utf8')).rejects.toThrow()
    await expect(readFile(join(projectPath, paths[20] as string), 'utf8')).resolves.toBe('content\n')
    expect(onToolEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'finished',
      status: 'denied',
      result: expect.stringContaining('20 suppressions')
    }))
  })

  it('does not expose Git tools for an ordinary folder', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { message: { content: 'Projet analysé.' }, done: true }
    ]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Analyse ce projet.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(false),
      isGitRepository: false
    })

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ function: { name: string } }>
    }
    expect(body.tools.map((tool) => tool.function.name)).not.toContain('git_status')
    expect(body.tools.map((tool) => tool.function.name)).not.toContain('git_diff')
  })

  it('awaits durable tool lifecycle callbacks before publishing live statuses', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'hello.txt'), 'contenu local')
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'hello.txt' } } }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Terminé.' }, done: true }])))
    const order: string[] = []

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Lis le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: (_tool, status) => order.push(`ipc:${status}`),
      onToolEvent: async (event) => {
        await Promise.resolve()
        order.push(`stored:${event.type === 'started' ? 'running' : event.status}`)
      },
      authorize: vi.fn().mockResolvedValue(false)
    })

    expect(order).toEqual([
      'stored:running',
      'ipc:running',
      'stored:done',
      'ipc:done'
    ])
  })

  it('does not write when the user refuses authorization', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'hello.txt'), 'original')
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [{
            function: {
              name: 'write_file',
              arguments: { path: 'hello.txt', content: 'modifié' }
            }
          }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([
        { message: { content: 'La modification a été refusée.' }, done: true }
      ])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Modifie le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(false)
    })

    await expect(readFile(join(projectPath, 'hello.txt'), 'utf8')).resolves.toBe('original')
  })

  it('always reports completion when a model ends silently after writing', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: {
          tool_calls: [{
            function: {
              name: 'write_file',
              arguments: { path: 'style.css', content: 'body { color: red; }\n' }
            }
          }]
        },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: '' }, done: true }])))
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Anime le texte.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(onContent).toHaveBeenCalledWith('Terminé. J’ai modifié ou supprimé 1 fichier : `style.css`.')
    await expect(readFile(join(projectPath, 'style.css'), 'utf8')).resolves.toBe('body { color: red; }\n')
  })

  it('keeps a successful file change when the model stalls before its final summary', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{
          function: { name: 'write_file', arguments: { path: 'index.html', content: '<h1>Aquarium</h1>\n' } }
        }] },
        done: true
      }]))
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })))
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée un aquarium.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      modelIdleTimeoutMs: 10
    })

    expect(onContent).toHaveBeenCalledWith(expect.stringContaining('index.html'))
    await expect(readFile(join(projectPath, 'index.html'), 'utf8')).resolves.toBe('<h1>Aquarium</h1>\n')
  })

  it('asks the model to resume instead of claiming success after read-only tools', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    await writeFile(join(projectPath, 'style.css'), '.title { opacity: 0; }\n')
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'style.css' } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: '' }, done: true }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{
          function: {
            name: 'write_file',
            arguments: { path: 'style.css', content: '.title { opacity: 1; }\n' }
          }
        }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Animation retirée et texte restauré.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const onContent = vi.fn()

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Retire l’animation qui masque le texte.' }],
      project,
      signal: new AbortController().signal,
      onContent,
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true)
    })

    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(String(fetcher.mock.calls[2]?.[1]?.body)).toContain('Applique-le maintenant avec write_file')
    expect(onContent).toHaveBeenCalledWith('Animation retirée et texte restauré.')
    expect(onContent).not.toHaveBeenCalledWith('Terminé. Les actions demandées ont été exécutées.')
    await expect(readFile(join(projectPath, 'style.css'), 'utf8')).resolves.toBe('.title { opacity: 1; }\n')
  })

  it('keeps recent context within a bounded request size', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      { message: { content: 'Terminé.' }, done: true }
    ]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [
        ...Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `${index}: ${'x'.repeat(15_000)}`
        })),
        { role: 'user', content: 'message récent à conserver' }
      ],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(false)
    })

    const request = fetcher.mock.calls[0]?.[1]
    const body = String(request?.body)
    expect(body.length).toBeLessThan(70_000)
    expect(body).toContain('message récent à conserver')
    expect(body).not.toContain('0: xxxxx')
  })

  it('deterministically bounds an oversized newest message without semantic summarization', () => {
    const newestSuffix = 'suffixe récent à conserver'
    const compacted = compactConversation([
      { role: 'system', content: 'instruction système' },
      { role: 'user', content: `ancien ${'a'.repeat(70_000)}` },
      { role: 'assistant', content: 'ancienne réponse' },
      { role: 'user', content: `${'x'.repeat(90_000)}${newestSuffix}` }
    ])

    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(MAX_CONVERSATION_CHARACTERS)
    expect(compacted).toHaveLength(2)
    expect(compacted[1]?.content).toContain('[début tronqué]')
    expect(compacted[1]?.content).toContain(newestSuffix)
    expect(compacted[1]?.content).not.toContain('ancien')
  })

  it('routes authorized commands through the configured worker executor', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const workerCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'worker output' })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'npm', args: ['test'] } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Tests terminés.' }, done: true }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Lance les tests.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      runCommand: workerCommand
    })

    expect(workerCommand).toHaveBeenCalledWith(
      'npm',
      ['test'],
      expect.objectContaining({ timeoutMs: 120_000 })
    )
  })

  it('allows a Git commit only when the current user message explicitly requests it', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const workerCommand = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'commit créé' })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'git', args: ['commit', '-m', 'change'] } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Commit créé.' }, done: true }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Fais un commit avec ces changements.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      runCommand: workerCommand
    })

    expect(workerCommand).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'change'],
      expect.objectContaining({ timeoutMs: 120_000 })
    )
  })

  it('does not treat an explicit refusal as permission to commit', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const workerCommand = vi.fn()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'git', args: ['commit', '-m', 'change'] } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Le commit a été refusé.' }, done: true }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Applique les changements mais ne commit pas.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      runCommand: workerCommand
    })

    expect(workerCommand).not.toHaveBeenCalled()
  })

  it('refuses a destructive command before authorization or execution', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const workerCommand = vi.fn()
    const authorize = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'run_command', arguments: { command: 'rm', args: ['-rf', '.'] } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'La commande a été refusée.' }, done: true }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Nettoie le projet.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize,
      runCommand: workerCommand
    })

    expect(authorize).not.toHaveBeenCalled()
    expect(workerCommand).not.toHaveBeenCalled()
  })

  it('enforces the worker write scope in code', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const authorize = vi.fn().mockResolvedValue(true)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'outside.txt', content: 'refusé' } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Le fichier est hors périmètre.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Modifie le fichier.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize,
      writeScope: new Set(['allowed.txt']),
      allowRunCommand: false
    })

    expect(authorize).not.toHaveBeenCalled()
    await expect(readFile(join(projectPath, 'outside.txt'), 'utf8')).rejects.toThrow()
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('Fichiers autorisés : allowed.txt')
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('sans mkdir')
  })

  it('rejects worker plans containing paths outside the project', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const spawnWorkers = vi.fn()
    const tasks = [
      { title: 'Valide', instructions: 'Travaille ici.', files: ['src/index.ts'] },
      { title: 'Invalide', instructions: 'Sors du projet.', files: ['../secret.txt'] }
    ]
    vi.stubGlobal('fetch', vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Le plan invalide a été refusé.' }, done: true }])))

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Utilise deux workers.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      spawnWorkers
    })

    expect(spawnWorkers).not.toHaveBeenCalled()
  })

  it('corrects a malformed worker plan with an empty file list', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const malformedTasks = [
      { title: 'Site', instructions: 'Crée la page.', files: ['index.html'] },
      { title: 'Workers locaux', instructions: 'Crée d’autres workers.', files: [] }
    ]
    const correctedTasks = [
      { title: 'HTML', instructions: 'Crée la structure.', files: ['index.html'] },
      { title: 'CSS et JS', instructions: 'Crée le style et les interactions.', files: ['css/styles.css', 'js/script.js'] }
    ]
    const spawnWorkers = vi.fn().mockResolvedValue(correctedTasks.map((task) => ({
      ...task,
      summary: 'Terminé',
      status: 'done' as const
    })))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks: malformedTasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks: correctedTasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Les workers ont terminé.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée un site et utilise plusieurs workers.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenCalledWith(correctedTasks)
    const correctionRequest = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(correctionRequest.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['create_workers'])
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('au moins un chemin de fichier relatif complet')
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('aucun worker chargé de créer d’autres workers')
  })

  it('delegates disjoint files to automatic workers and returns their results', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const tasks = [
      { title: 'HTML', instructions: 'Crée la structure.', files: ['index.html'] },
      { title: 'CSS', instructions: 'Crée le style.', files: ['styles.css'] }
    ]
    const spawnWorkers = vi.fn().mockResolvedValue(tasks.map((task) => ({
      title: task.title,
      summary: 'Terminé',
      files: task.files,
      status: 'done' as const
    })))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Les deux workers ont terminé.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)
    const authorize = vi.fn().mockResolvedValue(false)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée le HTML et le CSS.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize,
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenCalledWith(tasks)
    expect(authorize).not.toHaveBeenCalled()
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('create_workers')
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('css/styles.css')
  })

  it('forces worker coordination when explicitly requested instead of accepting another tool', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const tasks = [
      { title: 'HTML', instructions: 'Crée la structure.', files: ['index.html'] },
      { title: 'Tetris', instructions: 'Crée le jeu.', files: ['js/tetris.js'] }
    ]
    const spawnWorkers = vi.fn().mockResolvedValue(tasks.map((task) => ({
      ...task,
      summary: 'Terminé',
      status: 'done' as const
    })))
    const writeTodos = vi.fn()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [] } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Les workers ont terminé.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée un Tetris et utilise plusieurs workers.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      writeTodos,
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenCalledWith(tasks)
    expect(writeTodos).not.toHaveBeenCalled()
    const firstTools = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).tools as Array<{ function: { name: string } }>
    expect(firstTools.map((tool) => tool.function.name)).toEqual([
      'list_files',
      'read_file',
      'search_files',
      'git_status',
      'create_workers'
    ])
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('explicitement demandé plusieurs workers')
  })

  it('lets the coordinator inspect an empty project before creating workers', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const tasks = [
      { title: 'HTML', instructions: 'Crée la structure.', files: ['index.html'] },
      { title: 'CSS et JS', instructions: 'Crée la présentation.', files: ['css/styles.css', 'js/script.js'] }
    ]
    const spawnWorkers = vi.fn().mockResolvedValue(tasks.map((task) => ({
      ...task,
      summary: 'Terminé',
      status: 'done' as const
    })))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'list_files', arguments: {} } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Le site est terminé.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée un site avec plusieurs workers.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenCalledWith(tasks)
    const planningRequest = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(planningRequest.messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      tool_name: 'list_files'
    }))
    expect(planningRequest.messages.at(-1)?.content).not.toContain('Appelle maintenant create_workers')
  })

  it('does not delegate completed worker files again after a partial failure', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const tasks = [
      { title: 'HTML', instructions: 'Structure', files: ['index.html'] },
      { title: 'CSS', instructions: 'Styles', files: ['css/styles.css'] },
      { title: 'JavaScript', instructions: 'Animation', files: ['js/script.js'] }
    ]
    const spawnWorkers = vi.fn()
      .mockResolvedValueOnce([
        { ...tasks[0], summary: 'Terminé', status: 'done' },
        { ...tasks[1], summary: 'Échec CSS', status: 'error' },
        { ...tasks[2], summary: 'Délai dépassé', status: 'error' }
      ])
      .mockResolvedValueOnce([
        { ...tasks[1], summary: 'Terminé', status: 'done' },
        { ...tasks[2], summary: 'Terminé', status: 'done' }
      ])
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Intégration terminée.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée les trois fichiers avec des workers.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenNthCalledWith(1, tasks)
    expect(spawnWorkers).toHaveBeenNthCalledWith(2, tasks.slice(1))
  })

  it('keeps one remaining failed task in the coordinator instead of opening another worker', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const tasks = [
      { title: 'HTML', instructions: 'Structure', files: ['index.html'] },
      { title: 'CSS', instructions: 'Styles', files: ['css/styles.css'] }
    ]
    const spawnWorkers = vi.fn().mockResolvedValue([
      { ...tasks[0], summary: 'Terminé', status: 'done' },
      { ...tasks[1], summary: 'Échec CSS', status: 'error' }
    ])
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Le CSS sera terminé ici.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée les deux fichiers avec des workers.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[2]?.[1]?.body)).toContain('essayez une autre approche dans le thread principal')
  })

  it('stops reopening workers after one corrected retry also fails', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const tasks = [
      { title: 'CSS', instructions: 'Styles', files: ['css/styles.css'] },
      { title: 'JavaScript', instructions: 'Animation', files: ['js/script.js'] }
    ]
    const failedResults = tasks.map((task) => ({
      ...task,
      summary: 'Le worker a échoué.',
      status: 'error' as const
    }))
    const spawnWorkers = vi.fn().mockResolvedValue(failedResults)
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Je vais essayer autrement dans le thread principal.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Crée les fichiers avec des workers.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[3]?.[1]?.body)).toContain('exhaustedWorkerFiles')
    expect(String(fetcher.mock.calls[3]?.[1]?.body)).toContain('expliquez clairement le blocage')
  })

  it('spawns independent workers and leaves overlapping integration to the coordinator', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'local-agent-agent-'))
    temporaryDirectories.push(projectPath)
    const project = await ProjectTools.create(projectPath)
    const tasks = [
      { title: 'HTML', instructions: 'Structure', files: ['index.html'] },
      { title: 'CSS', instructions: 'Styles', files: ['style.css'] },
      { title: 'JavaScript', instructions: 'Animation', files: ['script.js'] },
      { title: 'Intégration', instructions: 'Vérifie les liens', files: ['./index.html', 'style.css', 'script.js'] }
    ]
    const spawnWorkers = vi.fn().mockImplementation(async (workerTasks: WorkerTask[]) => workerTasks.map((task) => ({
      title: task.title,
      summary: 'Terminé',
      files: task.files,
      status: 'done' as const
    })))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(streamResponse([{
        message: { tool_calls: [{ function: { name: 'create_workers', arguments: { tasks } } }] },
        done: true
      }]))
      .mockResolvedValueOnce(streamResponse([{ message: { content: 'Intégration terminée.' }, done: true }]))
    vi.stubGlobal('fetch', fetcher)

    await runCodingAgent({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Travaille en parallèle.' }],
      project,
      signal: new AbortController().signal,
      onContent: vi.fn(),
      onTool: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
      spawnWorkers
    })

    expect(spawnWorkers).toHaveBeenCalledWith(tasks.slice(0, 3))
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('Intégration')
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).toContain('thread principal')
  })
})
