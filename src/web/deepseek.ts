import type { BuildPromptInput, ConversationTurn } from "./task-prompts"
import { buildPipelineApprovalPrompt, buildTaskPrompt } from "./task-prompts"

export interface DeepSeekResult {
  content: string
  model: string
}

interface DeepSeekMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
}

function getBaseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "")
}

export function hasDeepSeekConfig(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY)
}

export function getDeepSeekModel(): string {
  return process.env.DEEPSEEK_MODEL || "deepseek-chat"
}

export async function runDeepSeekTask(input: BuildPromptInput): Promise<DeepSeekResult> {
  const prompt = buildTaskPrompt({ ...input, conversation: [] })
  return callDeepSeek([
    {
      role: "system",
      content:
        "You are editAI, a personal AI writing workspace. Return polished Markdown. Match the requested mode exactly. For pipeline mode, stop after the outline and ask for approval.",
    },
    ...toDeepSeekHistory(input.conversation),
    { role: "user", content: prompt },
  ])
}

export async function continueDeepSeekPipeline(outline: string): Promise<DeepSeekResult> {
  return callDeepSeek([
    {
      role: "system",
      content:
        "You are editAI running the approved content pipeline. Produce the final Markdown deliverable with source notes and fact-check notes.",
    },
    { role: "user", content: buildPipelineApprovalPrompt(outline) },
  ])
}

async function callDeepSeek(messages: DeepSeekMessage[]): Promise<DeepSeekResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured")
  }

  const model = getDeepSeekModel()
  const response = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.5,
    }),
  })

  const data = await response.json() as DeepSeekResponse
  if (!response.ok) {
    throw new Error(data.error?.message || `DeepSeek request failed with HTTP ${response.status}`)
  }

  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) {
    throw new Error("DeepSeek returned an empty response")
  }

  return { content, model }
}

function toDeepSeekHistory(conversation: ConversationTurn[] = []): DeepSeekMessage[] {
  return conversation
    .filter((turn) => turn.content.trim())
    .slice(-12)
    .map((turn) => ({
      role: turn.role,
      content: trimForContext(turn.content.trim(), 6000),
    }))
}

function trimForContext(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, maxLength)}\n\n[Content truncated for context length]`
}
