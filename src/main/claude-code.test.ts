import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeStreamParser, isClaudeCodeModel, runClaudeCode, subscriptionAuthReason } from './claude-code'

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
    expect(isClaudeCodeModel('sonnet')).toBe(false)
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
for arg in "$@"; do [ "$arg" = "--max-turns" ] && exit 9; done
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
        model: 'claude-code:sonnet',
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
    } finally {
      process.env.PATH = previousPath
      await rm(directory, { recursive: true, force: true })
    }
  })
})
