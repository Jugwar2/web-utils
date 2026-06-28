/**
 * Hayase Nyaa Extension
 *
 * DO WHAT THE FUCK YOU WANT TO PUBLIC LICENSE
 * Version 2, December 2004
 */

/**
 * @typedef {import("./types")} HayaseExtensionTypes
 * @typedef {HayaseExtensionTypes.AnimeQuery} AnimeQuery
 * @typedef {HayaseExtensionTypes.TorrentResult} TorrentResult
 */

class Nyaa {
    #base = "https://nyaa.si/?page=rss&q=";
    #delayMs = 300;

    /**
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
            const target = Number(episode);
            const next = nextAiringEpisode.episode;
            if (target >= next) {
                const secs = nextAiringEpisode.timeUntilAiring ?? 0;
                if (secs > 3600) {
                    console.log(`[Nyaa] Ep ${target} hasn't aired yet. Skipping.`);
                    return [];
                }
            }
        }

        const allTitles = (titles ?? []).map((t) => t.trim()).filter(Boolean);
        const synonyms = (media?.synonyms ?? []).map((s) => s.trim()).filter(Boolean);
        const fetchFn = query.fetch || globalThis.fetch;

        // --- Extract core names from all titles ---
        const coreNames = this.#extractCoreNames(allTitles, synonyms);
        console.log(`[Nyaa] Core names: ${JSON.stringify(coreNames)}`);

        // --- Step 1: Get English title from AniList (best effort, don't depend on it) ---
        const anilistId = query.anilistId || media?.id;
        const englishTitle = await this.#fetchEnglishTitle(anilistId, fetchFn);
        if (englishTitle) {
            const engCore = this.#extractCoreNames([englishTitle], [])[0];
            if (engCore && !coreNames.includes(engCore)) coreNames.push(engCore);
        }
        console.log(`[Nyaa] Final core names: ${JSON.stringify(coreNames)}`);

        // --- Step 2: Run primary search (romaji titles + episode) ---
        const primaryResults = await this.#searchPrimary(allTitles, synonyms, episode, fetchFn);
        console.log(`[Nyaa] Primary results: ${primaryResults.length}`);

        // --- Step 3: Run dual audio search (core names + "Dual Audio", no episode) ---
        const dualResults = await this.#searchDualAudio(coreNames, episode, fetchFn);
        console.log(`[Nyaa] Dual audio results: ${dualResults.length}`);

        // --- Step 4: Merge, dedupe, sort ---
        const all = [...primaryResults, ...dualResults];
        return this.#mergeAndSort(all, episode);
    }

    async batch(query, options) {
        return this.single(query, options);
    }

    async test() {
        const res = await fetch(this.#base + "one%20piece", { method: "HEAD" });
        return res.ok;
    }

    // =========================================================================
    // CORE NAME EXTRACTION
    // =========================================================================

    /**
     * Extract short, searchable core names from titles.
     * "Sousou no Frieren 2nd Season" → "Sousou no Frieren"
     * "Jujutsu Kaisen: Shimetsu Kaiyuu - Zenpen" → "Jujutsu Kaisen"
     * "Re:Zero kara Hajimeru Isekai Seikatsu 4th Season" → "Re:Zero"
     */
    #extractCoreNames(titles, synonyms) {
        const names = [];
        const all = [...titles, ...synonyms];

        for (const raw of all) {
            if (!raw || raw.length < 2) continue;

            let name = raw
                .replace(/\[.*?\]/g, "")       // remove brackets
                .replace(/\(.*?\)/g, "")       // remove parens
                .replace(/[:\-–—].*$/, "")     // remove everything after colon/dash
                .replace(/\b\d+(st|nd|rd|th)?\s+(season|cour|part|split).*/i, "") // remove "2nd Season..."
                .replace(/\bseason\s*\d+.*/i, "") // remove "Season 02..."
                .replace(/\bs\d+\b.*$/i, "")   // remove "S02..."
                .replace(/\bTV anime\b/i, "")
                .trim();

            // Also try first 2-3 significant words
            const words = name.split(/\s+/).filter((w) => w.length > 1);
            if (words.length >= 3) {
                const short = words.slice(0, 3).join(" ");
                if (!names.includes(short)) names.push(short);
            }

            if (name.length >= 2 && !names.includes(name)) {
                names.push(name);
            }
        }

        // Deduplicate by lowercase
        const seen = new Set();
        return names.filter((n) => {
            const k = n.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }

    // =========================================================================
    // PRIMARY SEARCH — romaji titles with episode number
    // =========================================================================

    async #searchPrimary(allTitles, synonyms, episode, fetchFn) {
        const searchTitles = [];
        if (allTitles[0]) searchTitles.push(allTitles[0]);
        if (synonyms[0] && !searchTitles.includes(synonyms[0])) searchTitles.push(synonyms[0]);
        const remaining = [...allTitles.slice(1), ...synonyms.slice(1)].filter(
            (t) => t && !searchTitles.includes(t),
        );
        if (remaining.length > 0) {
            const shuffled = remaining.sort(() => Math.random() - 0.5);
            searchTitles.push(...shuffled.slice(0, 3));
        }

        for (let i = 0; i < searchTitles.length; i++) {
            const title = searchTitles[i];
            if (!title) continue;
            try {
                const results = await this.#search(title, episode, fetchFn);
                if (results.length > 0) return results;
            } catch (ex) {
                console.error(`[Nyaa] Primary search error "${title}":`, ex.message);
            }
            if (i < searchTitles.length - 1) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
            }
        }
        return [];
    }

    // =========================================================================
    // DUAL AUDIO SEARCH — core names + "Dual Audio", NO episode in query
    // =========================================================================

    async #searchDualAudio(coreNames, episode, fetchFn) {
        if (!coreNames.length) return [];

        const results = [];

        // Try up to 3 core names
        for (let i = 0; i < Math.min(coreNames.length, 3); i++) {
            const name = coreNames[i];
            const queries = [
                `${name} Dual Audio`,
                `${name} DUAL`,
            ];

            for (const q of queries) {
                await new Promise((r) => setTimeout(r, this.#delayMs));
                try {
                    const raw = await this.#search(q, null, fetchFn);
                    if (raw.length > 0) {
                        const filtered = this.#filterDualAudio(raw, coreNames, episode);
                        results.push(...filtered);
                        if (filtered.length > 0) break; // got results for this name
                    }
                } catch (ex) {
                    console.error(`[Nyaa] Dual audio search error "${q}":`, ex.message);
                }
            }

            if (results.length > 0) break; // got results, stop trying other names
        }

        return results;
    }

    /**
     * Filter dual audio results by name match + episode match.
     * Uses loose matching — core name must appear somewhere in the title.
     */
    #filterDualAudio(items, coreNames, episode) {
        const epPadded = episode != null ? String(episode).padStart(2, "0") : null;

        return items.filter((item) => {
            const t = item.title.toLowerCase();

            // Must be dual audio
            if (!this.#isDualAudio(item.title)) return false;

            // Must match at least one core name (loose: just contains it)
            const nameMatch = coreNames.some((n) => t.includes(n.toLowerCase()));
            if (!nameMatch) return false;

            // Episode filter (if specified)
            if (epPadded) {
                // Match S02E05, E05, or Season 02/S02 for batches
                const epRegex = new RegExp(
                    `(?:S\\d+E${epPadded}|\\bE${epPadded}\\b|Season\\s+\\d+|\\bS\\d+\\b)`,
                    "i"
                );
                if (!epRegex.test(item.title)) return false;
            }

            return true;
        });
    }

    // =========================================================================
    // CORE SEARCH — nyaa.si RSS
    // =========================================================================

    /**
     * @param {string} title
     * @param {string|number|null} episode
     * @param {typeof fetch} fetchFn
     * @returns {Promise<TorrentResult[]>}
     */
    async #search(title, episode, fetchFn) {
        let q = title.replace(/[^\w\s-]/g, " ").trim();
        if (episode) q += ` ${episode.toString().padStart(2, "0")}`;

        const url = this.#base + encodeURIComponent(q);
        console.log(`[Nyaa] → ${q}`);
        const res = await fetchFn(url);
        const xml = await res.text();

        /** @type {TorrentResult[]} */
        const results = [];
        const itemRegex = /<item>[\s\S]*?<\/item>/gi;
        let match;

        while ((match = itemRegex.exec(xml)) !== null) {
            const item = match[0];

            const getTag = (tag) => {
                const m = item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
                return m ? m[1].trim() : "";
            };
            const getNyaa = (tag) => {
                const m = item.match(new RegExp(`<nyaa:${tag}>([\\s\\S]*?)</nyaa:${tag}>`, "i"));
                return m ? m[1].trim() : null;
            };

            const titleVal = getTag("title");
            const hash = getNyaa("infoHash") || "";
            if (!hash) continue;

            const magnet = `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=${encodeURIComponent(titleVal)}`;
            const size = this.#parseSize(getNyaa("size") || "");
            const isTrusted = getNyaa("trusted") === "Yes";
            const isRemake = getNyaa("remake") === "Yes";
            const lowerTitle = titleVal.toLowerCase();
            const categoryId = getNyaa("categoryId") || "";
            const seeders = parseInt(getNyaa("seeders")) || 0;

            let type = "alt";
            if (isRemake) {
                type = "alt";
            } else if (isTrusted && seeders >= 5) {
                type = "best";
            } else if (
                lowerTitle.includes("batch") ||
                lowerTitle.includes("complete") ||
                lowerTitle.includes("season") ||
                /\b(s\d{2}|full season)\b/i.test(lowerTitle) ||
                /s\d{2}e?0[1-9]/i.test(lowerTitle) ||
                (categoryId.startsWith("1_") &&
                    !lowerTitle.includes("480p") &&
                    !lowerTitle.includes("720p"))
            ) {
                type = "batch";
            } else if (
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

            results.push({
                title: titleVal,
                link: magnet,
                hash,
                seeders,
                leechers: parseInt(getNyaa("leechers")) || 0,
                downloads: parseInt(getNyaa("downloads")) || 0,
                size,
                date: getTag("pubDate") ? new Date(getTag("pubDate")) : new Date(),
                accuracy: "medium",
                type,
                dualAudio: this.#isDualAudio(titleVal),
            });
        }

        return results;
    }

    // =========================================================================
    // ANILIST (best effort)
    // =========================================================================

    async #fetchEnglishTitle(anilistId, fetchFn) {
        if (!anilistId) return "";
        try {
            const gql = `query ($id: Int) { Media(id: $id, type: ANIME) { title { english } } }`;
            const res = await fetchFn("https://graphql.anilist.co", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: gql, variables: { id: anilistId } }),
            });
            if (!res.ok) return "";
            const data = await res.json();
            return data?.data?.Media?.title?.english || "";
        } catch {
            return "";
        }
    }

    // =========================================================================
    // DUAL AUDIO DETECTION
    // =========================================================================

    #isDualAudio(title) {
        return (
            /\bdual[\s-]*audio\b/i.test(title) ||
            /\bdual\b/i.test(title) ||
            /\bmulti[\s-]*(?:audio|aac|ddp|flac)\b/i.test(title) ||
            /\bjpn?\s*\+?\s*eng\b/i.test(title) ||
            /\bjapanese\s*\+?\s*english\b/i.test(title)
        );
    }

    // =========================================================================
    // SCORING & SORTING
    // =========================================================================

    #mergeAndSort(results, episode) {
        const seen = new Map();

        for (const item of results) {
            const existing = seen.get(item.hash);
            if (!existing || this.#score(item, episode) > this.#score(existing, episode)) {
                seen.set(item.hash, item);
            }
        }

        const deduped = Array.from(seen.values());
        const dual = deduped.filter((r) => r.dualAudio);
        const nonDual = deduped.filter((r) => !r.dualAudio);

        dual.sort((a, b) => this.#score(b, episode) - this.#score(a, episode));
        nonDual.sort((a, b) => this.#score(b, episode) - this.#score(a, episode));

        return [...dual, ...nonDual];
    }

    #score(item, episode) {
        let s = item.seeders * 10;

        if (item.type === "best") s += 1000;
        else if (item.type === "batch") s += 500;

        if (item.seeders > 50) s += 300;
        if (item.seeders > 20) s += 100;

        // Dual audio: massive boost
        if (item.dualAudio) s += 10000;

        return s;
    }

    #parseSize(sizeStr) {
        if (!sizeStr) return 0;
        const m = sizeStr.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/i);
        if (!m) return 0;
        const num = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        const mult = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
        return Math.round(num * mult[unit]);
    }
}

export default new Nyaa();
