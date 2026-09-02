import type { AutomaticSpeechRecognitionPipelineType } from '@huggingface/transformers'

const MODEL_ID = 'onnx-community/whisper-large-v3-turbo'

export type DictationLoadProgress = {
  status: 'loading' | 'downloading' | 'transcribing'
  file?: string
  percent?: number
}

let transcriberPromise: Promise<AutomaticSpeechRecognitionPipelineType> | null = null

function normalizeSpokenCode(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/\bnouvelle ligne\b/gi, '\n'],
    [/\btabulation\b/gi, '\t'],
    [/\bouvre parenth[èe]se\b/gi, '('],
    [/\bferme parenth[èe]se\b/gi, ')'],
    [/\bouvre accolade\b/gi, '{'],
    [/\bferme accolade\b/gi, '}'],
    [/\bouvre crochet\b/gi, '['],
    [/\bferme crochet\b/gi, ']'],
    [/\bpoint[- ]virgule\b/gi, ';'],
    [/\bdeux[- ]points\b/gi, ':']
  ]

  let normalized = text.trim()
  for (const [pattern, replacement] of replacements) normalized = normalized.replace(pattern, replacement)
  return normalized
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/ {2,}/g, ' ')
}

async function getTranscriber(
  cacheDir: string,
  onProgress: (progress: DictationLoadProgress) => void
): Promise<AutomaticSpeechRecognitionPipelineType> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      onProgress({ status: 'loading' })
      const { env, pipeline } = await import('@huggingface/transformers')
      env.cacheDir = cacheDir
      env.allowRemoteModels = true
      env.allowLocalModels = true
      return pipeline('automatic-speech-recognition', MODEL_ID, {
        dtype: 'q4',
        progress_callback: (event) => {
          const progress = 'progress' in event && typeof event.progress === 'number'
            ? Math.round(event.progress)
            : undefined
          const file = 'file' in event && typeof event.file === 'string' ? event.file : undefined
          onProgress({ status: 'downloading', file, percent: progress })
        }
      })
    })().catch((error) => {
      transcriberPromise = null
      throw error
    })
  }
  return transcriberPromise
}

export async function transcribeDictation(
  audio: ArrayBuffer,
  cacheDir: string,
  onProgress: (progress: DictationLoadProgress) => void
): Promise<string> {
  const samples = new Float32Array(audio)
  if (samples.length < 1_600) throw new Error('La dictée est trop courte.')

  const transcriber = await getTranscriber(cacheDir, onProgress)
  onProgress({ status: 'transcribing' })
  const output = await transcriber(samples, {
    task: 'transcribe',
    language: 'french',
    chunk_length_s: 30,
    stride_length_s: 5
  })
  const result = Array.isArray(output) ? output[0] : output
  return normalizeSpokenCode(result?.text ?? '')
}

export const dictationInternals = { normalizeSpokenCode }
