export interface TodoItem {
  id: string
  text: string
  repo: string | null
  waiting: boolean
  createdAt: string
  updatedAt: string
  completed: boolean
}

/** Incomplete「等我」rows exposed for the waiting-on-me provider. */
export interface WaitingTodo {
  id: string
  text: string
  repo: string | null
  createdAt: string
}

export interface TodoInput {
  text: string
  repo: string | null
  waiting: boolean
}

export interface TodoUpdate extends TodoInput {
  id: string
}

export interface CaptureDraft {
  text: string
  repo: string
  waiting: boolean
}
