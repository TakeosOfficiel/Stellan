import { describe, expect, it } from 'vitest'
import { isTrustedMainFrame } from './ipc-security'

describe('isTrustedMainFrame', () => {
  it('accepts only the configured window sender and its main frame', () => {
    const mainFrame = {}
    const sender = { mainFrame }

    expect(isTrustedMainFrame({ sender, senderFrame: mainFrame }, sender)).toBe(true)
    expect(isTrustedMainFrame({ sender: { mainFrame }, senderFrame: mainFrame }, sender)).toBe(false)
    expect(isTrustedMainFrame({ sender, senderFrame: {} }, sender)).toBe(false)
    expect(isTrustedMainFrame({ sender, senderFrame: mainFrame }, null)).toBe(false)
  })
})
