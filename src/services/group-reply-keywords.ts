export const MAX_GROUP_REPLY_KEYWORDS = 32;
export const MAX_GROUP_REPLY_KEYWORD_LENGTH = 80;

const normalize = (text: string) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const valid = (text: string) => text.length > 0 && text.length <= MAX_GROUP_REPLY_KEYWORD_LENGTH && /[\p{L}\p{N}]/u.test(text);

/** Invalid file entries are ignored without broadening the selected reply mode. */
export function normalizeGroupReplyKeywords(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((entry): entry is string => typeof entry === 'string')
        .map(normalize).filter(valid))].slice(0, MAX_GROUP_REPLY_KEYWORDS);
}

/** The editor is stricter than file loading: never silently discard an operator's input. */
export function parseGroupReplyKeywordsInput(input: string): string[] {
    const entries = [...new Set(input.split(/\r?\n/).map(normalize).filter(Boolean))];
    if (entries.length > MAX_GROUP_REPLY_KEYWORDS || entries.some(entry => !valid(entry))) {
        throw new Error('Enter up to 32 words or phrases, at most 80 characters each, containing a letter or number.');
    }
    return entries;
}

export class GroupReplyKeywordMatcher {
    private readonly keywords: string[];
    private readonly patterns: RegExp[];

    constructor(value: unknown = []) {
        this.keywords = normalizeGroupReplyKeywords(value);
        this.patterns = this.keywords.map(keyword => {
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Unicode word boundaries: combining marks and underscores belong to words too.
            return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}\\p{Pc}])${escaped}(?![\\p{L}\\p{M}\\p{N}\\p{Pc}])`, 'iu');
        });
    }

    getKeywords(): string[] { return [...this.keywords]; }

    matches(text: string): boolean {
        if (!this.patterns.length || text.length > 65536) return false;
        const normalized = normalize(text);
        return this.patterns.some(pattern => pattern.test(normalized));
    }
}
