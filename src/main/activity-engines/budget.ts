import { z } from 'zod'
import type { ReliableEngine } from '../reliable-activities'

type Expense = {
  id: string
  label: string
  amountCents: number
}

type BudgetState = {
  limitCents: number
  currency: string
  expenses: Expense[]
  status: 'active' | 'closed'
}

type BudgetAction =
  | { type: 'add_expense'; id: string; label: string; amountCents: number }
  | { type: 'remove_expense'; id: string }
  | { type: 'close' }

const moneySchema = z.number().int().positive().max(1_000_000_000_00)

const expenseSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(200),
  amountCents: moneySchema
})

const stateSchema = z.object({
  limitCents: moneySchema,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  expenses: z.array(expenseSchema).max(1_000),
  status: z.enum(['active', 'closed'])
})

function publicView(state: BudgetState): unknown {
  const spentCents = state.expenses.reduce((total, expense) => total + expense.amountCents, 0)
  return {
    status: state.status,
    currency: state.currency,
    limitCents: state.limitCents,
    spentCents,
    remainingCents: state.limitCents - spentCents,
    expenses: state.expenses
  }
}

export function createBudgetEngine(): ReliableEngine<
  BudgetState,
  { limitCents: number; currency: string },
  BudgetAction
> {
  return {
    id: 'budget',
    createSchema: z.object({
      limitCents: moneySchema,
      currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('EUR')
    }),
    actionSchema: z.discriminatedUnion('type', [
      expenseSchema.extend({ type: z.literal('add_expense') }),
      z.object({
        type: z.literal('remove_expense'),
        id: z.string().trim().min(1).max(80)
      }),
      z.object({ type: z.literal('close') })
    ]),
    stateSchema,
    create: ({ limitCents, currency }) => ({
      limitCents,
      currency,
      expenses: [],
      status: 'active'
    }),
    apply: (state, action) => {
      if (state.status !== 'active') {
        return {
          ok: false,
          error: { code: 'BUDGET_CLOSED', message: 'Ce suivi de budget est déjà clôturé.', retryable: false }
        }
      }
      if (action.type === 'close') {
        return {
          ok: true,
          state: { ...state, status: 'closed' },
          completed: true,
          message: 'Le suivi de budget est clôturé.',
          event: { type: 'closed' }
        }
      }
      if (action.type === 'remove_expense') {
        const expense = state.expenses.find((candidate) => candidate.id === action.id)
        if (!expense) {
          return {
            ok: false,
            error: { code: 'EXPENSE_NOT_FOUND', message: 'Cette dépense n’existe pas.', retryable: true }
          }
        }
        return {
          ok: true,
          state: { ...state, expenses: state.expenses.filter((candidate) => candidate.id !== action.id) },
          completed: false,
          message: `La dépense « ${expense.label} » a été retirée.`,
          event: { type: 'expense_removed', id: action.id }
        }
      }
      if (state.expenses.some((expense) => expense.id === action.id)) {
        return {
          ok: false,
          error: { code: 'DUPLICATE_EXPENSE', message: 'Une dépense avec cet identifiant existe déjà.', retryable: true }
        }
      }
      const spentCents = state.expenses.reduce((total, expense) => total + expense.amountCents, 0)
      if (spentCents + action.amountCents > state.limitCents) {
        const excessCents = spentCents + action.amountCents - state.limitCents
        return {
          ok: false,
          error: {
            code: 'BUDGET_EXCEEDED',
            message: `Cette dépense dépasserait le budget de ${excessCents} centime${excessCents > 1 ? 's' : ''}.`,
            retryable: true
          }
        }
      }
      return {
        ok: true,
        state: {
          ...state,
          expenses: [...state.expenses, {
            id: action.id,
            label: action.label,
            amountCents: action.amountCents
          }]
        },
        completed: false,
        message: `La dépense « ${action.label} » a été ajoutée.`,
        event: { type: 'expense_added', id: action.id, amountCents: action.amountCents }
      }
    },
    publicView
  }
}
