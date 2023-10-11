import { Api, Bot, Context, NextFunction, RawApi, session, SessionFlavor } from 'grammy';
import nconf from 'nconf';
import { createLoggerWrap } from './logger';
import OpenAI from 'openai';
import { requestAi, SPGTResponse } from './gpt';
import { escapeMarkdown } from './helpers';

const config = nconf.env().file({ file: 'config.json' });
const logger = createLoggerWrap();

const configChatId = +config.get('telegram:chat');
const adminId = +config.get('telegram:admin');
const telegramToken = config.get('telegram:token');
const aiToken = config.get('openai:token');

const openai = new OpenAI({ apiKey: aiToken });

interface SessionData {
    isBusy: boolean;
}

type SessionContext = Context & SessionFlavor<SessionData>;

const bot = new Bot<SessionContext>(telegramToken);

logger.info(`== SQD SPGHT config ==` +
    `\nStarted, settings:\n` +
    `- chatId: ${configChatId}\n` +
    `- adminId: ${adminId}\n`,
);

function processAiMsg(aiMsg: SPGTResponse): string {
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

    // if (aiMsg.usage?.total) {
    //     extra += ` (${aiMsg.usage?.total})`
    // }

    const text = aiMsg.result.message.length > 3500
        ? `${aiMsg.result.message.substring(0, 3500)}...🔪`
        : aiMsg.result.message;

    return `${extra} ${text}`;
}

async function check(ctx: SessionContext, next: NextFunction): Promise<void> {
    const chatId = ctx?.message?.chat?.id;
    if (!chatId || (chatId !== configChatId && chatId !== adminId)) {
        logger.debug(`mid: skip message from -- ${chatId}`);
        return;
    }

    if (ctx?.session?.isBusy) {
        logger.debug(`mid: busy for message from -- ${chatId}`);
        return;
    }

    await next();
}

async function initBot(bot: Bot<SessionContext, Api<RawApi>>) {
    bot.use(
        session({
            initial(): SessionData {
                return { isBusy: false }
            }}
        )
    );

    bot.use(check);

    // COMMANDS //
    bot.command('ask', async (ctx: SessionContext) => {
        const chatId = ctx?.message?.chat?.id;
        if (typeof ctx.match !== 'string' || !chatId) {
            return;
        }

        await bot.api.sendChatAction(chatId, 'typing');

        ctx.session.isBusy = true;
        const aiMsg = await requestAi(openai, ctx.message?.reply_to_message?.text ? ctx.message.reply_to_message.text : ctx.match);
        ctx.session.isBusy = false;

        const msg = processAiMsg(aiMsg);

        await ctx.reply(escapeMarkdown(msg), {
            parse_mode: 'MarkdownV2',
            reply_to_message_id: ctx.message?.message_id,
        });
    });

    bot.command('explain', async (ctx: SessionContext) => {
        const chatId = ctx?.message?.chat?.id;
        if (typeof ctx.match !== 'string' || !chatId) {
            return;
        }

        // Not reply or empty text
        if (!ctx.message?.reply_to_message || !ctx.message.reply_to_message.text) {
            logger.debug(`${ctx.update} :: skip message`);
            return;
        }

        await bot.api.sendChatAction(chatId, 'typing');
        ctx.session.isBusy = true;
        const aiMsg = await requestAi(openai, `объясни этот текст: ${ctx.message.reply_to_message.text}`);
        ctx.session.isBusy = false;
        const msg = processAiMsg(aiMsg);

        await ctx.reply(escapeMarkdown(msg), {
            parse_mode: 'MarkdownV2',
            reply_to_message_id: ctx.message?.message_id,
        });
    });

    bot.command('summarize', async (ctx: SessionContext) => {
        const chatId = ctx?.message?.chat?.id;
        if (typeof ctx.match !== 'string' || !chatId) {
            return;
        }

        // Not reply or empty text
        if (!ctx.message?.reply_to_message || !ctx.message.reply_to_message.text) {
            logger.debug(`${ctx.update} :: skip message`);
            return;
        }

        await bot.api.sendChatAction(chatId, 'typing');
        ctx.session.isBusy = true;
        const aiMsg = await requestAi(openai, `суммаризируй этот текст вкратце: ${ctx.message.reply_to_message.text}`);
        ctx.session.isBusy = false;
        const msg = processAiMsg(aiMsg);

        await ctx.reply(escapeMarkdown(msg), {
            parse_mode: 'MarkdownV2',
            reply_to_message_id: ctx.message?.message_id,
        });
    });

    bot.command('vermishel', async (ctx: SessionContext) => {
        if (Math.random() > 0.99) {
            await ctx.reply(escapeMarkdown('Ладно, в этот раз поем.'), {
                parse_mode: 'MarkdownV2',
                reply_to_message_id: ctx.message?.message_id,
            });
        }
    });
}

async function main() {
    await initBot(bot);
    bot.start().then(() => { logger.warn('HOW?') });
}

try {
    main().then(() => {});

} catch (e: unknown) {
    logger.info(JSON.stringify(e as any));

    if (e instanceof Error) {
        logger.error(`GGWP: ${e.message}`);
    }
}
