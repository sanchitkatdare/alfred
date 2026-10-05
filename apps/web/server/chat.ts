import { fromOpenAIResponse, toOpenAIMessages, toOpenAITools, type ChatMessage, type LLMResponse } from "@alfred/agent-harness";
import { z } from "zod";
import { movieToolSpecs } from "../src/movies/tools";
import type { Env } from "./env";
import { LIMITS } from "./http";
import { createTimer } from "./timing";

/** Chosen by the model comparison (docs/architecture.html, Model selection). Needs parser hints. The client cannot change it. */
export const MOVIE_CHAT_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";
export const MAX_OUTPUT_TOKENS = 700;
export const AI_GATEWAY_ID = "alfred";

const TOOL_SPECS = movieToolSpecs();

export function movieSystemPrompt(today = new Date()): string {
  return [
    "You are Alfred, a movie assistant for a catalog of popular movies from TMDB.",
    "Always call at least one tool before you answer, even if you know the movie. Never invent titles, plots or facts.",
    "To find a movie the user names, call search_movies with `title`. Use the returned id for other tools.",
    "Call search_movies with structured filters (genres, people, rating, runtime, years) and put themes, plot elements or mood in `query`.",
    "Before answering a question about a movie's story, call get_movie_details and answer only from its text. If the text does not cover the question, say so.",
    "Movies the user has watched are left out of searches unless they ask for them.",
    "Reply in at most 5 short bullet points: title (year) and one reason each. No preamble.",
    `Today is ${today.toISOString().slice(0, 10)}.`,
  ].join("\n");
}

const toolCallSchema = z.object({ id: z.string().max(100), name: z.string().max(64), arguments: z.unknown() });
const ROLE_LIMITS = { user: LIMITS.userMessageChars, assistant: LIMITS.assistantMessageChars, tool: LIMITS.toolMessageChars } as const;

export const chatRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant", "tool"]),
            content: z.string(),
            toolCalls: z.array(toolCallSchema).max(5).optional(),
            toolCallId: z.string().max(100).optional(),
          })
          .superRefine((m, ctx) => {
            const max = ROLE_LIMITS[m.role];
            if (m.content.length > max) ctx.addIssue({ code: "custom", message: `${m.role} message is longer than ${max} characters`, path: ["content"] });
          }),
      )
      .min(1)
      .max(LIMITS.messages),
  })
  .refine(
    (r) => r.messages.reduce((n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? "").length, 0) <= LIMITS.conversationChars,
    { message: `Conversation is longer than ${LIMITS.conversationChars} characters. Start a new one.` },
  );

export interface ChatResult extends LLMResponse {
  timings: Record<string, number>;
  serverTiming: string;
}

/** One LLM turn. The server sets the model, system prompt, tools and token limit. */
export async function runMovieChat(env: Env, messages: ChatMessage[], options: { model?: string; gateway?: boolean } = {}): Promise<ChatResult> {
  const timer = createTimer();
  const model = options.model ?? MOVIE_CHAT_MODEL;
  const input = {
    messages: toOpenAIMessages([{ role: "system", content: movieSystemPrompt() }, ...messages]),
    tools: toOpenAITools(TOOL_SPECS),
    max_tokens: MAX_OUTPUT_TOKENS,
  };
  const gateway = options.gateway === false ? undefined : { gateway: { id: AI_GATEWAY_ID, metadata: { app: "movies" } } };
  const ai = env.AI as unknown as { run(model: string, input: unknown, options?: unknown): Promise<unknown> };
  const raw = await timer.step("llm", () => ai.run(model, input, gateway));
  return { ...fromOpenAIResponse(raw), timings: timer.steps(), serverTiming: timer.header() };
}
