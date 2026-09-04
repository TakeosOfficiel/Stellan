import { randomInt } from 'node:crypto'
import { z } from 'zod'
import type { ReliableEngine } from '../reliable-activities'

type HangmanState = {
  secret: string
  guessedLetters: string[]
  hint: string | null
  remainingAttempts: number
  status: 'active' | 'won' | 'lost' | 'cancelled'
}

const stateSchema = z.object({
  secret: z.string().regex(/^[A-Z]+$/),
  guessedLetters: z.array(z.string().regex(/^[A-Z]$/)),
  hint: z.string().nullable().default(null),
  remainingAttempts: z.number().int().min(0).max(6),
  status: z.enum(['active', 'won', 'lost', 'cancelled'])
})

const WORDS = {
  facile: ['CHAT', 'LUNE', 'PAIN', 'ROSE', 'TRAIN'],
  moyen: ['AVION', 'FORET', 'JARDIN', 'PLANETE', 'TORTUE', 'FROMAGE'],
  difficile: ['ASTRONAUTE', 'LABYRINTHE', 'PHOTOGRAPHIE', 'XYLOPHONE']
} as const

const HINTS: Record<string, string> = {
  CHAT: 'C’est un animal domestique connu pour ronronner.',
  LUNE: 'C’est le satellite naturel visible dans le ciel nocturne.',
  PAIN: 'Cet aliment à base de farine accompagne souvent les repas.',
  ROSE: 'C’est une fleur souvent offerte pour exprimer ses sentiments.',
  TRAIN: 'Ce moyen de transport circule sur des rails.',
  AVION: 'Ce moyen de transport vole dans le ciel.',
  FORET: 'C’est une grande étendue peuplée principalement d’arbres.',
  JARDIN: 'On y cultive souvent des fleurs, des fruits ou des légumes.',
  PLANETE: 'C’est un astre qui tourne autour d’une étoile.',
  TORTUE: 'Cet animal se reconnaît à sa carapace.',
  FROMAGE: 'C’est un incontournable de la gastronomie française, souvent dégusté avec du pain avant le dessert.',
  ASTRONAUTE: 'Cette personne voyage et travaille dans l’espace.',
  LABYRINTHE: 'C’est un réseau de chemins dans lequel il est difficile de trouver la sortie.',
  PHOTOGRAPHIE: 'Elle permet de conserver une image prise avec un appareil.',
  XYLOPHONE: 'Cet instrument se joue en frappant des lames avec des baguettes.'
}

type HangmanDifficulty = keyof typeof WORDS
type HangmanDifficultyInput = HangmanDifficulty | 'easy' | 'medium' | 'hard'

const DIFFICULTY_ALIASES: Record<HangmanDifficultyInput, HangmanDifficulty> = {
  facile: 'facile',
  moyen: 'moyen',
  difficile: 'difficile',
  easy: 'facile',
  medium: 'moyen',
  hard: 'difficile'
}

const DRAWINGS = [
  '',
  '  O',
  '  O\n  |',
  '  O\n /|',
  '  O\n /|\\',
  '  O\n /|\\\n /',
  '  O\n /|\\\n / \\'
]

function publicView(state: HangmanState): unknown {
  const guessed = new Set(state.guessedLetters)
  const revealSecret = state.status === 'won' || state.status === 'lost'
  const letters = [...state.secret].map((letter) => revealSecret || guessed.has(letter) ? letter : '_')
  const wrongLetters = state.guessedLetters.filter((letter) => !state.secret.includes(letter))
  return {
    status: state.status,
    word: letters.join(' '),
    letterCount: state.secret.length,
    guessedLetters: state.guessedLetters,
    wrongLetters,
    hint: state.hint,
    remainingAttempts: state.remainingAttempts,
    drawing: DRAWINGS[6 - state.remainingAttempts]
  }
}

type HangmanAction =
  | { type: 'guess'; letter: string }
  | { type: 'solve'; word: string }
  | { type: 'hint' }
  | { type: 'give_up' }
  | { type: 'exit' }
  | { type: 'unsupported' }

export function createHangmanEngine(
  chooseIndex: (length: number) => number = (length) => randomInt(length)
): ReliableEngine<HangmanState, { difficulty: HangmanDifficultyInput }, HangmanAction> {
  return {
    id: 'hangman',
    createSchema: z.object({
      difficulty: z.enum(['facile', 'moyen', 'difficile', 'easy', 'medium', 'hard']).default('moyen')
    }).strict(),
    actionSchema: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('guess'),
        letter: z.string().trim().toUpperCase().regex(/^[A-Z]$/, 'Une seule lettre de A à Z est attendue.')
      }),
      z.object({ type: z.literal('solve'), word: z.string().trim().toUpperCase().regex(/^[A-Z]+$/) }),
      z.object({ type: z.literal('hint') }),
      z.object({ type: z.literal('give_up') }),
      z.object({ type: z.literal('exit') }),
      z.object({ type: z.literal('unsupported') })
    ]),
    stateSchema,
    create: ({ difficulty }) => {
      const words = WORDS[DIFFICULTY_ALIASES[difficulty]]
      return {
        secret: words[chooseIndex(words.length)] as string,
        guessedLetters: [],
        hint: null,
        remainingAttempts: 6,
        status: 'active'
      }
    },
    apply: (state, action) => {
      if (state.status !== 'active') {
        return { ok: false, error: { code: 'ACTIVITY_FINISHED', message: 'Cette partie est déjà terminée.', retryable: false } }
      }
      if (action.type === 'exit') {
        return {
          ok: true,
          state: { ...state, status: 'cancelled' },
          completed: true,
          message: 'La partie est arrêtée.',
          event: { type: 'exit' }
        }
      }
      if (action.type === 'unsupported') {
        return {
          ok: false,
          error: {
            code: 'UNSUPPORTED_ACTIVITY_REQUEST',
            message: 'Je ne peux pas faire cela sans inventer. Pendant cette partie, vous pouvez proposer une lettre ou un mot, demander un indice, ou abandonner.',
            retryable: true
          }
        }
      }
      if (action.type === 'hint') {
        const hint = HINTS[state.secret] as string
        return {
          ok: true,
          state: { ...state, hint },
          completed: false,
          message: hint,
          event: { type: 'hint' }
        }
      }
      if (action.type === 'give_up') {
        return {
          ok: true,
          state: { ...state, status: 'lost' },
          completed: true,
          message: 'La partie est terminée. Le mot est maintenant révélé.',
          event: { type: 'give_up' }
        }
      }
      if (action.type === 'solve') {
        const won = action.word === state.secret
        const remainingAttempts = won ? state.remainingAttempts : state.remainingAttempts - 1
        const lost = remainingAttempts === 0
        return {
          ok: true,
          state: {
            ...state,
            remainingAttempts,
            status: won ? 'won' : lost ? 'lost' : 'active'
          },
          completed: won || lost,
          message: won
            ? 'Bravo, le mot proposé est correct : la partie est gagnée.'
            : lost
              ? 'Ce n’est pas le bon mot et il ne reste plus aucun essai : la partie est perdue.'
              : 'Ce n’est pas le bon mot.',
          event: { type: 'solve', word: action.word, hit: won }
        }
      }
      if (state.guessedLetters.includes(action.letter)) {
        return { ok: false, error: { code: 'LETTER_ALREADY_PLAYED', message: `La lettre ${action.letter} a déjà été proposée.`, retryable: true } }
      }
      const hit = state.secret.includes(action.letter)
      const guessedLetters = [...state.guessedLetters, action.letter]
      const remainingAttempts = hit ? state.remainingAttempts : state.remainingAttempts - 1
      const won = [...state.secret].every((letter) => guessedLetters.includes(letter))
      const lost = remainingAttempts === 0
      const nextState: HangmanState = {
        secret: state.secret,
        guessedLetters,
        hint: state.hint,
        remainingAttempts,
        status: won ? 'won' : lost ? 'lost' : 'active'
      }
      return {
        ok: true,
        state: nextState,
        completed: won || lost,
        message: won
          ? 'Toutes les lettres ont été trouvées : la partie est gagnée.'
          : lost
            ? 'Il ne reste plus aucun essai : la partie est perdue.'
            : hit
              ? `La lettre ${action.letter} est présente dans le mot.`
              : `La lettre ${action.letter} n’est pas présente dans le mot.`,
        event: { type: 'guess', letter: action.letter, hit }
      }
    },
    publicView
  }
}
