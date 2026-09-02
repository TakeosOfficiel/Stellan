const WHISPER_SAMPLE_RATE = 16_000

export function prepareWhisperAudio(chunks: Float32Array[], inputSampleRate: number): ArrayBuffer {
  const inputLength = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const input = new Float32Array(inputLength)
  let offset = 0
  for (const chunk of chunks) {
    input.set(chunk, offset)
    offset += chunk.length
  }

  if (inputSampleRate === WHISPER_SAMPLE_RATE) return input.buffer

  const outputLength = Math.floor(input.length * WHISPER_SAMPLE_RATE / inputSampleRate)
  const output = new Float32Array(outputLength)
  const ratio = inputSampleRate / WHISPER_SAMPLE_RATE
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let sourceIndex = start; sourceIndex < end && sourceIndex < input.length; sourceIndex += 1) {
      sum += input[sourceIndex] ?? 0
    }
    output[index] = sum / Math.max(1, Math.min(end, input.length) - start)
  }
  return output.buffer
}
