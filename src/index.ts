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
    timerId: number;
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
        logger.debug(`mid: skip message from --  ${ctx.update.update_id} -- ${chatId}`);
        return;
    }

    // logger.warn(JSON.stringify(ctx.session));
    if (ctx?.session?.isBusy) {
        logger.debug(`mid: busy for message from --  ${ctx.update.update_id} -- ${chatId}`);
        return;
    }

    await next();
}

async function skipNonReplies(ctx: SessionContext, next: NextFunction): Promise<void> {
    const chatId = ctx?.message?.chat?.id;
    if (!ctx.message?.reply_to_message || (!ctx.message.reply_to_message.text?.trim() && !ctx.message.reply_to_message.caption?.trim())) {
        logger.debug(`mid: skip no reply -- ${ctx.update.update_id} -- ${chatId}`);
        return;
    }

    await next();
}

async function setLoop(trigger: string, payload: string, bot: Bot<SessionContext, Api<RawApi>>, ctx: SessionContext, chatId: number) {
    logger.info(`[${trigger}] up_id = ${ctx.update.update_id}, from = ${chatId}, payload = ${payload}`);

    ctx.session.isBusy = true;
    // logger.warn(JSON.stringify(ctx.session));

    await bot.api.sendChatAction(chatId, 'typing');

    const id = setInterval(() => {
        bot.api.sendChatAction(chatId, 'typing').then(() => {});
    }, 5000);

    const watchId = setTimeout(() => {
        clearInterval(id);
        logger.info(`[setLoop] Last chance fix done`);
    }, 5 * 60 * 1000);

    if (!payload) {
        clearLoop(ctx, id);
        logger.info(`[${trigger}] up_id = ${ctx.update.update_id}, skip no payload`);
        clearTimeout(watchId);
        return;
    }

    requestAi(openai, payload).then(aiMsg => {
        const msg = processAiMsg(aiMsg);

        clearLoop(ctx, id);
        // logger.warn(JSON.stringify(ctx.session));

        if (msg) {
            const replyId = ctx.message!.reply_to_message?.message_id || ctx.message!.message_id;
            logger.info(`[${trigger}] up_id = ${ctx.update.update_id}, msg = ${msg}`);
            bot.api.sendMessage(ctx.message!.chat!.id, escapeMarkdown(msg), {
                parse_mode: 'MarkdownV2',
                reply_to_message_id: replyId,
            }).then(() => {});
        } else {
            logger.warn(`[${trigger}] up_id = ${ctx.update.update_id}, no msg`);
        }

        clearTimeout(watchId);
    });
}

function clearLoop(ctx: SessionContext, id: NodeJS.Timeout) {
    ctx.session.isBusy = false;
    clearInterval(id);
    logger.info(`[clearLoop] done`);
}

async function initBot(bot: Bot<SessionContext, Api<RawApi>>) {
    bot.use(
        session({
            initial(): SessionData {
                return {
                    isBusy: false,
                    timerId: -1,
                }
            }}
        )
    );

    bot.use(check);

    // COMMANDS //
    bot.command('ask', async (ctx: SessionContext) => {
        let ask = '';
        if (ctx.message?.reply_to_message?.text) {
            ask += ctx.message!.reply_to_message!.text;
        }

        if (ctx.message?.reply_to_message?.caption) {
            ask += ' ' + ctx.message!.reply_to_message!.caption;
        }

        if (typeof ctx.match === 'string') {
            ask = `${ctx.match} ${ask}`;
        }

        if (!ask.trim()) {
            return;
        }

        await setLoop(
            'ask',
            ask,
            bot,
            ctx,
            ctx.message!.chat!.id!
        );
    });

    bot.command('nepon', skipNonReplies, async (ctx: SessionContext) => {
        await setLoop(
            'nepon',
            `объясни этот текст: `
                + `${ctx.message!.reply_to_message!.text || ctx.message!.reply_to_message!.caption}`,
            bot,
            ctx,
            ctx.message!.chat!.id!,
        );
    });

    bot.command('nepon_mini', skipNonReplies, async (ctx: SessionContext) => {
        await setLoop(
            'nepon_mini',
            `объясни этот текст (коротко, не больше 1 предложения): `
            + `${ctx.message!.reply_to_message!.text || ctx.message!.reply_to_message!.caption}`,
            bot,
            ctx,
            ctx.message!.chat!.id!,
        );
    });

    bot.command('summ', skipNonReplies, async (ctx: SessionContext) => {
        await setLoop(
            'summarize',
            `суммаризируй этот текст вкратце (2-3 предложения): `
            + `${ctx.message!.reply_to_message!.text || ctx.message!.reply_to_message!.caption}`,
            bot,
            ctx,
            ctx.message!.chat!.id!,
        );
    });

    bot.command('vermishel', async (ctx: SessionContext) => {
        const result = Math.random();

        if (result > 0.995) {
            await ctx.reply(escapeMarkdown(`Ладно, в этот раз поем (${result})`), {
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
