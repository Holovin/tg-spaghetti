import { Api, Bot, Context, InputFile, NextFunction, RawApi, session, SessionFlavor } from 'grammy';
import nconf from 'nconf';
import OpenAI from 'openai';
import axios from 'axios';
import { draw, random } from 'radash';
import i18next from 'i18next';
import Backend, { FsBackendOptions } from 'i18next-fs-backend';
import { utcToZonedTime } from 'date-fns-tz';
import { format } from 'date-fns';

import { processAiMsg, requestAi } from './gpt';
import { escapeMarkdown, wrapToQuote } from './helpers';
import { convertFixerData, CurrencyData, detectCurrency, getCurrencyData, prepareMessage } from './currency';
import { getTimesEscaped, processDateBest } from './time';
import { createLoggerWrap } from './logger';
import { getShopLink } from './fortik';

i18next
    .use(Backend)
    .init<FsBackendOptions>({
        lng: 'en',
        backend: {
            loadPath: 'local.{{lng}}.json',
        }
    }).then(r => {});

export const SERVER_TZ = 'Europe/Berlin';
const SPAM_WAIT_MS = 1000;

const config = nconf.env().file({ file: 'config.json' });
const logger = createLoggerWrap();

const configChatId = +config.get('telegram:chat');
const adminId = +config.get('telegram:admin');
const telegramToken = config.get('telegram:token');
const aiToken = config.get('openai:token');
const fixerToken = config.get('fixer:token');
const telegramUsersConfig = config.get('telegram:users');

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
async function setLoop(trigger: string, payload: string, bot: Bot<SessionContext, Api<RawApi>>, ctx: SessionContext, chatId: number, image: string = '') {
    logger.info(`[${trigger}] up_id = ${ctx.update.update_id}, from = ${chatId}, payload = ${payload}`);

    ctx.session.isBusy = true;
    bot.api.sendChatAction(chatId, 'typing').then(() => {})
    ctx.react('👍').then(() => {});

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
        ctx.react('👎').then(() => {});
        clearTimeout(watchId);
        return;
    }

    requestAi(openai, payload, image).then(aiMsg => {
        const msg = processAiMsg(aiMsg);
        clearLoop(ctx, id);

        if (msg) {
            let fullMsg = wrapToQuote(escapeMarkdown(msg));
            if (image) {
                let price = 0;
                if (aiMsg.usage?.input) {
                    price += 0.000005 * aiMsg.usage?.input;
                }

                if (aiMsg.usage?.output) {
                    price += 0.000015 * aiMsg.usage?.output;
                }

                fullMsg += escapeMarkdown(`\n \nTokens: ${aiMsg.usage?.total} ~ \$${price.toFixed(5)}`);
            }

            const replyId = ctx.message!.message_id;
            logger.info(`[${trigger}] up_id = ${ctx.update.update_id}, msg = ${msg}`);
            bot.api.sendMessage(ctx.message!.chat!.id, fullMsg, {
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
        let image = '';
        if (ctx.message?.reply_to_message?.text) {
            ask += ctx.message!.reply_to_message!.text;
        }

        if (ctx.message?.reply_to_message?.caption) {
            ask += ' ' + ctx.message!.reply_to_message!.caption;
        }

        if (typeof ctx.match === 'string') {
            ask = `${ctx.match} ${ask}`;
        }

        if (ctx.message?.reply_to_message?.photo) {
            const photo = ctx.message.reply_to_message.photo;
            logger.info(`[ask] photo = ${JSON.stringify(photo)}`);

            const photoId = photo.reduce((max, file) => (file.file_size ?? 0) > (max.file_size ?? 0) ? file : max, photo[0]).file_id;
            logger.info(`[ask] photoId = ${photoId}`);

            const fileId = await ctx.api.getFile(photoId);
            logger.info(`[ask] fileId = ${JSON.stringify(fileId)}`);

            const fileResponse = await fetch(`https://api.telegram.org/file/bot${telegramToken}/${(fileId as any).file_path}`);
            const buffer = await fileResponse.arrayBuffer();
            image = `data:image/jpg;base64,${Buffer.from(buffer).toString('base64')}`;
        }

        if (!ask.trim()) {
            return;
        }

        await setLoop('ask', ask, bot, ctx, ctx.message!.chat!.id!, image);
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
        if (throttella(ctx, 'vermishel', SPAM_WAIT_MS)) {
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

        await countella(ctx, 'vermishel', 20);
    });

    bot.command('now', async (ctx: SessionContext) => {
        if (throttella(ctx, 'now', SPAM_WAIT_MS)) {
            return;
        }

        const out = getTimesEscaped(new Date(), '*⌛ Current time *\n');
        await ctx.reply(out, { parse_mode: 'MarkdownV2' });
    });

    bot.command('time', async (ctx: SessionContext) => {
        if (throttella(ctx, 'time', SPAM_WAIT_MS)) {
            return;
        }

        const userName = ctx.message?.from.username;
        const message = ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption || ctx.match;
        if (!message || !userName || typeof message !== 'string') {
            return;
        }

        const bestOut = processDateBest(message, telegramUsersConfig[userName]?.tz ?? SERVER_TZ);
        if (!bestOut) {
            return;
        }

        let bestOutText = '' + bestOut!.text.charAt(0).toUpperCase() + bestOut!.text.slice(1);
        let bestOutDate = bestOut!.date();

        if (telegramUsersConfig[userName]) {
            bestOutText += ` 🪄`;
        }

        const parsedTime = `*⌛ ${escapeMarkdown(bestOutText)} *\n`;
        await ctx.reply(getTimesEscaped(bestOutDate, parsedTime), { parse_mode: 'MarkdownV2' });
    });

    bot.command(['currency', 'q'], async (ctx: SessionContext) => {
        if (throttella(ctx, 'currency', SPAM_WAIT_MS)) {
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

    bot.command('shop', async (ctx: SessionContext) => {
        if (throttella(ctx, 'shop', SPAM_WAIT_MS * 10)) {
            return;
        }

        const message = ctx.match;
        let date = new Date();
        if (typeof message === 'string') {
            const result = processDateBest(message, SERVER_TZ);
            if (result) {
                date = result.date();
            }
        }

        const fortikDate = utcToZonedTime(date, 'Etc/UTC');
        const url = getShopLink(fortikDate);
        const file = await axios.get(url, { responseType: 'arraybuffer' });
        const fileInput = new InputFile(file.data, `${url}---${random(0, 99999)}`);

        await ctx.replyWithPhoto(fileInput, {
            caption: `*Fortik\\) shop:* ${escapeMarkdown(format(fortikDate, 'HH:mm, d MMM yyyy'))}`,
            parse_mode: 'MarkdownV2',
        });
    });

    bot.catch((error) => {
        const message =
            `🧨 *${escapeMarkdown(error.message)}*\n` +
            '```' + escapeMarkdown(error.stack + '') + '```'
        ;

        console.log(JSON.stringify(error));

        bot.api.sendMessage(adminId, message, { parse_mode: 'MarkdownV2' });
    });
}

async function main() {
    await initBot(bot);
    bot.start( { drop_pending_updates: true }).then();
}

try {
    main().then(() => {});

} catch (e: unknown) {
    logger.info(JSON.stringify(e as any));

    if (e instanceof Error) {
        logger.error(`GGWP: ${e.message}`);
    }
}
