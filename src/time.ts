import { escapeMarkdown } from './helpers';
import { formatInTimeZone, utcToZonedTime } from 'date-fns-tz';
import * as chrono from 'chrono-node';
import { differenceInCalendarDays } from 'date-fns';
import { ParsedResult } from 'chrono-node';

export function processDate(locale: string, message: string, tz: string): ParsedResult[] {
    return chrono[locale].parse(message, {
        timezone: tz,
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
        let isSameDay =
            differenceInCalendarDays(now, utcToZonedTime(date, city[2])) === 0;

        console.log(JSON.stringify(utcToZonedTime(now, city[2])));

        console.log(`${city[1]} -- ${isSameDay}`);

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
