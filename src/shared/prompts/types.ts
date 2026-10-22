export const MAX_PROMPT_TITLE_LENGTH = 120
export const MAX_PROMPT_LENGTH = 50_000
export const MAX_PROMPT_TAGS = 12
export const MAX_PROMPT_TAG_LENGTH = 30

export interface PromptInput {
  title: string
  text: string
  tags: string[]
  pinned: boolean
}

export interface PromptItem extends PromptInput {
  id: string
  createdAt: string
  updatedAt: string
}

export interface PromptUpdate extends PromptInput {
  id: string
}
