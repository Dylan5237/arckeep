export const MAX_IDEA_LENGTH = 10_000

export interface IdeaInput {
  text: string
  repo: string | null
}

export interface IdeaItem extends IdeaInput {
  id: string
  createdAt: string
  updatedAt: string
}

export interface IdeaUpdate extends IdeaInput {
  id: string
}
