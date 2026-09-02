type WebContentsLike = {
  mainFrame: unknown
}

type IpcEventLike = {
  sender: WebContentsLike
  senderFrame: unknown
}

export function isTrustedMainFrame(event: IpcEventLike, expectedSender: WebContentsLike | null): boolean {
  return expectedSender !== null && event.sender === expectedSender && event.senderFrame === event.sender.mainFrame
}
