import { APIError } from 'openai/error';
import OpenAI from 'openai';

export interface SPGTResponse {
    success: boolean;
    usage?: {
        input: number;
        output: number;
        total: number;
    }
    result?: {
        message: string;
        reason: string;
    }
}

export async function requestAi(openai: OpenAI, content: string): Promise<SPGTResponse> {
    try {
        const chatCompletion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: content },
            ],
            model: 'gpt-4',
            max_tokens: 2000,
        });

        return {
            success: true,
            usage: {
                total: chatCompletion.usage?.total_tokens ?? -1,
                input: chatCompletion.usage?.prompt_tokens ?? -1,
                output: chatCompletion.usage?.completion_tokens ?? -1,
            },
            result: {
                reason: chatCompletion.choices[0]?.finish_reason,
                message: chatCompletion.choices[0]?.message.content ?? '',
            }
        }

    } catch (e: unknown) {
        if (e instanceof APIError) {
            return {
                success: false,
                result: {
                    reason: 'OpenAI Error',
                    message: e.message,
                },
            }
        } else if (e instanceof Error) {
            return {
                success: false,
                result: {
                    reason: 'AppError',
                    message: e.message,
                },
            }
        }
    }

    return { success: false }
}

export function processAiMsg(aiMsg: SPGTResponse): string {
    if (!aiMsg.success) {
        return `💥 [${aiMsg.result?.reason}] ${aiMsg.result?.message ?? 'No error text'}`;
    }

    if (!aiMsg.result) {
        return `💥 No response from AI`;
    }

    let extra = '';
    if (aiMsg.result.reason === 'content_filter') {
        extra += '🔞';
    } else if (aiMsg.result.reason === 'function_call') {
        extra += '🤡';
    } else if (aiMsg.result.reason === 'length') {
        extra += '✂️';
    } else if (aiMsg.result.reason === 'stop') {
        // extra += '🤖';
    } else {
        extra += aiMsg.result.reason ?? '?';
    }

    const text = aiMsg.result.message.length > 3500
        ? `${aiMsg.result.message.substring(0, 3500)}...🔪`
        : aiMsg.result.message;

    return `${extra} ${text}`;
}
