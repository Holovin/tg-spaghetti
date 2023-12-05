import { format } from 'date-fns';


export function getShopLink(date: Date): string {
    // example: https://seebot.dev/images/archive/brshop/1_Nov_2023.png
    return `https://seebot.dev/images/archive/brshop/${format(date, 'd_MMM_yyyy')}.png`;
}
