import { Api, Bot, Context, NextFunction, RawApi, session, SessionFlavor } from 'grammy';
import nconf from 'nconf';
import { createLoggerWrap } from './logger';
import OpenAI from 'openai';
import { processAiMsg, requestAi } from './gpt';
import { escapeMarkdown } from './helpers';
import { convertFixerData, CurrencyData, detectCurrency, getCurrencyData, prepareMessage } from './currency';
import { getTimesEscaped, processDate } from './time';
import { capitalize, draw, max, random } from 'radash';
import i18next from 'i18next';
import Backend, { FsBackendOptions } from 'i18next-fs-backend';
import { ParsedResult } from 'chrono-node';

i18next
    .use(Backend)
    .init<FsBackendOptions>({
        lng: 'en',
        backend: {
            loadPath: 'local.{{lng}}.json',
        }
    });

const config = nconf.env().file({ file: 'config.json' });
const logger = createLoggerWrap();

const configChatId = +config.get('telegram:chat');
const adminId = +config.get('telegram:admin');
const telegramToken = config.get('telegram:token');
const aiToken = config.get('openai:token');
const fixerToken = config.get('fixer:token');


const openai = new OpenAI({ apiKey: aiToken });

interface SessionData {
    isBusy: boolean;
    timerId: number;
    currencyData: CurrencyData;
    throttleMap: { [key: string]: number };
    counters: { [key: string]: number };
}

type SessionContext = Context & SessionFlavor<SessionData>;

const bot = new Bot<SessionContext>(telegramToken);

logger.info(`== SQD SPGHT config ==` +
    `\nStarted, settings:\n` +
    `- chatId: ${configChatId}\n` +
    `- adminId: ${adminId}\n`,
);

// MIDDLEWARES //
async function checkAccess(ctx: SessionContext, next: NextFunction): Promise<void> {
    const chatId = ctx?.message?.chat?.id;
    if (!chatId || (chatId !== configChatId && chatId !== adminId)) {
        logger.debug(`mid: skip message from --  ${ctx.update.update_id} -- ${chatId}`);
        bot.api.sendMessage(adminId, escapeMarkdown(`Access warning! From ${chatId}, dump: ${JSON.stringify(ctx.update)}`), { parse_mode: 'MarkdownV2'}).then(() => {});
        return;
    }

    await next();
}

async function checkBusy(ctx: SessionContext, next: NextFunction): Promise<void> {
    const chatId = ctx?.message?.chat?.id;
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

function throttella(ctx: SessionContext, key: string, limitMs: number): boolean {
    const now = Date.now();
    if (!ctx.session.throttleMap[key]) {
        ctx.session.throttleMap[key] = now;
        return false;
    }

    if (now - ctx.session.throttleMap[key] < limitMs) {
        logger.debug(`skip -- ${key}`);
        ctx.session.throttleMap[key] = now; // update too for prevent spamming
        return true;
    }

    ctx.session.throttleMap[key] = now;
    return false;
}

async function countella(ctx: SessionContext, key: string, threshold: number): Promise<void> {
    if (!ctx.session.counters[key]) {
        ctx.session.counters[key] = 0;
    }

    ctx.session.counters[key] += random(0, 3);
    if (ctx.session.counters[key] < threshold) {
        logger.debug(`skip sending alert -- ${key} -- ${ctx.session.counters[key]} of ${threshold}`);
        return;
    }

    ctx.session.counters[key] = 0;
    const variants = i18next.t('alerts', { returnObjects: true }) as string[];

    logger.debug(`alert possible -- ${key}`);
    await ctx.reply(escapeMarkdown(draw(variants) ?? ''), { parse_mode: 'MarkdownV2' });
}

// QUEUE //
async function setLoop(trigger: string, payload: string, bot: Bot<SessionContext, Api<RawApi>>, ctx: SessionContext, chatId: number) {
    logger.info(`[${trigger}] up_id = ${ctx.update.update_id}, from = ${chatId}, payload = ${payload}`);

    ctx.session.isBusy = true;
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

        if (msg) {
            const replyId = ctx.message!.message_id;
            logger.info(`[${trigger}] up_id = ${ctx.update.update_id}, msg = ${msg}`);
            bot.api.sendMessage(ctx.message!.chat!.id, escapeMarkdown(msg), {
                parse_mode: 'MarkdownV2',
                reply_to_message_id: replyId,
            }).then(() => {});
        } else {
            logger.warn(`[${trigger}] up_id = ${ctx.update.update_id}, no msg`);
        }

        clearTimeout(watchId);

    }).catch(e => {
        logger.warn(`[${trigger}] up_id = ${ctx.update.update_id}, e = ${JSON.stringify(e)}`);
        const replyId = ctx.message!.message_id;
        bot.api.sendMessage(ctx.message!.chat!.id, escapeMarkdown(`Неизвестная ошибка up_id = ${ctx.update.update_id}`), {
            parse_mode: 'MarkdownV2',
            reply_to_message_id: replyId,
        }).then(() => {});

        clearLoop(ctx, id);
        clearTimeout(watchId);
    });
}

function clearLoop(ctx: SessionContext, id: NodeJS.Timeout) {
    ctx.session.isBusy = false;
    clearInterval(id);
    logger.info(`[clearLoop] done`);
}

// BOT //
async function initBot(bot: Bot<SessionContext>) {
    bot.use(
        session({
            initial(): SessionData {
                return {
                    isBusy: false,
                    timerId: -1,
                    currencyData: {
                        lastUpdate: 0,
                        data: {},
                        isStable: false,
                    },
                    throttleMap: {},
                    counters: {},
                }
            }}
        )
    );

    bot.use(checkAccess);
    bot.use(checkBusy);

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

        await setLoop('ask', ask, bot, ctx, ctx.message!.chat!.id!);
    });

    bot.command('nepon', skipNonReplies, async (ctx: SessionContext) => {
        await setLoop(
            'nepon',
            i18next.t('prompt.nepon')
                + `${ctx.message!.reply_to_message!.text || ctx.message!.reply_to_message!.caption}`,
            bot,
            ctx,
            ctx.message!.chat!.id!,
        );
    });

    bot.command('nepon_mini', skipNonReplies, async (ctx: SessionContext) => {
        await setLoop(
            'nepon_mini',
            i18next.t('prompt.nepon_mini')
            + `${ctx.message!.reply_to_message!.text || ctx.message!.reply_to_message!.caption}`,
            bot,
            ctx,
            ctx.message!.chat!.id!,
        );
    });

    bot.command('summ', skipNonReplies, async (ctx: SessionContext) => {
        await setLoop(
            'summarize',
            i18next.t('prompt.summ')
            + `${ctx.message!.reply_to_message!.text || ctx.message!.reply_to_message!.caption}`,
            bot,
            ctx,
            ctx.message!.chat!.id!,
        );
    });

    bot.command('vermishel', async (ctx: SessionContext) => {
        if (throttella(ctx, 'vermishel', 3000)) {
            return;
        }

        const result = Math.random();
        if (result > 0.991) {
            logger.info(`[vermishel] trigger = ${result}`);
            await ctx.reply(escapeMarkdown(`${i18next.t('vermishel')} (${result})`), {
                parse_mode: 'MarkdownV2',
                reply_to_message_id: ctx.message?.message_id,
            });
            return;
        }

        await countella(ctx, 'vermishel', 5);
    });

    bot.command('now', async (ctx: SessionContext) => {
        if (throttella(ctx, 'now', 3000)) {
            return;
        }

        const out = getTimesEscaped(new Date(), '*⌛ Current time *\n');
        await ctx.reply(out, { parse_mode: 'MarkdownV2' });
    });

    bot.command('time', async (ctx: SessionContext) => {
        if (throttella(ctx, 'time', 3000)) {
            return;
        }

        const message = ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption || ctx.match;
        if (!message || typeof message !== 'string') {
            return;
        }

        let out: ParsedResult[] = [];
        for (const locale of ['ru', 'uk', 'en']) {
            const result = processDate(locale, message);
            if (result.length > 0) {
                out.push(result[0]);
            }
        }

        if (!out.length) {
            return;
        }

        const bestOut = max(out, result => {
            return Object.keys(result.start['knownValues']).length;
        });

        const parsedTime = `*⌛ ${escapeMarkdown(capitalize(bestOut!.text))} *\n`;
        await ctx.reply(getTimesEscaped(bestOut!.date(), parsedTime), { parse_mode: 'MarkdownV2' });
    });

    bot.command(['currency', 'q'], async (ctx: SessionContext) => {
        if (throttella(ctx, 'currency', 1000)) {
            return;
        }

        const message = ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption || ctx.match;
        if (!message || typeof message !== 'string') {
            return;
        }

        const result = detectCurrency(message);
        if (!result.currency) {
            return;
        }

        // Update currency exchange rates
        const diffMax = 1000 * 60 * 60 * 6; // = 6 hours
        if (Date.now() - ctx.session.currencyData.lastUpdate > diffMax) {
            ctx.session.currencyData = convertFixerData(await getCurrencyData(fixerToken));
            logger.info('Currency data updated');
        }

        const out = prepareMessage(ctx.session.currencyData, result);
        await ctx.reply(out, { parse_mode: 'MarkdownV2' });
    });

    bot.catch((error) => {
        const message =
            `🧨 *${escapeMarkdown(error.message)}*\n` +
            '```' + escapeMarkdown(error.stack + '') + '```'
        ;

        bot.api.sendMessage(adminId, message, { parse_mode: 'MarkdownV2' });
    });
}

async function main() {
    await initBot(bot);
    bot
        .start( { drop_pending_updates: true })
        .then(() => { logger.warn('HOW?') });
}

try {
    main().then(() => {});

} catch (e: unknown) {
    logger.info(JSON.stringify(e as any));

    if (e instanceof Error) {
        logger.error(`GGWP: ${e.message}`);
    }
}
