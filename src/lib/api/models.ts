/**
 * What the commands two core settings name answer with: a language model (`CFG_LANGUAGE_MODEL`)
 * and a text embedder (`CFG_TEXT_EMBEDDER`). Core runs neither; a module that needs one runs the
 * command the setting names, and the module that has one sets it.
 */

/**
 * `<command> [--system <text>] [--history <json>] [--max-tokens <n>] [--timeout <s>] <message>`:
 * the model's reply. `--history` is the earlier turns, `[{ role: 'user' | 'assistant', content }]`.
 */
export type LanguageModelReply = { content: string; model?: string };

/**
 * `<command> [--role query|document] [--timeout <s>] <text>...`: a vector per text, in order, and
 * the model that made them — two models' vectors are not comparable. `<command> --model` answers
 * the model alone, with no vectors.
 */
export type TextEmbedding = { model: string; vectors: number[][] };
