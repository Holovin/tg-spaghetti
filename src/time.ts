import { escapeMarkdown } from './helpers';
import { formatInTimeZone } from 'date-fns-tz';
import * as chrono from 'chrono-node';
import { differenceInCalendarDays } from 'date-fns';

export function processDate(message: string): Date {
    return chrono.parseDate(message);
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
        let isSameDay = differenceInCalendarDays(now, date) === 0;

        out.push(
            `${city[0]}` +
            ` ${escapeMarkdown(formatInTimeZone(date, city[2], isSameDay ? 'HH:mm' : 'dd MMM HH:mm'))}` +
            ` *${escapeMarkdown(city[1])}*` +
            ` ${escapeMarkdown(formatInTimeZone(date, city[2], 'x'))} `
        )

    }

    out.push(`🤖 ${Math.floor(Date.now() / 1000)} *TS*`);
    return out.join('\n');
}
