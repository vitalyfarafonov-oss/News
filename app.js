// =============================================
// NEWS PWA — Configuration & App Logic
// =============================================

const CONFIG = {
    CACHE_DURATION_MS: 60 * 60 * 1000, // 1 hour
    AUTO_REFRESH_MS: 60 * 60 * 1000,   // 1 hour
    // Primary: feed2json.org (free, no key, CORS-friendly, JSON Feed format)
    RSS_PROXY_PRIMARY: 'https://feed2json.org/convert?url=',
    // Fallback: rss2json.com (works for some feeds where feed2json fails)
    RSS_PROXY_FALLBACK: 'https://api.rss2json.com/v1/api.json?rss_url=',
    MAX_ITEMS_PER_FEED: 10,
    TRANSLATE_ENDPOINT: 'https://translate.googleapis.com/translate_a/single',
};

// RSS Feed sources — easy to add/remove
// lang: 'ru' = already Russian, no translation needed
// lang: 'cs' or 'en' = will be auto-translated to Russian
const FEEDS = {
    world: [
        { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World', lang: 'en' },
        { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera', lang: 'en' },
        { url: 'https://rss.dw.com/rdf/rss-en-all', name: 'DW', lang: 'en' },
    ],
    czech: [
        { url: 'https://ruski.radio.cz/rcz-rss/ru', name: 'Radio Prague RU', lang: 'ru' },
        { url: 'https://www.novinky.cz/rss', name: 'Novinky.cz', lang: 'cs' },
        { url: 'https://servis.idnes.cz/rss.aspx?c=zpravodaj', name: 'iDNES.cz', lang: 'cs' },
        { url: 'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-domov', name: 'iROZHLAS', lang: 'cs' },
    ],
    vaping: [
        { url: 'https://www.vapingpost.com/feed/', name: 'Vaping Post', lang: 'en' },
        { url: 'https://www.vapingpost.com/category/europe/feed/', name: 'Vaping Post EU', lang: 'en' },
        { url: 'https://ethra.co/news?format=feed&type=rss', name: 'ETHRA', lang: 'en' },
        { url: 'https://tobaccoreporter.com/feed/', name: 'Tobacco Reporter', lang: 'en' },
        { url: 'https://tobaccoinsider.com/feed/', name: 'Tobacco Insider', lang: 'en' },
    ],
    logistics: [
        { url: 'https://theloadstar.com/feed/', name: 'The Loadstar', lang: 'en' },
        { url: 'https://www.ti-insight.com/feed/', name: 'Transport Intelligence', lang: 'en' },
        { url: 'https://www.supplychaindive.com/feeds/news/', name: 'Supply Chain Dive', lang: 'en' },
        { url: 'https://www.container-news.com/feed/', name: 'Container News', lang: 'en' },
    ],
    czechbiz: [
        { url: 'https://www.e15.cz/rss', name: 'E15.cz', lang: 'cs' },
        { url: 'https://www.aktualne.cz/rss/ekonomika/', name: 'Aktualne.cz', lang: 'cs' },
        { url: 'https://www.czechcrunch.cz/feed/', name: 'CzechCrunch', lang: 'cs' },
    ],
    estonia: [
        { url: 'https://rus.err.ee/rss', name: 'ERR RUS', lang: 'ru' },
        { url: 'https://rus.postimees.ee/rss', name: 'Postimees RUS', lang: 'ru' },
        { url: 'https://www.err.ee/rss', name: 'ERR.ee', lang: 'et' },
    ],
};

// =============================================
// Translation (Google Translate — free unofficial API)
// =============================================

const translationCache = new Map();

async function translateText(text, fromLang) {
    if (!text || fromLang === 'ru') return text;

    const cacheKey = `${fromLang}:${text.slice(0, 100)}`;
    if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

    try {
        const params = new URLSearchParams({
            client: 'gtx',
            sl: fromLang,
            tl: 'ru',
            dt: 't',
            q: text,
        });
        const resp = await fetch(`${CONFIG.TRANSLATE_ENDPOINT}?${params}`);
        if (!resp.ok) return text;

        const data = await resp.json();
        // Response format: [[["translated","original",...],...]
        const translated = data[0].map(part => part[0]).join('');
        translationCache.set(cacheKey, translated);
        return translated;
    } catch {
        return text; // Fallback to original on error
    }
}

async function translateItem(item, fromLang) {
    if (fromLang === 'ru') return item;

    const [title, description] = await Promise.all([
        translateText(item.title, fromLang),
        item.description ? translateText(item.description, fromLang) : Promise.resolve(''),
    ]);

    return { ...item, title, description, originalTitle: item.title };
}

// =============================================
// Cache helpers (localStorage)
// =============================================

function getCachedData(section) {
    try {
        const raw = localStorage.getItem(`news_${section}`);
        if (!raw) return null;
        const data = JSON.parse(raw);
        const age = Date.now() - data.timestamp;
        if (age > CONFIG.CACHE_DURATION_MS) return null;
        return data;
    } catch {
        return null;
    }
}

function setCachedData(section, items) {
    try {
        localStorage.setItem(`news_${section}`, JSON.stringify({
            timestamp: Date.now(),
            items,
        }));
    } catch {
        // localStorage full or unavailable — silently ignore
    }
}

// =============================================
// RSS Fetching
// =============================================

// Parse feed2json.org response (JSON Feed format)
function parseFeed2JsonResponse(data) {
    if (!data.items || !Array.isArray(data.items)) return null;
    return data.items.map(item => ({
        title: item.title || '',
        description: item.summary || item.content_html || '',
        link: item.url || '#',
        pubDate: item.date_published || '',
    }));
}

// Parse rss2json.com response
function parseRss2JsonResponse(data) {
    if (data.status !== 'ok' || !data.items) return null;
    return data.items.map(item => ({
        title: item.title || '',
        description: item.description || '',
        link: item.link || '#',
        pubDate: item.pubDate || '',
    }));
}

async function fetchFeed(feedConfig) {
    // Try primary proxy (feed2json.org) first, then fallback (rss2json.com)
    const proxies = [
        { url: CONFIG.RSS_PROXY_PRIMARY + encodeURIComponent(feedConfig.url), parser: parseFeed2JsonResponse },
        { url: CONFIG.RSS_PROXY_FALLBACK + encodeURIComponent(feedConfig.url), parser: parseRss2JsonResponse },
    ];

    for (const proxy of proxies) {
        try {
            const resp = await fetch(proxy.url);
            if (!resp.ok) continue;
            const data = await resp.json();
            const parsed = proxy.parser(data);
            if (!parsed || parsed.length === 0) continue;

            const rawItems = parsed.slice(0, CONFIG.MAX_ITEMS_PER_FEED).map(item => ({
                title: stripHtml(item.title),
                description: stripHtml(item.description).slice(0, 300),
                link: item.link,
                pubDate: item.pubDate,
                source: feedConfig.name,
                lang: feedConfig.lang,
            }));

            // Translate if needed
            if (feedConfig.lang !== 'ru') {
                const translated = await Promise.all(
                    rawItems.map(item => translateItem(item, feedConfig.lang))
                );
                return translated;
            }

            return rawItems;
        } catch (err) {
            console.warn(`Proxy failed for ${feedConfig.name}:`, err.message);
            continue;
        }
    }

    console.warn(`All proxies failed for ${feedConfig.name}`);
    return [];
}

async function fetchSection(section) {
    const feeds = FEEDS[section] || [];
    const results = await Promise.allSettled(feeds.map(f => fetchFeed(f)));
    const allItems = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);

    // Sort by date descending
    allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    return allItems;
}

// =============================================
// Rendering
// =============================================

function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) return 'только что';
    if (diffMin < 60) return `${diffMin} мин назад`;
    if (diffHr < 24) return `${diffHr} ч назад`;
    if (diffDay < 7) return `${diffDay} дн назад`;
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function renderSkeletons(container) {
    let html = '';
    for (let i = 0; i < 4; i++) {
        html += `
        <div class="skeleton-card">
            <div class="skeleton skeleton-badge"></div>
            <div class="skeleton skeleton-title"></div>
            <div class="skeleton skeleton-title-2"></div>
            <div class="skeleton skeleton-desc"></div>
            <div class="skeleton skeleton-desc-2"></div>
            <div class="skeleton skeleton-meta"></div>
        </div>`;
    }
    container.innerHTML = html;
}

const SECTION_ICONS = {
    world: '🌍', czech: '🇨🇿', vaping: '💨',
    logistics: '🚛', czechbiz: '💼', estonia: '🇪🇪',
};

function renderItems(container, items, section) {
    if (!items || items.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">${SECTION_ICONS[section] || '📰'}</div>
                <p>Нет новостей для отображения.<br>Попробуйте обновить позже.</p>
            </div>`;
        return;
    }

    container.innerHTML = items.map(item => {
        const isTranslated = item.lang && item.lang !== 'ru';
        const translatedTag = isTranslated ? `<span class="translated-tag">перевод</span>` : '';

        return `
        <article class="news-card" data-section="${section}">
            <a href="${escapeAttr(item.link)}" target="_blank" rel="noopener noreferrer">
                <div class="card-header">
                    <span class="source-badge">${escapeHtml(item.source)}</span>
                    ${translatedTag}
                </div>
                <div class="title">${escapeHtml(item.title)}</div>
                ${item.description ? `<div class="description">${escapeHtml(item.description)}</div>` : ''}
                <div class="meta">
                    <span>${timeAgo(item.pubDate)}</span>
                    ${item.originalTitle ? `<span class="original-hint" title="${escapeAttr(item.originalTitle)}">📄 оригинал</span>` : ''}
                </div>
            </a>
        </article>`;
    }).join('');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateTimestamp() {
    const el = document.getElementById('last-updated');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// =============================================
// Main App Logic
// =============================================

const ALL_SECTIONS = ['world', 'czech', 'vaping', 'logistics', 'czechbiz', 'estonia'];
let currentTab = 'world';
let isRefreshing = false;

async function loadSection(section, forceRefresh = false) {
    const container = document.getElementById(section);
    if (!container) return;

    // Try cache first
    if (!forceRefresh) {
        const cached = getCachedData(section);
        if (cached) {
            renderItems(container, cached.items, section);
            return;
        }
    }

    // Show loading skeleton
    renderSkeletons(container);

    try {
        const items = await fetchSection(section);
        setCachedData(section, items);
        renderItems(container, items, section);
    } catch (err) {
        console.error(`Error loading ${section}:`, err);
        // Try to show stale cache if available
        try {
            const raw = localStorage.getItem(`news_${section}`);
            if (raw) {
                const data = JSON.parse(raw);
                renderItems(container, data.items, section);
                return;
            }
        } catch {}
        container.innerHTML = `<div class="error-msg">Ошибка загрузки. Проверьте подключение к интернету.</div>`;
    }
}

async function refreshAll() {
    if (isRefreshing) return;
    isRefreshing = true;

    const btn = document.getElementById('refresh-btn');
    if (btn) btn.classList.add('spinning');

    await Promise.all(ALL_SECTIONS.map(s => loadSection(s, true)));

    updateTimestamp();
    isRefreshing = false;
    if (btn) btn.classList.remove('spinning');
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    document.querySelectorAll('.feed').forEach(f => {
        f.classList.toggle('active', f.id === tab);
    });
}

// =============================================
// Initialization
// =============================================

document.addEventListener('DOMContentLoaded', () => {
    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Refresh button
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', refreshAll);
    }

    // Initial load — all sections
    ALL_SECTIONS.forEach(s => loadSection(s));
    updateTimestamp();

    // Auto-refresh every hour
    setInterval(() => {
        refreshAll();
    }, CONFIG.AUTO_REFRESH_MS);

    // Also refresh when app becomes visible (e.g. user switches back to it)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // Check if cache is stale
            const anyStale = ALL_SECTIONS.some(s => !getCachedData(s));
            if (anyStale) {
                refreshAll();
            }
        }
    });

    // Register Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.warn('SW registration failed:', err);
        });
    }
});
