/**
 * Hayase Nyaa Extension
 *
 * DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
 * Version 2, December 2004
 *
 * Everyone is permitted to copy and distribute verbatim or modified
 * copies of this software, and changing it is allowed as long as the
 * name is changed.
 */

/**
 * @typedef {import("./types")} HayaseExtensionTypes
 * @typedef {HayaseExtensionTypes.AnimeQuery} AnimeQuery
 * @typedef {HayaseExtensionTypes.TorrentResult} TorrentResult
 */

class Nyaa {
    // Direct nyaa.si RSS endpoint (official public REST API)
    #base = "https://nyaa.si/?page=rss&q=";
    // Be gentle with nyaa.si (avoid rate limits)
    #delayMs = 400;

    /**
     * Used for single episode searches
     * @param {AnimeQuery} query
     * @param {Record<string, string | number | boolean>?} options
     * @returns {Promise<TorrentResult[]>}
     */
    async single(query, options) {
        const { titles, media, episode } = query;
        const nextAiringEpisode = media?.nextAiringEpisode;
        if (
            episode != null &&
            nextAiringEpisode?.timeUntilAiring != null &&
            nextAiringEpisode?.episode != null
        ) {
            const targetEpisode = Number(episode);
            const nextEpisode = nextAiringEpisode.episode;

            // If the requested episode is the next one or earlier
            if (targetEpisode >= nextEpisode) {
                const timeUntilAiringSeconds =
                    nextAiringEpisode.timeUntilAiring ?? 0;

                // Add 1 hour leeway (3600 seconds)
                if (timeUntilAiringSeconds > 3600) {
                    console.log(
                        `[Nyaa] Episode ${targetEpisode} has not aired yet (airs in ~${Math.floor(timeUntilAiringSeconds / 3600)}h). Skipping search.`,
                    );
                    return [];
                }
            }
        }

        const allTitles = (titles ?? []).map((t) => t.trim()).filter(Boolean);
        const synonyms = (media?.synonyms ?? [])
            .map((s) => s.trim())
            .filter(Boolean);

        // Always include: titles[0] + synonyms[0] + up to 3 random others
        let primaryTitles = [];

        // 1. First title
        if (allTitles[0]) primaryTitles.push(allTitles[0]);

        // 2. First synonym (if exists and different from first title)
        if (synonyms[0]) {
            const syn = synonyms[0];
            if (!primaryTitles.includes(syn)) {
                primaryTitles.push(syn);
            }
        }

        // 3. Up to 3 random from the rest
        const remaining = [...allTitles.slice(1), ...synonyms.slice(1)].filter(
            (t) => t && !primaryTitles.includes(t),
        );

        if (remaining.length > 0) {
            const shuffled = remaining.sort(() => Math.random() - 0.5);
            primaryTitles.push(...shuffled.slice(0, 3));
        }

        console.log(
            `[Nyaa] Primary search with ${primaryTitles.length} titles`,
        );

        if (!primaryTitles.length) return [];

        let allResults = [];

        for (let i = 0; i < primaryTitles.length; i++) {
            const title = primaryTitles[i];
            if (!title) continue;

            try {
                const results = await this.#search(title, episode, options);
                if (results.length > 0) {
                    allResults = results; // Found something → return early
                    break;
                }
            } catch (ex) {
                console.error(
                    `[Nyaa] Error searching "${title}" (episode: ${episode || "none"}):`,
                    err.message,
                );
            }

            if (i < primaryTitles.length - 1) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
            }
        }

        // If we already found results return them
        if (allResults.length > 0) {
            return this.#deduplicateAndSort(allResults);
        }

        // Only if nothing found, try up to 5 random others. Occasionally, needed for some anime titles.
        console.log(
            `[Nyaa] No results from primary titles. Trying fallback...`,
        );

        const fallbackCandidates = [
            ...allTitles.slice(1),
            ...synonyms.slice(1),
        ].filter((t) => t && !primaryTitles.includes(t));

        // Shuffle and take up to 5 (at cost of latency...)
        const shuffled = fallbackCandidates.sort(() => Math.random() - 0.5);
        const fallbackTitles = shuffled.slice(0, 5);

        for (let i = 0; i < fallbackTitles.length; i++) {
            const title = fallbackTitles[i];
            try {
                const results = await this.#search(title, episode, options);
                if (results.length > 0) {
                    allResults.push(...results);
                }
            } catch (err) {
                console.error(
                    `[Nyaa] Fallback search failed for "${title}":`,
                    err.message,
                );
            }

            if (i < fallbackTitles.length - 1) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
            }
        }

        return this.#deduplicateAndSort(allResults);
    }

    /**
     * Used for batch searches
     * @param {AnimeQuery} query
     * @param {Record<string, string | number | boolean>?} options
     * @returns {Promise<TorrentResult[]>}
     */
    async batch(query, options) {
        // From the docs:
        // However, if the extension doesn't differentiate between these types of searches,
        // it can just implement one of them and return results for all types of queries,
        // or return no results for the types of queries it doesn't support
        return this.single(query, options);
    }

    async test() {
        const res = await fetch(this.#base + "one%20piece", { method: "HEAD" });
        return res.ok;
    }

    /**
     * @param {string} title
     * @param {string|number|null} [episode]
     * @returns {Promise<TorrentResult[]>}
     */
    async #search(title, episode) {
        let query = title.replace(/[^\w\s-]/g, " ").trim();
        if (episode) query += ` ${episode.toString().padStart(2, "0")}`;

        const url = this.#base + encodeURIComponent(query);

        const res = await fetch(url);
        const xmlText = await res.text();

        // Pure vanilla RSS parser
        /** @type {TorrentResult[]} */
        const results = [];
        const itemRegex = /<item>[\s\S]*?<\/item>/gi;
        let itemMatch;

        while ((itemMatch = itemRegex.exec(xmlText)) !== null) {
            const itemXml = itemMatch[0];

            const getTag = (tag) => {
                const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
                const match = itemXml.match(regex);
                return match ? match[1].trim() : "";
            };

            const getNyaa = (tag) => {
                const regex = new RegExp(
                    `<nyaa:${tag}>([\\s\\S]*?)</nyaa:${tag}>`,
                    "i",
                );
                const match = itemXml.match(regex);
                return match ? match[1].trim() : null;
            };

            const titleVal = getTag("title");
            const hash = getNyaa("infoHash") || "";
            if (!hash) continue;

            const magnet = hash
                ? `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=${encodeURIComponent(titleVal)}`
                : "";

            const size = this.#parseSize(getNyaa("size") || "");

            // Type detection
            const isTrusted = getNyaa("trusted") === "Yes";
            const isRemake = getNyaa("remake") === "Yes";
            const lowerTitle = titleVal.toLowerCase();
            const categoryId = getNyaa("categoryId") || "";
            const seeders = parseInt(getNyaa("seeders")) || 0;

            let type = "alt";

            // Detect dual audio
            const isDualAudio =
                /\[.*dual.*audio.*\]/i.test(titleVal) ||
                /\(.*dual.*audio/i.test(titleVal) ||
                /\bdual\b/i.test(titleVal) ||
                /\bmulti\b.*(?:audio|aac|ddp|flac)/i.test(titleVal) ||
                /jpn?\+eng/i.test(titleVal) ||
                /japanese\s*\+?\s*english/i.test(titleVal);

            // 1. Remakes are almost always lowest priority
            if (isRemake) {
                type = "alt";
            }
            // 2. Trusted uploader + high seeds → "best"
            else if (isTrusted && seeders >= 5) {
                type = "best";
            }
            // 3. Batch / Complete season detection
            else if (
                lowerTitle.includes("batch") ||
                lowerTitle.includes("complete") ||
                lowerTitle.includes("season") ||
                /\b(s\d{2}|full season)\b/i.test(lowerTitle) ||
                /s\d{2}e?0[1-9]/i.test(lowerTitle) || // S01-S12 style batches
                (categoryId.startsWith("1_") &&
                    lowerTitle.includes("480p") === false &&
                    lowerTitle.includes("720p") === false)
            ) {
                type = "batch";
            }
            // 4. High quality single episodes / best encodes
            else if (
                isTrusted ||
                lowerTitle.includes("1080p") ||
                lowerTitle.includes("2160p") ||
                lowerTitle.includes("bluray") ||
                lowerTitle.includes("remux") ||
                lowerTitle.includes("x265") ||
                lowerTitle.includes("hevc")
            ) {
                type = "best";
            }
            // 5. Everything else stays "alt"
            else {
                type = "alt";
            }

            results.push({
                title: titleVal,
                link: magnet,
                hash: hash,
                seeders,
                leechers: parseInt(getNyaa("leechers")) || 0,
                downloads: parseInt(getNyaa("downloads")) || 0,
                size,
                date: getTag("pubDate")
                    ? new Date(getTag("pubDate"))
                    : new Date(),
                accuracy: "medium",
                type,
                dualAudio: isDualAudio,
            });
        }

        return results;
    }

    #parseSize(sizeStr) {
        if (!sizeStr) return 0;
        const match = sizeStr.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/i);
        if (!match) return 0;

        const num = parseFloat(match[1]);
        const unit = match[2].toUpperCase();

        const multipliers = {
            B: 1,
            KIB: 1024,
            MIB: 1024 ** 2,
            GIB: 1024 ** 3,
            TIB: 1024 ** 4,
        };

        return Math.round(num * multipliers[unit]);
    }

    /**
     * @param {TorrentResult[]} results
     * @returns {TorrentResult[]}
     */
    #deduplicateAndSort(results) {
        const seen = new Map();

        for (const item of results) {
            if (
                !seen.has(item.hash) ||
                this.#isBetter(item, seen.get(item.hash))
            ) {
                seen.set(item.hash, item);
            }
        }

        return Array.from(seen.values()).sort((a, b) =>
            this.#compareQuality(a, b),
        );
    }

    /**
     * @param {TorrentResult} a
     * @param {TorrentResult} b
     * @returns {boolean}
     */
    #isBetter(a, b) {
        const scoreA = this.#qualityScore(a);
        const scoreB = this.#qualityScore(b);
        return scoreA > scoreB;
    }

    /**
     * @param {TorrentResult} item
     * @returns {number}
     */
    #qualityScore(item) {
        let score = item.seeders * 10;

        if (item.type === "best") score += 1000;
        else if (item.type === "batch") score += 500;

        if (item.seeders > 50) score += 300;
        if (item.seeders > 20) score += 100;

        // Boost dual audio torrents
        if (
            /\[.*dual.*audio.*\]/i.test(item.title) ||
            /\(.*dual.*audio/i.test(item.title) ||
            /\bdual\b/i.test(item.title) ||
            /\bmulti\b.*(?:audio|aac|ddp|flac)/i.test(item.title) ||
            /jpn?\+eng/i.test(item.title) ||
            /japanese\s*\+?\s*english/i.test(item.title)
        ) {
            score += 200;
        }

        return score;
    }

    /**
     * @param {TorrentResult} a
     * @param {TorrentResult} b
     * @returns {number}
     */
    #compareQuality(a, b) {
        return this.#qualityScore(b) - this.#qualityScore(a);
    }
}

export default new Nyaa();