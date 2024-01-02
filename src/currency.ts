import axios from 'axios';
import { escapeMarkdown } from './helpers';

export interface FixerResponse {
    success: boolean;
    timestamp: number;
    base: string;
    date: string;
    rates: {
        [key: string]: number
    };
}

interface CurrencyResult {
    currency: string;
    value: number;
}

const currenciesGroups = [
    ['USD', 'EUR'],
    ['RUB', 'GEL', 'UAH'],
    ['RSD', 'TRY'],
]

const currenciesMap = {
    'USD': {
        triggers: ['USD', '\\$', 'доллар'],
        symbol: '$',
        dropLimit: 10,
    },
    'EUR': {
        triggers: ['EUR', '€', 'евро'],
        symbol: '€',
        dropLimit: 10,
    },

    'UAH': {
        triggers: ['UAH', '₴', 'грн', 'гривен'],
        symbol: '₴',
        dropLimit: 400,
    },
    'GEL': {
        triggers: ['GEL', '₾', 'лари'],
        symbol: '₾',
        dropLimit: 30,
    },
    'RSD': {
        triggers: ['RSD', 'динар'],
        symbol: 'Д',
        dropLimit: 500,
    },
    'RUB': {
        triggers: ['RUB', '₽', 'рубл'],
        symbol: '₽',
        dropLimit: 500,
    },
    'TRY': {
        triggers: ['TRY', '₺', 'лир'],
        symbol: '₺',
        dropLimit: 300,
    },
};

export interface CurrencyData {
    isStable: boolean;
    lastUpdate: number,
    data: {
        [key: string]: number
    },
}

export async function getCurrencyData(token: string): Promise<FixerResponse | null> {
    const result = await axios.get(`http://data.fixer.io/api/latest?access_key=${token}`);
    if (!result.data || result.status !== 200) {
        return null;
    }

    return result.data;
}

export function detectCurrency(message: string): CurrencyResult {
    for (const [currencyCode, currencyObj] of Object.entries(currenciesMap)) {
        const regexp = new RegExp(`(\\d+([.,]\\d+)?).*(${currencyObj.triggers.join('|')})`, 'mi');
        const match = message.match(regexp);

        if (match && match.length > 1) {
            return {
                value: Number.parseFloat(match[1].replaceAll(',', '.')),
                currency: currencyCode,
            }
        }
    }

    return {
        currency: '',
        value: 0,
    }
}

export function convertFixerData(data: FixerResponse | null): CurrencyData {
    if (!data || !data.success) {
        return {
            isStable: false,
            lastUpdate: Date.now(),
            data: {},
        }
    }

    return {
        isStable: data.success,
        lastUpdate: Date.now(),
        data: data.rates
    }
}

interface RateResult {
    currency: string;
    result: string;
}

export function prepareMessage(currencyData: CurrencyData, result: CurrencyResult): string {
    let out = `💵 *${escapeMarkdown(result.value.toString())} ${result.currency} *\n\n`;
    let outRates: RateResult[] = [];
    let maxLength = result.value.toString().length + result.currency.length + 2;

    for (const currencyGroup of currenciesGroups) {
        for (const currency of currencyGroup) {
            if (currency === result.currency) {
                continue;
            }

            const selfRate = currencyData.data[result.currency];
            const exchangeRate = currencyData.data[currency];
            if (!selfRate || !exchangeRate) {
                continue;
            }

            const exchangeValue = result.value / selfRate * exchangeRate;
            const exchangeValueRounded = exchangeValue > currenciesMap[currency].dropLimit
                ? Math.round(exchangeValue)
                : Math.round((exchangeValue + Number.EPSILON) * 10) / 10;

            const val =
                exchangeValueRounded === 0 ? exchangeValue.toFixed(2) : exchangeValueRounded.toString();

            outRates.push({
                currency: currenciesMap[currency].symbol,
                result: val,
            })

            if (val.length > maxLength) {
                maxLength = val.length;
            }
        }
    }

    out += outRates
        .map(rate => `\`${rate.currency} ${escapeMarkdown(rate.result.padStart(maxLength, ' '))}\``)
        .join('\n');

    return out;
}
