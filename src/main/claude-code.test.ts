import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { claudeCodeQuotaInfo } from '../shared/claude-code-models'
import { STELLAN_AGENT_OPERATING_POLICY } from './agent-policy'
import { claudeInstallCommand, ClaudeStreamParser, isClaudeCodeModel, runClaudeCode, subscriptionAuthReason } from './claude-code'

describe('claudeInstallCommand', () => {
  it('uses the official silent native installer for each desktop platform', () => {
    expect(claudeInstallCommand('win32')).toMatchObject({
      executable: 'powershell.exe',
      display: 'irm https://claude.ai/install.ps1 | iex'
    })
    expect(claudeInstallCommand('linux')).toMatchObject({
      executable: '/bin/sh',
      display: 'curl -fsSL https://claude.ai/install.sh | bash'
    })
    expect(claudeInstallCommand('darwin')).toMatchObject({ executable: '/bin/sh' })
  })
})

describe('subscriptionAuthReason', () => {
  const subscription = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: 'max'
  })

  it('accepts a confirmed Claude subscription login', () => {
    expect(subscriptionAuthReason(subscription, 'Login method: Claude Max account', {})).toEqual({
      subscription: 'max',
      reason: null
    })
  })

  it('refuses billing environment variables', () => {
    expect(subscriptionAuthReason(subscription, 'Login method: Claude Max account', {
      ANTHROPIC_API_KEY: 'secret'
    }).reason).toContain('ANTHROPIC_API_KEY')
  })

  it('refuses a profile even when JSON looks harmless', () => {
    expect(subscriptionAuthReason(subscription, 'Profile: credentials-file · user_oauth · profile default', {}).reason)
      .toContain('abonnement Claude.ai')
  })
})

describe('ClaudeStreamParser', () => {
  it('streams text once and exposes tool execution without raw envelopes', () => {
    const onContent = vi.fn()
    const onTool = vi.fn()
    const onProgress = vi.fn()
    const onSession = vi.fn()
    const parser = new ClaudeStreamParser({ onContent, onTool, onProgress, onSession })
    parser.consume(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }))
    parser.consume(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Bonjour' } }
    }))
    parser.consume(JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'Bonjour' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pnpm test' } }
      ] }
    }))
    parser.consume(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '42 tests passed' }] }
    }))
    parser.consume(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Bonjour' }))

    expect(onSession).toHaveBeenCalledWith('session-1')
    expect(onProgress).toHaveBeenCalledWith('Claude Code analyse le projet…')
    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith('Bonjour')
    expect(onTool).toHaveBeenNthCalledWith(1, {
      type: 'started', callId: 'tool-1', tool: 'run_command', input: { command: 'pnpm test', args: [] }
    })
    expect(onTool).toHaveBeenNthCalledWith(2, {
      type: 'finished', callId: 'tool-1', status: 'done', output: '42 tests passed'
    })
  })

  it('recognizes only explicit Claude Code model identifiers', () => {
    expect(isClaudeCodeModel('claude-code:sonnet')).toBe(true)
    expect(isClaudeCodeModel('claude-code:claude-opus-4-8')).toBe(true)
    expect(isClaudeCodeModel('claude-code:claude-fable-5')).toBe(true)
    expect(isClaudeCodeModel('sonnet')).toBe(false)
  })

  it('describes relative subscription quota impact without inventing token counts', () => {
    expect(claudeCodeQuotaInfo('claude-code:claude-haiku-4-5')?.impact).toBe('low')
    expect(claudeCodeQuotaInfo('claude-code:claude-sonnet-5')?.impact).toBe('moderate')
    expect(claudeCodeQuotaInfo('claude-code:claude-opus-4-8')?.impact).toBe('high')
    expect(claudeCodeQuotaInfo('claude-code:claude-fable-5-1')?.impact).toBe('maximum')
    expect(claudeCodeQuotaInfo('qwen3.5:9b')).toBeNull()
  })

  it('shows a tool as soon as its streamed input is complete', () => {
    const onTool = vi.fn()
    const onProgress = vi.fn()
    const parser = new ClaudeStreamParser({
      onContent: vi.fn(), onTool, onProgress, onSession: vi.fn()
    })
    parser.consume(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read-1', name: 'Read', input: {} } }
    }))
    parser.consume(JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/app.ts"}' } }
    }))
    parser.consume(JSON.stringify({
      type: 'stream_event', event: { type: 'content_block_stop', index: 2 }
    }))
    parser.consume(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'src/app.ts' } }] }
    }))

    expect(onProgress).toHaveBeenCalledWith('Claude prépare l’outil Read…')
    expect(onTool).toHaveBeenCalledTimes(1)
    expect(onTool).toHaveBeenCalledWith({
      type: 'started', callId: 'read-1', tool: 'read_file', input: { file_path: 'src/app.ts', path: 'src/app.ts' }
    })
  })
})

describe('runClaudeCode', () => {
  it('runs the native stream-json loop without an arbitrary turn limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stellan-claude-'))
    const executable = join(directory, 'claude')
    const previousPath = process.env.PATH
    await writeFile(executable, `#!/bin/sh
case "$1" in
  --version) echo '2.1.259 (Claude Code)'; exit 0 ;;
  auth)
    if [ "$3" = "--text" ]; then echo 'Login method: Claude Max account';
    else echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'; fi
    exit 0 ;;
esac
capture_system_prompt=false
for arg in "$@"; do
  [ "$arg" = "--max-turns" ] && exit 9
  if [ "$capture_system_prompt" = true ]; then
    printf '%s' "$arg" > "$PWD/claude-system-prompt"
    capture_system_prompt=false
  elif [ "$arg" = "--append-system-prompt" ]; then
    capture_system_prompt=true
  fi
done
printf '%s\n' "$@" > "$PWD/claude-args"
echo '{"type":"system","subtype":"init","session_id":"11111111-1111-4111-8111-111111111111"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"index.html"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"ok"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Terminé"}'
`)
    await chmod(executable, 0o755)
    process.env.PATH = `${directory}:${previousPath ?? ''}`
    const onContent = vi.fn()
    const onTool = vi.fn()
    try {
      await runClaudeCode({
        model: 'claude-code:claude-fable-5',
        prompt: 'Lis le projet',
        cwd: directory,
        signal: new AbortController().signal,
        onContent,
        onTool,
        onProgress: vi.fn(),
        onSession: vi.fn()
      })
      expect(onContent).toHaveBeenCalledWith('Terminé')
      expect(onTool).toHaveBeenCalledTimes(2)
      expect(onTool.mock.calls[0]?.[0]).toMatchObject({
        type: 'started', tool: 'read_file', input: { path: 'index.html' }
      })
      const args = (await readFile(join(directory, 'claude-args'), 'utf8')).split('\n')
      expect(args[args.indexOf('--model') + 1]).toBe('claude-fable-5')
      expect(args).toContain('--append-system-prompt')
      await expect(readFile(join(directory, 'claude-system-prompt'), 'utf8'))
        .resolves.toBe(STELLAN_AGENT_OPERATING_POLICY)
    } finally {
      process.env.PATH = previousPath
      await rm(directory, { recursive: true, force: true })
    }
  })
})
