import * as chrono from 'chrono-node';
import { ParsedResult } from 'chrono-node';
import { differenceInCalendarDays } from 'date-fns';
import { max } from 'radash';
import { formatInTimeZone, utcToZonedTime } from 'date-fns-tz';
import { escapeMarkdown } from './helpers';


export function processDate(locale: string, message: string, tz: string): ParsedResult[] {
    return chrono[locale].parse(message, {
        timezone: tz,
    });
}

export function processDateBest(message: string, inputTz: string) {
    let out: ParsedResult[] = [];
    for (const locale of ['ru', 'uk', 'en']) {
        const result = processDate(locale, message, inputTz);
        if (result.length > 0) {
            out.push(result[0]);
        }
    }

    if (!out.length) {
        return null;
    }

    return max(out, result => {
        return Object.keys(result.start['knownValues']).length;
    });
}

export function getTimesEscaped(date: Date, header = ''): string {
    const cityMap = [
        ['🇩🇪', 'Berlin', 'Europe/Berlin'],
        ['🇷🇸', 'Belgrade', 'Europe/Belgrade'],
        ['🇺🇦', 'Kyiv', 'Europe/Kyiv'],
        ['🇧🇾', 'Minsk', 'Europe/Minsk'],
        ['🇷🇺', 'Moscow', 'Europe/Moscow'],
        ['🇬🇪', 'Tbilisi', 'Asia/Tbilisi'],
    ];

    const out: string[] = header ? [header] : [];
    const now = new Date();

    for (const city of cityMap) {
        let isSameDay = differenceInCalendarDays(now, utcToZonedTime(date, city[2])) === 0;

        out.push(
            `${city[0]}` +
            ` ${escapeMarkdown(formatInTimeZone(date, city[2], isSameDay ? 'HH:mm' : 'HH:mm (dd MMM)'))}` +
            ` *${escapeMarkdown(city[1])}*` +
            ` ${escapeMarkdown(formatInTimeZone(date, city[2], 'x'))} `
        )

    }

    out.push(`🤖 ${Math.floor(Date.now() / 1000)} *TS*`);
    return out.join('\n');
}
