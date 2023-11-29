import { escapeMarkdown } from './helpers';
import { formatInTimeZone } from 'date-fns-tz';

export function getTimes(): string {
    const date = new Date();
    const cityMap = [
        ['🇩🇪', 'Berlin', 'Europe/Berlin'],
        ['🇷🇸', 'Belgrade', 'Europe/Belgrade'],
        ['🇺🇦', 'Kyiv', 'Europe/Kyiv'],
        ['🇧🇾', 'Minsk', 'Europe/Minsk'],
        ['🇷🇺', 'Moscow', 'Europe/Moscow'],
        ['🇬🇪', 'Tbilisi', 'Asia/Tbilisi'],
        ['🍏', 'Pacific Time', 'America/Los_Angeles'],
    ];

    return cityMap
        .map(cityArr => (
            `${cityArr[0]}` +
            ` ${escapeMarkdown(formatInTimeZone(date, cityArr[2], 'HH:mm'))}` +
            ` *${escapeMarkdown(cityArr[1])}*` +
            ` ${escapeMarkdown(formatInTimeZone(date, cityArr[2], 'x'))} `
        ))
        .join('\n');
}
